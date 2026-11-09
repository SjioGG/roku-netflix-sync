'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createServer } = require('../desktop/server.cjs')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-desktop-security-'))
  const app = createServer({ configPath: path.join(dir, 'config.json') })
  app.controller.refreshDevices = async () => {}
  app.controller.saveConfig({ token: 'synthetic-local-test-token' })
  try {
    const address = await app.listen(0)
    const base = `http://127.0.0.1:${address.port}`
    const crossSite = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ patch: { serverUrl: 'https://attacker.example' } }),
    })
    assert.equal(crossSite.status, 403, 'a browser simple request must not overwrite relay settings')
    assert.notEqual(app.controller.getConfig().serverUrl, 'https://attacker.example')
    const rebound = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/state`, { headers: { Host: `attacker.example:${address.port}` } }, response => {
        response.resume(); resolve(response.statusCode)
      })
      request.on('error', reject)
    })
    assert.equal(rebound, 403, 'DNS rebinding must not expose the local API')
    assert.equal((await fetch(`${base}/api/state`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })).status, 403, 'cross-site browser reads must be rejected')
    assert.equal((await fetch(`${base}/api/config`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: '{}',
    })).status, 415, 'writes require JSON')
    const saved = await fetch(`${base}/api/config`, {
      method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { serverUrl: 'https://relay.example' } }),
    }).then(response => response.json())
    assert.equal(saved.config.serverUrl, 'https://relay.example', 'normal UI configuration still works')
    assert.equal(saved.config.token, undefined, 'save responses must not return the token')
    const state = await fetch(`${base}/api/state`).then(response => response.json())
    assert.equal(state.config.token, undefined, 'routine polling must not return the token')
    assert.equal(state.tokenConfigured, true)
    assert.equal((await fetch(`${base}/api/token/reveal`)).status, 404, 'reveal is a POST-only action')
    const revealed = await fetch(`${base}/api/token/reveal`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    }).then(response => response.json())
    assert.equal(revealed.token, 'synthetic-local-test-token', 'explicit local Show/Copy can retrieve the saved token')
    assert.equal((await fetch(`${base}/api/token/reveal`, {
      method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    })).status, 403)
    assert.equal(fs.statSync(app.controller.configPath).mode & 0o777, 0o600, 'saved credentials must be owner-only')
    app.controller.saveConfig({ serverUrl: 'http://relay.example' })
    assert.equal(app.controller.startRokuBridge().started, false, 'bridge credentials must not use remote plaintext HTTP')
    assert.equal(app.controller._children.bridge, null)
    app.controller.saveConfig({ serverUrl: 'https://user:synthetic-password@relay.example' })
    const invalid = await app.controller.pingServer({ samples: 1 })
    assert(!JSON.stringify(invalid).includes('synthetic-password'), 'configuration errors must not log embedded credentials')
  } finally {
    await app.controller.dispose()
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const publicBind = createServer({ configPath: path.join(os.tmpdir(), 'unused-roku-test-config.json') })
  await assert.rejects(() => publicBind.listen(0, '0.0.0.0'), /loopback/i)
  await publicBind.controller.dispose()
  console.log('Desktop UI blocks cross-site writes, DNS rebinding and remote binds; tokens require explicit reveal')
})().catch(error => { console.error(error); process.exitCode = 1 })
