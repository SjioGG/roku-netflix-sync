'use strict'
/*
 * Electron shell for the Roku Sync desktop app.
 *
 * All behaviour lives in `controller.cjs`; this file only owns the window and
 * the IPC bridge, so the same logic runs under `desktop/server.cjs` in a plain
 * browser when Electron is not installed yet.
 */

const path = require('node:path')
const { app, BrowserWindow, ipcMain, net, shell, clipboard } = require('electron')
app.setName('Roku Sync')
const smoke = process.env.ROKU_SYNC_DESKTOP_SMOKE === '1'
if (smoke && process.env.ROKU_SYNC_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.ROKU_SYNC_SMOKE_USER_DATA)
}
require('./runtime.cjs').configureRuntime({ packaged: app.isPackaged, userData: app.getPath('userData') })
const { DesktopController } = require('./controller.cjs')
const { createServer, DEFAULT_PORT, DEFAULT_HOST } = require('./server.cjs')

// Opening the Dock icon again should focus the existing control center.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  else if (app.isReady()) createWindow()
})

let controller = null
let localMirrorServer = null
let window = null
const recentLog = []

function nudgeMacLocalNetworkPrompt() {
  if (smoke || process.platform !== 'darwin' || !controller || !net || typeof net.fetch !== 'function') return
  try {
    const parsed = new URL(controller.getConfig().rokuUrl || 'http://192.168.1.100:8060')
    if (parsed.protocol !== 'http:') return
    if (!/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)\d/.test(parsed.hostname)) return
    net.fetch(`${parsed.origin}/query/device-info`, { signal: AbortSignal.timeout(1200) })
      .then((res) => res.arrayBuffer())
      .catch(() => {})
  } catch {
    /* ignore malformed custom URL */
  }
}

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
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('closed', () => { window = null })

  // The device poll is what makes plugging the soundcard in show up here, so it
  // runs only while the window is open.
  let scannedLanOnOpen = false
  window.on('show', () => {
    if (smoke) return
    controller.startDevicePolling()
    controller.refreshDevices().catch(() => {})
    if (!scannedLanOnOpen) {
      scannedLanOnOpen = true
      nudgeMacLocalNetworkPrompt()
      controller.scanRokuDevices().catch(() => {})
    }
  })
  window.on('hide', () => controller.stopDevicePolling())
  window.on('closed', () => controller.stopDevicePolling())
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Only the desktop window can use this API.')
    }
    return fn(...args)
  })

  handle('state:snapshot', () => controller.snapshot())
  handle('config:reveal-token', () => ({ token: controller.getConfig().token }))
  handle('config:save', (patch) => {
    controller.saveConfig(patch || {})
    controller.refreshDevices().catch(() => {})
    return controller.snapshot()
  })
  handle('devices:refresh', () => controller.refreshDevices().then(() => controller.snapshot()))
  handle('devices:rescan-all', async () => {
    nudgeMacLocalNetworkPrompt()
    return controller.rescanAll()
  })
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
  handle('anc:preview-start', (options) => {
    const result = controller.startMicPreview(options || {})
    return Object.assign({ snapshot: controller.snapshot() }, result)
  })
  handle('anc:preview-stop', async () => {
    await controller.stopMicPreview()
    return controller.snapshot()
  })
  handle('anc:preview-audio', () => controller.getMicPreviewAudio())
  handle('mirror:open-reference-chrome', () => controller.openReferenceChrome())
  handle('mirror:launch', (payload) => {
    const body = payload && typeof payload === 'object' ? payload : { url: payload }
    return controller.launchMirrorUrl(body.url, body)
  })
  handle('system:open-audio-capture', () => {
    if (process.platform !== 'darwin') return false
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      .then(() => true, () => false)
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
    nudgeMacLocalNetworkPrompt()
    await controller.scanRokuDevices()
    return controller.snapshot()
  })
  handle('system:open-local-network', () => {
    if (process.platform !== 'darwin') return false
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork')
      .then(() => true, () => false)
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
  if (!hasInstanceLock) return
  controller = new DesktopController({ rootDir: path.join(__dirname, '..') })
  attach(controller)
  registerIpc()
  if (!smoke) {
    localMirrorServer = createServer({ controller })
    localMirrorServer.listen(DEFAULT_PORT, DEFAULT_HOST).catch((err) => {
      localMirrorServer = null
      recentLog.push({ source: 'local-mirror', line: `Port ${DEFAULT_PORT} unavailable: ${err.message}` })
    })
  }

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
      ).then(async (title) => {
        if (title !== 'ANC Microphone Studio') {
          console.error('desktop smoke test saw', title)
          app.exit(1)
          return
        }
        console.log(`desktop launch: isPackaged=${app.isPackaged}`)
        const expectedPython = path.join(process.resourcesPath, 'python', 'bin', 'python3')
        if (!app.isPackaged || controller.pythonPath !== expectedPython) {
          throw new Error('Installed app did not select its bundled Python runtime')
        }
        for (const script of ['aec_daemon.py', 'roku_client.py']) {
          const result = JSON.parse(await controller._collect(script, ['--check-runtime'], 10000))
          if (!result.ok) throw new Error(`${script} runtime check failed`)
          console.log(`${script}: bundled runtime ready`)
        }
        const devices = await controller.listDevices()
        if (devices.source !== 'sounddevice') {
          throw new Error('Audio device scan did not use the bundled sounddevice backend')
        }
        console.log(`Audio device scan: ${devices.inputs.length} inputs, ${devices.outputs.length} outputs`)
        clearTimeout(deadline)
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
  if ((controller && (controller.anc.running || controller.bridge.running
      || controller.micPreview.running || controller._previewDir)) || localMirrorServer) {
    event.preventDefault()
    const instance = controller
    const srv = localMirrorServer
    controller = null
    localMirrorServer = null
    await Promise.all([
      instance ? instance.dispose() : Promise.resolve(),
      srv ? srv.close() : Promise.resolve(),
    ])
    app.quit()
  }
})
