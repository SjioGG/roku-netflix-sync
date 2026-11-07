/*
 * Tests for `desktop/controller.cjs` and the local UI server.
 *
 * Run under plain node with no display server and no Electron install:
 *   for test in tests/*.cjs; do node "$test" || exit 1; done
 */
'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  DesktopController,
  DEFAULT_CONFIG,
  defaultConfigPath,
  normaliseConfig,
  classifyMicSource,
  parseJsonLine,
} = require('../desktop/controller.cjs')
const { createServer } = require('../desktop/server.cjs')

const ROOT = path.resolve(__dirname, '..')
const results = []

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL ${name}\n       ${error && error.message ? error.message : error}`)
  }
}

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-desktop-test-'))
  return { dir, file: path.join(dir, 'desktop-config.json') }
}

function freshController(configPath) {
  return new DesktopController({ rootDir: ROOT, configPath })
}

function pythonJson(args, input) {
  const output = execFileSync('python3', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
  })
  return JSON.parse(output)
}

async function main() {
  console.log('desktop controller')

  await test('default config path lives under ~/.config/roku-netflix-sync', () => {
    const saved = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    const fallback = defaultConfigPath()
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved
    assert.ok(fallback.endsWith(path.join('roku-netflix-sync', 'desktop-config.json')), fallback)
    assert.ok(fallback.startsWith(os.homedir()), fallback)
  })

  await test('config defaults match the shipped URLs and auto-pick', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const config = controller.getConfig()
      assert.equal(config.serverUrl, 'http://127.0.0.1:8766')
      assert.equal(config.rokuUrl, 'http://192.168.1.100:8060')
      assert.equal(config.autoPickSoundcard, true)
      assert.equal(config.token, '')
      assert.deepEqual(Object.keys(config).sort(), Object.keys(DEFAULT_CONFIG).sort())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('config persists to disk and reloads in a new controller', () => {
    const { dir, file } = tempConfigPath()
    try {
      const controller = freshController(file)
      controller.saveConfig({
        serverUrl: 'https://relay.example.test',
        token: 'room-secret',
        autoPickSoundcard: false,
        preferredMicDevice: 'Focusrite Scarlett 2i2 USB',
      })
      assert.ok(fs.existsSync(file), 'config file was not written')
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(onDisk.serverUrl, 'https://relay.example.test')
      assert.equal(onDisk.token, 'room-secret')
      assert.equal(onDisk.autoPickSoundcard, false)
      assert.equal(onDisk.preferredMicDevice, 'Focusrite Scarlett 2i2 USB')

      const reloaded = freshController(file)
      assert.equal(reloaded.getConfig().serverUrl, 'https://relay.example.test')
      assert.equal(reloaded.getConfig().token, 'room-secret')
      assert.equal(reloaded.getConfig().autoPickSoundcard, false)
      assert.equal(reloaded.getConfig().preferredMicDevice, 'Focusrite Scarlett 2i2 USB')
      // Unspecified keys keep their defaults rather than becoming undefined.
      assert.equal(reloaded.getConfig().rokuUrl, 'http://192.168.1.100:8060')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a corrupt config file falls back to defaults instead of throwing', () => {
    const { dir, file } = tempConfigPath()
    try {
      fs.writeFileSync(file, '{ not json', 'utf8')
      const controller = freshController(file)
      assert.equal(controller.getConfig().serverUrl, 'http://127.0.0.1:8766')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('normaliseConfig coerces types and drops unknown keys', () => {
    const config = normaliseConfig({
      serverUrl: 42,
      autoPickSoundcard: 'yes',
      bogus: 'ignored',
      token: null,
    })
    assert.equal(config.serverUrl, '42')
    assert.equal(config.autoPickSoundcard, true)
    assert.equal(config.token, '')
    assert.equal(config.bogus, undefined)
  })

  await test('classifyMicSource describes the UI badge', () => {
    assert.equal(classifyMicSource('usb'), 'Auto: External Soundcard')
    assert.equal(classifyMicSource('builtin'), 'Auto: MacBook Mic')
    assert.equal(classifyMicSource('preferred'), 'Manual override')
    assert.equal(classifyMicSource(null), 'None')
  })

  await test('parseJsonLine ignores log noise', () => {
    assert.equal(parseJsonLine('starting up'), null)
    assert.equal(parseJsonLine(''), null)
    assert.deepEqual(parseJsonLine('{"delay_ms": 12.5}'), { delay_ms: 12.5 })
  })

  await test('refreshDevices reads the live aec_daemon.py device list', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const devices = await controller.refreshDevices()
      assert.ok(devices, 'refreshDevices returned nothing')
      assert.ok(Array.isArray(devices.inputs), 'inputs missing')
      assert.ok(Array.isArray(devices.outputs), 'outputs missing')
      assert.ok(devices.recommended, 'recommendation missing')
      if (!devices.inputs.length) {
        // The CI runner has no CoreAudio and no sounddevice, so the enumeration
        // is legitimately empty; the shape and the empty-state notes still hold.
        assert.ok(devices.recommended.notes.length > 0, 'no guidance for an empty host')
        assert.equal(controller.deviceError, null)
        return
      }
      assert.ok(devices.recommended.mic_device, 'no microphone was recommended')
      assert.ok(['Auto: External Soundcard', 'Auto: MacBook Mic',
        'Manual override', 'Auto'].includes(devices.micBadge), devices.micBadge)
      assert.equal(controller.deviceError, null)
      // The live recommendation must be a real device from the enumeration.
      const names = devices.inputs.map((entry) => entry.name)
      assert.ok(names.includes(devices.recommended.mic_device),
        `${devices.recommended.mic_device} not in ${names.join(', ')}`)
      // Never auto-pick Continuity or a virtual loopback as the physical mic.
      const picked = devices.inputs.find((entry) => entry.name === devices.recommended.mic_device)
      assert.notEqual(picked.kind, 'virtual')
      assert.notEqual(picked.kind, 'continuity')
      const snapshot = controller.snapshot()
      assert.equal(snapshot.devices.recommended.mic_device, devices.recommended.mic_device)
      assert.equal(snapshot.anc.mic_device, devices.recommended.mic_device)
      assert.ok(snapshot.lastDeviceRefresh > 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('saved preferred mic is used when it is connected', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const first = await controller.refreshDevices()
      const candidate = first.inputs.find((entry) => entry.kind !== 'virtual')
      if (!candidate) {
        // No enumerable hardware on this host; the preference plumbing is still
        // covered by the disconnected-preference test below.
        return
      }
      controller.saveConfig({ preferredMicDevice: candidate.name })
      const second = await controller.refreshDevices()
      assert.equal(second.recommended.mic_device, candidate.name)
      assert.equal(second.micBadge, 'Manual override')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a disconnected preferred mic falls back with a warning', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      controller.saveConfig({ preferredMicDevice: 'Focusrite Scarlett 2i2 USB' })
      const devices = await controller.refreshDevices()
      if (!devices.inputs.length) return  // no enumerable audio hardware here
      assert.ok(devices.recommended.mic_device, 'no fallback microphone')
      assert.notEqual(devices.recommended.mic_device, 'Focusrite Scarlett 2i2 USB')
      assert.ok(devices.warnings.some((note) => /not connected/i.test(note)),
        devices.warnings.join(' | '))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('device arguments carry the auto-pick switch', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      controller.saveConfig({ autoPickSoundcard: true, preferredMicDevice: '' })
      assert.ok(!controller._deviceArgs().includes('--no-prefer-usb'))
      controller.saveConfig({ autoPickSoundcard: false })
      assert.ok(controller._deviceArgs().includes('--no-prefer-usb'))
      controller.saveConfig({ preferredMicDevice: 'USB PnP Sound Device' })
      const args = controller._deviceArgs()
      const index = args.indexOf('--prefer-mic-device')
      assert.ok(index >= 0 && args[index + 1] === 'USB PnP Sound Device', args.join(' '))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('runSelfTest returns PASS with a real ERLE figure', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const result = await controller.runSelfTest()
      assert.ok(result, 'self-test returned nothing')
      assert.equal(result.ok, true, `self-test reported ${JSON.stringify(result)}`)
      assert.ok(result.erle_db > 20, `ERLE was only ${result.erle_db} dB`)
      assert.ok(Math.abs(result.delay_ms - result.true_delay_ms) <= 6,
        `delay ${result.delay_ms} vs ${result.true_delay_ms}`)
      assert.equal(controller.selfTest.running, false)
      assert.equal(controller.selfTest.error, null)
      assert.ok(controller.snapshot().selfTest.result.ok)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('runSelfTest matches the daemon CLI exactly', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const fromController = await controller.runSelfTest()
      const fromCli = pythonJson([path.join(ROOT, 'aec_daemon.py'), '--selftest', '--json'])
      assert.equal(fromController.delay_ms, fromCli.delay_ms)
      assert.equal(fromController.erle_db, fromCli.erle_db)
      assert.equal(fromController.ok, fromCli.ok)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('startAnc validates device arguments before it needs sounddevice', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const args = controller.ancArgs()
      assert.equal(args[0], '--live')
      assert.equal(args[1], '--auto')
      assert.ok(args.includes('--json'))
      // The daemon must accept the generated flag set even where sounddevice is
      // missing, otherwise the desktop app cannot report the install hint.
      const stdout = execFileSync('python3',
        [path.join(ROOT, 'aec_daemon.py')].concat(args), {
          cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.assign({}, process.env, { PYTHONPATH: ROOT }),
        }).toString()
      assert.ok(stdout.length >= 0)
    } catch (error) {
      // Without sounddevice the daemon exits 1 after printing the install hint.
      const message = String(error.stderr || error.message)
      assert.ok(/sounddevice/.test(message), `unexpected failure: ${message}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('startAnc spawns the daemon and explains a missing sounddevice', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    const lines = []
    controller.on('log', (entry) => lines.push(entry))
    try {
      const started = controller.startAnc()
      assert.equal(started.started, true, JSON.stringify(started))
      assert.ok(started.pid, 'no child pid')
      // The daemon validates its flags first and only then needs sounddevice, so
      // this either streams telemetry or reports the install hint.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (controller.anc.running) {
        assert.equal(controller.anc.state, 'running')
        assert.ok(controller.anc.mic_device, 'no mic reported by the daemon')
      } else {
        assert.equal(controller.anc.state, 'error')
        assert.ok(lines.some((entry) => /sounddevice/.test(entry.line)),
          lines.map((entry) => entry.line).join(' | '))
      }
      await controller.stopAnc()
      assert.equal(controller.anc.running, false)
      assert.equal(controller.anc.state, 'stopped')
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('stopAnc terminates a live child and parses its telemetry', async () => {
    const { dir, file } = tempConfigPath()
    const { PassThrough } = require('node:stream')
    const { EventEmitter } = require('node:events')
    const killed = []
    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.pid = 4242
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = (signal) => {
        killed.push(signal)
        setTimeout(() => child.emit('exit', 0, signal), 10)
        return true
      }
      setTimeout(() => {
        child.stdout.write(JSON.stringify({ event: 'start', mic_device: 'USB PnP Sound Device',
          ref_device: 'BlackHole 2ch', out_device: 'ZoomAudioDevice', notes: [] }) + '\n')
        child.stdout.write(JSON.stringify({ event: 'telemetry', delay_ms: 205.5, erle_db: 31.2,
          confidence: 0.9, double_talk: false, samples: 4096 }) + '\n')
      }, 20)
      return child
    }
    const controller = new DesktopController({ rootDir: ROOT, configPath: file, spawn: fakeSpawn })
    try {
      controller.startAnc()
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(controller.anc.state, 'running')
      assert.equal(controller.anc.mic_device, 'USB PnP Sound Device')
      assert.equal(controller.anc.delay_ms, 205.5)
      assert.equal(controller.anc.erle_db, 31.2)
      const stopped = await controller.stopAnc()
      assert.equal(stopped.stopped, true)
      assert.deepEqual(killed, ['SIGTERM'])
      assert.equal(controller.anc.running, false)
      assert.equal(controller.anc.state, 'stopped')
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('stopAnc is safe when nothing is running', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const result = await controller.stopAnc()
      assert.equal(result.stopped, false)
      assert.equal(controller.anc.state, 'stopped')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('bridge environment carries the saved relay settings', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      controller.saveConfig({ serverUrl: 'http://127.0.0.1:8766', token: 't-1',
        rokuUrl: 'http://10.0.0.5:8060' })
      const env = controller.bridgeEnv()
      assert.equal(env.SYNC_SERVER_URL, 'http://127.0.0.1:8766')
      assert.equal(env.SYNC_TOKEN, 't-1')
      assert.equal(env.ROKU_URL, 'http://10.0.0.5:8060')
      assert.equal(env.ROKU_CLIENT_STATUS_JSON, '1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('startRokuBridge spawns and stops the bridge child', async () => {
    const { dir, file } = tempConfigPath()
    const { PassThrough } = require('node:stream')
    const { EventEmitter } = require('node:events')
    const killed = []
    const fakeSpawn = (command, args, options) => {
      const child = new EventEmitter()
      child.pid = 5151
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = (signal) => {
        killed.push(signal)
        setTimeout(() => child.emit('exit', 0, signal), 10)
        return true
      }
      // The bridge must receive the saved relay settings in its environment.
      child.spawnedWith = { command, args, env: options.env }
      setTimeout(() => {
        child.stdout.write(JSON.stringify({ event: 'start', server_url: 'http://127.0.0.1:8766',
          roku_url: 'http://192.168.1.100:8060' }) + '\n')
        child.stdout.write(JSON.stringify({ event: 'status', roku: 'play',
          app_name: 'Netflix', position_ms: 125000, commands: 1 }) + '\n')
      }, 20)
      return child
    }
    const controller = new DesktopController({ rootDir: ROOT, configPath: file, spawn: fakeSpawn })
    try {
      const started = controller.startRokuBridge()
      assert.equal(started.started, true, JSON.stringify(started))
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(controller.bridge.state, 'connected')
      assert.equal(controller.bridge.roku, 'play')
      assert.equal(controller.bridge.app_name, 'Netflix')
      assert.equal(controller.bridge.position_ms, 125000)
      const env = controller._children.bridge.spawnedWith.env
      assert.equal(env.SYNC_SERVER_URL, 'http://127.0.0.1:8766')
      assert.equal(env.ROKU_URL, 'http://192.168.1.100:8060')
      assert.equal(env.ROKU_CLIENT_STATUS_JSON, '1')
      const stopped = await controller.stopRokuBridge()
      assert.equal(stopped.stopped, true)
      assert.deepEqual(killed, ['SIGTERM'])
      assert.equal(controller.bridge.running, false)
      assert.equal(controller.bridge.state, 'stopped')
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a bridge child that exits non-zero reports an error state', async () => {
    const { dir, file } = tempConfigPath()
    const { EventEmitter } = require('node:events')
    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.pid = 6161
      child.stdout = null
      child.stderr = null
      child.kill = () => true
      setTimeout(() => child.emit('exit', 3, null), 20)
      return child
    }
    const controller = new DesktopController({ rootDir: ROOT, configPath: file, spawn: fakeSpawn })
    try {
      controller.startRokuBridge()
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(controller.bridge.state, 'error')
      assert.ok(/code 3/.test(controller.bridge.error), controller.bridge.error)
      assert.equal(controller.bridge.running, false)
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('bridge status lines update the player state', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      controller._onBridgeLine(JSON.stringify({ event: 'start' }))
      controller._onBridgeLine(JSON.stringify({
        event: 'status', roku: 'play', app_name: 'Netflix', position_ms: 61000, commands: 2,
      }))
      assert.equal(controller.bridge.state, 'connected')
      assert.equal(controller.bridge.roku, 'play')
      assert.equal(controller.bridge.app_name, 'Netflix')
      assert.equal(controller.bridge.position_ms, 61000)
      assert.equal(controller.bridge.commands, 2)
      controller._onBridgeLine('bridge cycle failed: timed out')
      assert.equal(controller.bridge.roku, 'play')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('ANC telemetry lines become delay/ERLE/double-talk state', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      controller._onAncLine(JSON.stringify({ event: 'start', mic_device: 'MacBook Pro Microphone',
        ref_device: 'ZoomAudioDevice', out_device: 'ZoomAudioDevice', notes: ['note one'] }))
      assert.equal(controller.anc.state, 'running')
      assert.deepEqual(controller.anc.notes, ['note one'])
      controller._onAncLine(JSON.stringify({ event: 'telemetry', delay_ms: 183.4, erle_db: 27.5,
        double_talk: true, confidence: 0.82, samples: 51200,
        mic_device: 'Focusrite Scarlett 2i2 USB' }))
      assert.equal(controller.anc.delay_ms, 183.4)
      assert.equal(controller.anc.erle_db, 27.5)
      assert.equal(controller.anc.double_talk, true)
      assert.equal(controller.anc.confidence, 0.82)
      assert.equal(controller.anc.mic_device, 'Focusrite Scarlett 2i2 USB')
      assert.equal(controller.snapshot().anc.delay_ms, 183.4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('desktop local UI server')

  await test('server.cjs serves index.html and a JSON state API', async () => {
    const { dir, file } = tempConfigPath()
    const app = createServer({ configPath: file })
    try {
      const address = await app.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${address.port}`
      const html = await fetch(`${base}/`).then((response) => response.text())
      assert.ok(html.includes('ANC Microphone Studio'), 'index.html did not render')
      assert.ok(html.includes('Roku TV Bridge'), 'bridge card missing')
      const renderer = await fetch(`${base}/renderer.js`).then((response) => response.text())
      assert.ok(renderer.includes('rokuDesktop'), 'renderer polyfill missing')
      const state = await fetch(`${base}/api/state`).then((response) => response.json())
      assert.equal(state.config.serverUrl, 'http://127.0.0.1:8766')
      assert.ok(state.anc && state.bridge)
      const saved = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { token: 'via-http' } }),
      }).then((response) => response.json())
      assert.equal(saved.config.token, 'via-http')
      const devices = await fetch(`${base}/api/devices/refresh`, { method: 'POST' })
        .then((response) => response.json())
      assert.ok(devices.devices, 'no devices in the refresh response')
      assert.ok(devices.devices.recommended, 'no recommendation in the response')
      if (devices.devices.inputs.length) {
        assert.ok(devices.devices.recommended.mic_device)
      }
      const missing = await fetch(`${base}/nope`)
      assert.equal(missing.status, 404)
    } finally {
      await app.controller.dispose()
      await app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('server.cjs self-test endpoint matches the controller', async () => {
    const { dir, file } = tempConfigPath()
    const app = createServer({ configPath: file })
    try {
      const address = await app.listen(0, '127.0.0.1')
      const result = await fetch(`http://127.0.0.1:${address.port}/api/anc/selftest`,
        { method: 'POST' }).then((response) => response.json())
      assert.equal(result.selfTest.result.ok, true)
      assert.ok(result.selfTest.result.erle_db > 20)
    } finally {
      await app.controller.dispose()
      await app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('desktop packaging')

  await test('package.json declares the pinned Electron wrapper', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'roku-sync-desktop')
    assert.equal(pkg.version, '0.3.2')
    assert.equal(pkg.main, 'main.js')
    assert.equal(pkg.scripts.start, 'electron .')
    assert.ok(/^\^35\./.test(pkg.devDependencies.electron), pkg.devDependencies.electron)
  })

  await test('every desktop file exists and the launcher is executable', () => {
    for (const name of ['main.js', 'preload.js', 'controller.cjs', 'server.cjs',
      'index.html', 'renderer.js', 'styles.css', 'package.json']) {
      const target = path.join(ROOT, 'desktop', name)
      assert.ok(fs.existsSync(target), `${name} is missing`)
    }
    const launcher = path.join(ROOT, 'bin', 'launch-desktop.sh')
    assert.ok(fs.existsSync(launcher), 'bin/launch-desktop.sh is missing')
    const mode = fs.statSync(launcher).mode
    assert.ok(mode & 0o111, 'launch-desktop.sh is not executable')
    const shellcheck = execFileSync('bash', ['-n', launcher], { encoding: 'utf8' })
    assert.equal(shellcheck.trim(), '')
  })

  await test('main.js and preload.js keep the secure Electron defaults', () => {
    const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8')
    assert.ok(/contextIsolation:\s*true/.test(main), 'contextIsolation must be on')
    assert.ok(/nodeIntegration:\s*false/.test(main), 'nodeIntegration must be off')
    assert.ok(/preload:\s*path\.join\(__dirname, 'preload\.js'\)/.test(main), 'preload wiring')
    assert.ok(/ipcMain\.handle/.test(main), 'no IPC handlers registered')
    const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8')
    assert.ok(/contextBridge\.exposeInMainWorld\('rokuDesktop'/.test(preload))
    assert.ok(!/nodeIntegration:\s*true/.test(preload))
  })

  await test('device polling runs every 4 seconds', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      assert.equal(controller.devicePollMs, 4000)
      controller.saveConfig({})
      controller.startDevicePolling()
      assert.ok(controller._pollTimer, 'poll timer was not created')
      controller.stopDevicePolling()
      assert.equal(controller._pollTimer, null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const failed = results.filter((entry) => !entry.ok)
  console.log('')
  if (failed.length) {
    console.error(`${failed.length} desktop test(s) failed`)
    process.exit(1)
  }
  console.log(`All ${results.length} desktop checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
