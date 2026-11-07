'use strict'
/*
 * Electron shell for the Roku Sync desktop app.
 *
 * All behaviour lives in `controller.cjs`; this file only owns the window and
 * the IPC bridge, so the same logic runs under `desktop/server.cjs` in a plain
 * browser when Electron is not installed yet.
 */

const path = require('node:path')
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron')
const { DesktopController } = require('./controller.cjs')

let controller = null
let window = null
const recentLog = []

function broadcast() {
  if (window && !window.isDestroyed()) {
    window.webContents.send('state:update', controller.snapshot())
  }
}

function attach(instance) {
  instance.on('state', broadcast)
  instance.on('log', (entry) => {
    recentLog.push(entry)
    if (recentLog.length > 200) recentLog.shift()
    if (window && !window.isDestroyed()) window.webContents.send('log:line', entry)
  })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 940,
    minHeight: 700,
    backgroundColor: '#0b0f16',
    title: 'Roku Sync',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.loadFile(path.join(__dirname, 'index.html'))
  window.on('closed', () => { window = null })

  // The device poll is what makes plugging the soundcard in show up here, so it
  // runs only while the window is open.
  window.on('show', () => {
    controller.startDevicePolling()
    controller.refreshDevices().catch(() => {})
  })
  window.on('hide', () => controller.stopDevicePolling())
  window.on('closed', () => controller.stopDevicePolling())
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => fn(...args))

  handle('state:snapshot', () => controller.snapshot())
  handle('config:save', (patch) => {
    controller.saveConfig(patch || {})
    controller.refreshDevices().catch(() => {})
    return controller.snapshot()
  })
  handle('devices:refresh', () => controller.refreshDevices().then(() => controller.snapshot()))
  handle('anc:start', () => {
    const result = controller.startAnc()
    return Object.assign({ snapshot: controller.snapshot() }, result)
  })
  handle('anc:stop', async () => {
    await controller.stopAnc()
    return controller.snapshot()
  })
  handle('anc:selftest', async () => {
    await controller.runSelfTest()
    return controller.snapshot()
  })
  handle('bridge:start', () => {
    const result = controller.startRokuBridge()
    return Object.assign({ snapshot: controller.snapshot() }, result)
  })
  handle('bridge:stop', async () => {
    await controller.stopRokuBridge()
    return controller.snapshot()
  })
  handle('logs:recent', () => recentLog.slice(-60))
  handle('roku:scan', async () => {
    await controller.scanRokuDevices()
    return controller.snapshot()
  })
  handle('ping:run', async (options) => {
    await controller.pingServer(options || {})
    return controller.snapshot()
  })
  handle('clipboard:write', (text) => {
    clipboard.writeText(String(text || ''))
    return true
  })
  handle('open:external', (url) => {
    const target = String(url || '')
    if (/^https?:\/\//i.test(target)) return shell.openExternal(target)
    return false
  })
}

app.whenReady().then(() => {
  controller = new DesktopController({ rootDir: path.join(__dirname, '..') })
  attach(controller)
  registerIpc()
  // Discovery and the ping tester run on startup so the window opens with data.
  controller.scanRokuDevices().catch(() => {})

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // `ROKU_SYNC_DESKTOP_SMOKE=1` boots the real window, waits for the renderer to
  // finish loading and exits 0. It is how the launcher path is verified without
  // a human watching the window.
  if (process.env.ROKU_SYNC_DESKTOP_SMOKE === '1') {
    const deadline = setTimeout(() => {
      console.error('desktop smoke test timed out')
      app.exit(1)
    }, 25000)
    window.webContents.once('did-finish-load', () => {
      window.webContents.executeJavaScript(
        "document.getElementById('anc-title').textContent",
      ).then((title) => {
        clearTimeout(deadline)
        if (title !== 'ANC Microphone Studio') {
          console.error('desktop smoke test saw', title)
          app.exit(1)
          return
        }
        console.log('desktop smoke test passed')
        app.exit(0)
      }).catch((error) => {
        clearTimeout(deadline)
        console.error('desktop smoke test failed:', error.message)
        app.exit(1)
      })
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (controller && (controller.anc.running || controller.bridge.running)) {
    event.preventDefault()
    await controller.dispose()
    app.quit()
  }
})
