'use strict'
/*
 * Local HTTP UI for the Roku Sync desktop app.
 *
 * Electron is a ~200 MB download, so `bin/launch-desktop.sh` falls back to this
 * stdlib-only server and opens `http://127.0.0.1:8767` in Chrome's `--app`
 * window. It serves `index.html` and the same JSON API the IPC handlers expose,
 * and `index.html` polyfills `window.rokuDesktop` over `fetch` when it finds
 * itself in a browser instead of Electron.
 */

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
if (require.main === module) require('./local-env.cjs').loadLocalEnv()
const { DesktopController } = require('./controller.cjs')

const DEFAULT_PORT = 8767
const DEFAULT_HOST = '127.0.0.1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/renderer.js': { file: 'renderer.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/controller.cjs': { file: 'controller.cjs', type: 'text/javascript; charset=utf-8' },
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1 << 20) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

/**
 * Build (but do not start) the HTTP UI.
 * Returns `{server, controller, listen, close}` so tests can drive it in-process.
 */
function createServer(options = {}) {
  const controller = options.controller || new DesktopController({
    rootDir: path.resolve(__dirname, '..'),
    configPath: options.configPath,
  })
  const webRoot = path.join(__dirname)
  const recentLog = []
  controller.on('log', (entry) => {
    recentLog.push(entry)
    if (recentLog.length > 200) recentLog.shift()
  })

  const routes = {
    'GET /api/state': () => controller.snapshot(),
    'GET /api/logs': () => recentLog.slice(-60),
    'POST /api/token/reveal': () => ({ token: controller.getConfig().token }),
    'POST /api/config': (body) => {
      controller.saveConfig(body && body.patch ? body.patch : body)
      controller.refreshDevices().catch(() => {})
      return controller.snapshot()
    },
    'POST /api/devices/refresh': async () => {
      await controller.refreshDevices()
      return controller.snapshot()
    },
    'POST /api/anc/start': () => Object.assign(controller.startAnc(),
      { snapshot: controller.snapshot() }),
    'POST /api/anc/stop': async () => {
      await controller.stopAnc()
      return controller.snapshot()
    },
    'POST /api/anc/selftest': async () => {
      await controller.runSelfTest()
      return controller.snapshot()
    },
    'POST /api/bridge/start': () => Object.assign(controller.startRokuBridge(),
      { snapshot: controller.snapshot() }),
    'POST /api/bridge/stop': async () => {
      await controller.stopRokuBridge()
      return controller.snapshot()
    },
    'POST /api/roku/scan': async () => {
      await controller.scanRokuDevices()
      return controller.snapshot()
    },
    'POST /api/ping': async (body) => {
      await controller.pingServer((body && body.options) || body || {})
      return controller.snapshot()
    },
  }

  const server = http.createServer(async (request, response) => {
    try {
      const origin = new URL(`http://${request.headers.host || ''}`)
      if (!LOOPBACK_HOSTS.has(origin.hostname) || origin.port !== String(server.address().port) || origin.username || origin.password) {
        sendJson(response, 403, { error: 'local host required' })
        return
      }
      const url = new URL(request.url || '/', origin)
      const key = `${request.method} ${url.pathname}`
      if (url.pathname.startsWith('/api/')) {
        const site = request.headers['sec-fetch-site']
        if ((site && site !== 'same-origin' && site !== 'none') ||
            (request.headers.origin && request.headers.origin !== origin.origin)) {
          sendJson(response, 403, { error: 'same-origin requests required' })
          return
        }
        if (request.method === 'POST' && (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          sendJson(response, 415, { error: 'application/json required' })
          return
        }
      }
      if (routes[key]) {
        const body = request.method === 'POST' ? await readBody(request) : {}
        sendJson(response, 200, await routes[key](body))
        return
      }
      const asset = STATIC_FILES[url.pathname]
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
        const payload = fs.readFileSync(path.join(webRoot, asset.file))
        response.writeHead(200, {
          'Content-Type': asset.type,
          'Content-Length': payload.length,
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : payload)
        return
      }
      sendJson(response, 404, { error: 'not found', path: url.pathname })
    } catch (error) {
      sendJson(response, 500, { error: error.message || String(error) })
    }
  })

  return {
    server,
    controller,
    listen: (port = DEFAULT_PORT, host = DEFAULT_HOST) => new Promise((resolve, reject) => {
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        reject(new Error('The desktop UI must bind to loopback. Use the authenticated relay for remote access.'))
        return
      }
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve(server.address())
      })
    }),
    close: () => new Promise((resolve) => {
      controller.stopDevicePolling()
      server.close(() => resolve())
    }),
  }
}

if (require.main === module) {
  const port = Number(process.env.ROKU_DESKTOP_PORT || DEFAULT_PORT)
  const app = createServer()
  app.listen(port, process.env.ROKU_DESKTOP_HOST || DEFAULT_HOST).then((address) => {
    console.log(`Roku Sync desktop UI on http://${address.address}:${address.port}`)
    app.controller.startDevicePolling()
    app.controller.refreshDevices().catch((error) => {
      console.error('device refresh failed:', error.message)
    })
    app.controller.scanRokuDevices().catch(() => {})
    const shutdown = () => {
      app.controller.dispose().then(() => app.close()).then(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((error) => {
    console.error('could not start the desktop UI:', error.message)
    process.exit(1)
  })
}

module.exports = { createServer, DEFAULT_PORT, DEFAULT_HOST }
