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
  describePingMath,
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

  console.log('desktop Roku discovery')

  await test('snapshot ships an empty Roku device list before the first scan', () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      const snapshot = controller.snapshot()
      assert.deepEqual(snapshot.rokuDevices, [])
      assert.equal(snapshot.lastRokuScan, null)
      assert.deepEqual(snapshot.pingTest, { running: false, result: null, error: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('scanRokuDevices runs the discovery CLI with a seed URL', async () => {
    const { dir, file } = tempConfigPath()
    const { PassThrough } = require('node:stream')
    const { EventEmitter } = require('node:events')
    const spawned = []
    const fakeSpawn = (command, args) => {
      spawned.push({ command, args })
      const child = new EventEmitter()
      child.pid = 9090
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      setTimeout(() => {
        child.stdout.end(JSON.stringify({
          devices: [
            { url: 'http://192.168.1.100:8060', name: 'Living Room TV', location: 'Bedroom',
              model_name: 'Roku Smart Soundbar', model_number: '9101X', network_name: 'Example Wi-Fi',
              network_type: 'wifi', active_app: 'YouTube', latency_ms: 14,
              supports_airplay: true, is_soundbar: true, label: 'Living Room TV (Bedroom)' },
            { url: 'http://192.168.1.50:8060', name: 'Office Roku', location: '',
              model_name: 'Roku Ultra', model_number: '4802X', network_name: 'home-lan',
              network_type: 'wired', active_app: null, latency_ms: 9,
              supports_airplay: false, is_soundbar: false, label: 'Office Roku' },
          ],
          scanned_candidates: 7,
        }))
        setTimeout(() => child.emit('close', 0), 5)
      }, 20)
      return child
    }
    const controller = new DesktopController({ rootDir: ROOT, configPath: file, spawn: fakeSpawn })
    try {
      controller.saveConfig({ rokuUrl: 'http://192.168.1.100:8060' })
      const before = Date.now()
      const result = await controller.scanRokuDevices()
      assert.equal(spawned.length, 1)
      assert.equal(spawned[0].command, 'python3')
      assert.ok(spawned[0].args.some((arg) => arg.endsWith('roku_client.py')), spawned[0].args.join(' '))
      for (const flag of ['--discover', '--json', '--seed-url']) {
        assert.ok(spawned[0].args.includes(flag), `${flag} missing from ${spawned[0].args.join(' ')}`)
      }
      assert.equal(spawned[0].args[spawned[0].args.indexOf('--seed-url') + 1], 'http://192.168.1.100:8060')
      assert.equal(result.devices.length, 2)
      assert.equal(controller.rokuDevices.length, 2)
      assert.equal(controller.rokuDevices[0].model_number, '9101X')
      assert.equal(controller.rokuDevices[1].active_app, null)
      assert.ok(controller.lastRokuScan >= before)
      assert.equal(controller.rokuScanError, null)
      const snapshot = controller.snapshot()
      assert.equal(snapshot.rokuDevices.length, 2)
      assert.equal(snapshot.lastRokuScan, controller.lastRokuScan)
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('scanRokuDevices keeps a failed scan out of the state list', async () => {
    const { dir, file } = tempConfigPath()
    const { PassThrough } = require('node:stream')
    const { EventEmitter } = require('node:events')
    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.pid = 9091
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      setTimeout(() => {
        child.stderr.end('Traceback: boom\n')
        child.emit('close', 1)
      }, 10)
      return child
    }
    const controller = new DesktopController({ rootDir: ROOT, configPath: file, spawn: fakeSpawn })
    try {
      const result = await controller.scanRokuDevices()
      assert.deepEqual(result.devices, [])
      assert.ok(/exited with 1/.test(controller.rokuScanError), controller.rokuScanError)
      assert.deepEqual(controller.snapshot().rokuDevices, [])
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('scanRokuDevices reads the live discovery CLI', async () => {
    const { dir, file } = tempConfigPath()
    const controller = freshController(file)
    try {
      // Seeds only: no SSDP or arp chatter so the test stays offline-safe.
      controller.saveConfig({ rokuUrl: 'http://127.0.0.1:1' })
      const result = await controller.scanRokuDevices()
      assert.ok(Array.isArray(result.devices), 'devices is not an array')
      assert.ok(controller.lastRokuScan > 0)
      // A reserved port cannot answer, so nothing is discovered and no error is
      // raised: discovery treats unreachable candidates as normal.
      assert.equal(controller.rokuScanError, null)
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('desktop ping / RTT tester')

  await test('pingServer measures a local /clock server and selects the best sample', async () => {
    const { dir, file } = tempConfigPath()
    const http = require('node:http')
    const clock = http.createServer((request, response) => {
      if (request.url !== '/clock') {
        response.writeHead(404).end()
        return
      }
      if (request.headers.authorization !== 'Bearer room-token') {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const received = Date.now()
      const payload = JSON.stringify({
        server_ms: Date.now(),
        received_ms: received,
        roku_poll_ms: 18,
        roku_toggle_ms: 44,
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(payload)
    })
    const controller = new DesktopController({ rootDir: ROOT, configPath: file })
    try {
      await new Promise((resolve) => clock.listen(0, '127.0.0.1', resolve))
      const port = clock.address().port
      controller.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, token: 'room-token' })
      const result = await controller.pingServer()
      assert.equal(result.mode, 'live')
      assert.equal(result.samples.length, 5)
      assert.equal(result.samples.filter((sample) => sample.selected).length, 1)
      const selected = result.samples.find((sample) => sample.selected)
      assert.equal(result.best_rtt_ms, Math.round(selected.network_rtt_ms * 10) / 10)
      assert.ok(Number.isFinite(result.min_rtt_ms))
      assert.ok(result.max_rtt_ms >= result.min_rtt_ms)
      assert.ok(result.avg_rtt_ms >= result.min_rtt_ms && result.avg_rtt_ms <= result.max_rtt_ms)
      assert.equal(result.jitter_ms, Math.round((result.max_rtt_ms - result.min_rtt_ms) * 10) / 10)
      assert.equal(result.one_way_network_ms, Math.round((selected.network_rtt_ms / 2) * 10) / 10)
      assert.equal(result.clock_offset_ms, selected.offset_ms)
      assert.equal(result.roku_poll_ms, 18)
      assert.equal(result.roku_toggle_ms, 44)
      assert.equal(result.roku_one_way_ms, 31)
      assert.equal(result.player_trim_ms, -300)
      assert.equal(result.effective_roku_lead_ms, -269)
      assert.equal(result.adaptive_lead_ms,
        Math.min(15000, Math.max(3000, Math.ceil(2000 + selected.total_rtt_ms * 4))))
      assert.equal(result.roku_fire_at_ms, result.adaptive_lead_ms - result.effective_roku_lead_ms)
      assert.equal(result.chrome_fire_at_ms, result.adaptive_lead_ms)
      assert.equal(result.server_url, `http://127.0.0.1:${port}`)
      assert.ok(/Adaptive lead/.test(result.formula_summary), result.formula_summary)
      assert.ok(/keypress\/Play/.test(result.formula_summary), result.formula_summary)
      // Every sample keeps the raw and derived timings side by side.
      for (const sample of result.samples) {
        assert.ok(Number.isFinite(sample.raw_rtt_ms))
        assert.ok(Number.isFinite(sample.total_rtt_ms))
        assert.ok(sample.network_rtt_ms >= 0)
        assert.ok(Number.isInteger(sample.offset_ms))
      }
      assert.deepEqual(controller.pingTest, { running: false, result, error: null })
      assert.equal(controller.snapshot().pingTest.result.best_rtt_ms, result.best_rtt_ms)
    } finally {
      await controller.dispose()
      await new Promise((resolve) => clock.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('pingServer returns the Japan +240 ms simulation with extra RTT and jitter', async () => {
    const { dir, file } = tempConfigPath()
    const http = require('node:http')
    const clock = http.createServer((request, response) => {
      if (request.url !== '/clock') {
        response.writeHead(404).end()
        return
      }
      const received = Date.now()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ server_ms: Date.now(), received_ms: received,
        roku_poll_ms: 15, roku_toggle_ms: 40 }))
    })
    const controller = new DesktopController({ rootDir: ROOT, configPath: file })
    try {
      await new Promise((resolve) => clock.listen(0, '127.0.0.1', resolve))
      const port = clock.address().port
      controller.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, token: '' })
      const live = await controller.pingServer()
      const japan = await controller.pingServer({ simulateAddedRttMs: 240, simulateJitterMs: 12 })
      assert.equal(japan.mode, 'japan_simulation')
      assert.equal(japan.simulated_added_rtt_ms, 240)
      assert.equal(japan.simulated_jitter_ms, 12)
      // Every simulated sample carries the added RTT on top of its raw figure.
      for (const sample of japan.samples) {
        const added = sample.added_rtt_ms
        assert.ok(added >= 240 - 12 && added <= 240 + 12, `added ${added} out of range`)
        assert.equal(sample.total_rtt_ms, Math.round((sample.raw_rtt_ms + added) * 10) / 10)
      }
      // The deterministic jitter pattern must actually move the samples around.
      const addedValues = new Set(japan.samples.map((sample) => sample.added_rtt_ms))
      assert.ok(addedValues.size > 1, `jitter did not vary: ${[...addedValues].join(', ')}`)
      // Japan is further away, so the RTT and the adaptive lead both grow.
      assert.ok(japan.best_rtt_ms > live.best_rtt_ms + 200,
        `${japan.best_rtt_ms} should exceed ${live.best_rtt_ms} by ~240 ms`)
      assert.ok(japan.adaptive_lead_ms >= live.adaptive_lead_ms)
      assert.equal(japan.adaptive_lead_ms,
        Math.min(15000, Math.max(3000, Math.ceil(2000 + japan.samples.find((s) => s.selected).total_rtt_ms * 4))))
      // The fire times differ by exactly the effective Roku lead, which is what
      // keeps both frames inside the 500 ms tolerance.
      assert.equal(japan.chrome_fire_at_ms - japan.roku_fire_at_ms, japan.effective_roku_lead_ms)
      assert.ok(Math.abs(japan.chrome_fire_at_ms - japan.roku_fire_at_ms) < 500,
        `fire times drifted by ${japan.chrome_fire_at_ms - japan.roku_fire_at_ms} ms`)
      assert.ok(/Japan simulation/.test(japan.formula_summary), japan.formula_summary)
      assert.ok(japan.jitter_ms > 0, `jitter was ${japan.jitter_ms}`)
    } finally {
      await controller.dispose()
      await new Promise((resolve) => clock.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('pingServer reports 401 with the room-token hint', async () => {
    const { dir, file } = tempConfigPath()
    const http = require('node:http')
    const clock = http.createServer((request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Unauthorized' }))
    })
    const controller = new DesktopController({ rootDir: ROOT, configPath: file })
    try {
      await new Promise((resolve) => clock.listen(0, '127.0.0.1', resolve))
      controller.saveConfig({ serverUrl: `http://127.0.0.1:${clock.address().port}`, token: 'wrong' })
      const result = await controller.pingServer({ samples: 1 })
      assert.equal(result.running, false)
      assert.equal(result.result, null)
      assert.ok(/401 Unauthorized/.test(result.error), result.error)
      assert.ok(/Room Token/.test(result.error), result.error)
      assert.equal(controller.pingTest.error, result.error)
    } finally {
      await controller.dispose()
      await new Promise((resolve) => clock.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('pingServer reports an unreachable relay instead of throwing', async () => {
    const { dir, file } = tempConfigPath()
    const controller = new DesktopController({ rootDir: ROOT, configPath: file })
    try {
      // Port 1 is reserved, so the connection is refused immediately.
      controller.saveConfig({ serverUrl: 'http://127.0.0.1:1', token: '' })
      const result = await controller.pingServer({ samples: 2 })
      assert.equal(result.running, false)
      assert.equal(result.result, null)
      assert.ok(result.error && result.error.length > 0, JSON.stringify(result))
      assert.equal(controller.snapshot().pingTest.error, result.error)
    } finally {
      await controller.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('pingServer accepts a custom sample count and player trim', async () => {
    const { dir, file } = tempConfigPath()
    const http = require('node:http')
    let hits = 0
    const clock = http.createServer((request, response) => {
      hits += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ server_ms: Date.now(), received_ms: Date.now(),
        roku_poll_ms: 20, roku_toggle_ms: 60 }))
    })
    const controller = new DesktopController({ rootDir: ROOT, configPath: file })
    try {
      await new Promise((resolve) => clock.listen(0, '127.0.0.1', resolve))
      controller.saveConfig({ serverUrl: `http://127.0.0.1:${clock.address().port}`, token: 't' })
      const result = await controller.pingServer({ samples: 3, playerTrimMs: -100 })
      assert.equal(hits, 3)
      assert.equal(result.samples.length, 3)
      assert.equal(result.player_trim_ms, -100)
      assert.equal(result.roku_one_way_ms, 40)
      assert.equal(result.effective_roku_lead_ms, -60)
    } finally {
      await controller.dispose()
      await new Promise((resolve) => clock.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('describePingMath names every input and both fire times', () => {
    const text = describePingMath({
      mode: 'japan_simulation', simulated_added_rtt_ms: 240, simulated_jitter_ms: 12,
      server_url: 'https://sync.example.test', best_rtt_ms: 268.4,
      one_way_network_ms: 134.2, jitter_ms: 9.5, clock_offset_ms: -42,
      roku_poll_ms: 15, roku_toggle_ms: 40, roku_one_way_ms: 28,
      player_trim_ms: -300, effective_roku_lead_ms: -272, adaptive_lead_ms: 3120,
      roku_fire_at_ms: 3392, chrome_fire_at_ms: 3120,
      samples: [{ index: 2, selected: true }],
    })
    assert.ok(/Japan simulation/.test(text), text)
    assert.ok(/Best network RTT 268.4 ms/.test(text), text)
    assert.ok(/sample #2 of 1/.test(text), text)
    assert.ok(/Clock offset -42 ms/.test(text), text)
    assert.ok(/Adaptive lead 3120 ms/.test(text), text)
    assert.ok(/keypress\/Play at t=3392 ms/.test(text), text)
    assert.ok(/video\.play\(\) at t=3120 ms/.test(text), text)
    assert.ok(/500 ms tolerance/.test(text), text)
  })

  await test('the local UI server exposes the scan and ping routes', async () => {
    const { dir, file } = tempConfigPath()
    const app = createServer({ configPath: file })
    try {
      const address = await app.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${address.port}`
      const html = await fetch(`${base}/`).then((response) => response.text())
      for (const id of ['copy-token', 'scan-roku', 'roku-device-list', 'ping-live', 'ping-japan']) {
        assert.ok(html.includes(`id="${id}"`), `${id} missing from index.html`)
      }
      const renderer = await fetch(`${base}/renderer.js`).then((response) => response.text())
      assert.ok(renderer.includes('scanRokuDevices'), 'renderer has no scan call')
      assert.ok(renderer.includes('pingServer'), 'renderer has no ping call')
      assert.ok(renderer.includes('navigator.clipboard.writeText') || renderer.includes('api.copy'),
        'renderer has no clipboard copy')
      const scanned = await fetch(`${base}/api/roku/scan`, { method: 'POST' })
        .then((response) => response.json())
      assert.ok(Array.isArray(scanned.rokuDevices), 'scan route returned no device list')
      const pinged = await fetch(`${base}/api/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: { samples: 1 } }),
      }).then((response) => response.json())
      assert.ok(pinged.pingTest, 'ping route returned no pingTest')
      assert.equal(pinged.pingTest.running, false)
      // The default relay is unreachable from CI, which must surface as an error
      // in the ping state rather than a failed HTTP request.
      assert.ok(pinged.pingTest.error || pinged.pingTest.result)
    } finally {
      await app.controller.dispose()
      await app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('desktop renderer')

  await test('renderer draws the AirPlay device cards and the RTT panel', async () => {
    const vm = require('node:vm')
    const elements = new Map()

    const makeElement = (tag) => {
      const element = {
        tagName: tag || 'div',
        children: [],
        _text: '',
        _html: '',
        className: '',
        dataset: {},
        style: {},
        value: '',
        type: 'text',
        disabled: false,
        checked: false,
        scrollTop: 0,
        scrollHeight: 0,
        attributes: {},
        listeners: {},
        classList: {
          _set: new Set(),
          add(name) { this._set.add(name) },
          remove(name) { this._set.delete(name) },
          contains(name) { return this._set.has(name) },
          toggle(name, force) {
            if (force === undefined) {
              if (this._set.has(name)) this._set.delete(name)
              else this._set.add(name)
            } else if (force) this._set.add(name)
            else this._set.delete(name)
          },
        },
        appendChild(child) { this.children.push(child); return child },
        addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) },
        setAttribute(name, value) { this.attributes[name] = String(value) },
        querySelectorAll() {
          return this.children.filter((child) => String(child.className).includes('airplay-device'))
        },
      }
      Object.defineProperty(element, 'textContent', {
        get() { return this._text + this.children.map((child) => child.textContent).join('') },
        set(value) { this._text = String(value); this.children = [] },
      })
      Object.defineProperty(element, 'innerHTML', {
        get() { return this._html },
        set(value) { this._html = String(value); if (!value) this.children = [] },
      })
      return element
    }

    const document = {
      activeElement: null,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement('div'))
        return elements.get(id)
      },
      createElement(tag) { return makeElement(tag) },
      querySelectorAll() { return [] },
    }

    const state = {
      config: { serverUrl: 'https://sync.example.test', token: 'room-token',
        rokuUrl: 'http://192.168.1.100:8060', autoPickSoundcard: true },
      configPath: '/tmp/desktop-config.json',
      configLoadedFromDisk: true,
      tokenFromConfigFile: true,
      devices: null,
      deviceError: null,
      deviceSource: null,
      lastDeviceRefresh: null,
      anc: { running: false, state: 'stopped', error: null, delay_ms: 0, erle_db: 0,
        double_talk: false, mic_device: null, ref_device: null, out_device: null },
      bridge: { running: false, state: 'stopped', error: null, roku: null, app_name: null,
        position_ms: null, commands: 0 },
      selfTest: { running: false, result: null, error: null },
      rokuDevices: [
        { url: 'http://192.168.1.100:8060', name: 'Living Room TV', location: 'Bedroom',
          model_name: 'Roku Smart Soundbar', model_number: '9101X', network_name: 'Example Wi-Fi',
          network_type: 'wifi', active_app: 'YouTube', latency_ms: 14,
          supports_airplay: true, is_soundbar: true, is_tv: false,
          power_mode: 'PowerOn', label: 'Living Room TV (Bedroom)' },
        { url: 'http://192.168.1.50:8060', name: 'Office Roku', location: '',
          model_name: 'Roku Ultra', model_number: '4802X', network_name: 'home-lan',
          network_type: 'wired', active_app: null, latency_ms: 9,
          supports_airplay: false, is_soundbar: false, is_tv: true,
          power_mode: 'PowerOn', label: 'Office Roku' },
      ],
      lastRokuScan: Date.now(),
      rokuScanError: null,
      pingTest: {
        running: false,
        error: null,
        result: {
          mode: 'japan_simulation', server_url: 'https://sync.example.test',
          samples: [
            { index: 1, raw_rtt_ms: 3, total_rtt_ms: 483, network_rtt_ms: 483, offset_ms: -240, selected: false },
            { index: 2, raw_rtt_ms: 2, total_rtt_ms: 462, network_rtt_ms: 462, offset_ms: -231, selected: true },
          ],
          best_rtt_ms: 462, avg_rtt_ms: 472.5, min_rtt_ms: 462, max_rtt_ms: 483, jitter_ms: 21,
          one_way_network_ms: 231, clock_offset_ms: -231, roku_poll_ms: 15, roku_toggle_ms: 40,
          roku_one_way_ms: 28, player_trim_ms: -300, effective_roku_lead_ms: -272,
          adaptive_lead_ms: 3848, roku_fire_at_ms: 4120, chrome_fire_at_ms: 3848,
          simulated_added_rtt_ms: 240, simulated_jitter_ms: 18, simulated_clock_skew_ms: 0,
          measured_at: Date.now(),
          formula_summary: 'Adaptive lead 3848 ms = clamp(2000 + best_RTT × 4, 3000, 15000).',
        },
      },
    }

    let renderState = null
    const pingCalls = []
    const api = {
      isElectron: true,
      getState: () => Promise.resolve(state),
      saveConfig: () => Promise.resolve(state),
      refreshDevices: () => Promise.resolve(state),
      startAnc: () => Promise.resolve(state),
      stopAnc: () => Promise.resolve(state),
      runSelfTest: () => Promise.resolve(state),
      startBridge: () => Promise.resolve(state),
      stopBridge: () => Promise.resolve(state),
      scanRokuDevices: () => Promise.resolve(state),
      pingServer: (options) => { pingCalls.push(options); return Promise.resolve(state) },
      recentLogs: () => Promise.resolve([]),
      copy: () => Promise.resolve(true),
      openExternal: () => Promise.resolve(true),
      onState: (callback) => { renderState = callback; return () => {} },
      onLog: () => () => {},
    }

    const window = { rokuDesktop: api }
    const source = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.js'), 'utf8')
    vm.runInNewContext(source, {
      window,
      document,
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: () => Promise.reject(new Error('no network in this test')),
      performance,
      URL,
    })

    assert.equal(typeof renderState, 'function', 'renderer never subscribed to state')
    renderState(state)

    const list = elements.get('roku-device-list')
    assert.equal(list.children.length, 2, 'both Rokus should render as cards')
    const firstCard = list.children[0]
    assert.equal(firstCard.dataset.url, 'http://192.168.1.100:8060')
    assert.equal(firstCard.attributes['aria-selected'], 'true', 'configured Roku must be selected')
    const firstText = firstCard.textContent
    for (const expected of ['Living Room TV (Bedroom)', 'Bedroom', 'Roku Smart Soundbar 9101X',
      'Wi-Fi: Example Wi-Fi', 'Active: YouTube', '14 ms']) {
      assert.ok(firstText.includes(expected), `card missing "${expected}": ${firstText}`)
    }
    // The AirPlay badge is a styled span, so it is appended rather than inline text.
    const ready = firstCard.children[1].children[1].children
      .filter((node) => node.className === 'airplay-ready')
    assert.equal(ready.length, 1, 'AirPlay Ready badge missing')
    assert.equal(ready[0].textContent, ' · AirPlay Ready')
    // A TV without AirPlay keeps the model line and drops the badge.
    const secondCard = list.children[1]
    assert.ok(secondCard.textContent.includes('Roku Ultra 4802X'), secondCard.textContent)
    assert.equal(secondCard.children[1].children[1].children
      .filter((node) => node.className === 'airplay-ready').length, 0)

    assert.equal(elements.get('ping-best').textContent, '462')
    assert.equal(elements.get('ping-oneway').textContent, '231')
    assert.equal(elements.get('ping-jitter').textContent, '21')
    assert.equal(elements.get('ping-offset').textContent, '-231')
    assert.equal(elements.get('ping-roku-oneway').textContent, '28')
    assert.equal(elements.get('ping-lead').textContent, '3.848s')
    assert.equal(elements.get('ping-mode').textContent, 'Japan simulation')

    const pills = elements.get('ping-samples').children
    assert.equal(pills.length, 2, 'one pill per sample')
    assert.equal(pills[0].textContent, '#1: 483ms')
    assert.equal(pills[1].textContent, '#2: 462ms ★')
    assert.ok(pills[1].className.includes('best'), 'the selected sample must be highlighted')
    assert.ok(elements.get('ping-formula').textContent.includes('Adaptive lead 3848 ms'))

    // A second identical render must not rebuild the card list.
    const before = list.children[0]
    renderState(state)
    assert.equal(list.children[0], before, 'device cards rebuilt without a state change')

    // Selecting the other Roku moves the highlight when config changes.
    renderState(Object.assign({}, state, {
      config: Object.assign({}, state.config, { rokuUrl: 'http://192.168.1.50:8060' }),
    }))
    assert.equal(elements.get('roku-device-list').children[1].attributes['aria-selected'], 'true')
    assert.equal(elements.get('roku-device-list').children[0].attributes['aria-selected'], 'false')

    // The token badge reflects whether the token came off disk.
    assert.equal(elements.get('token-source').textContent, 'Loaded from config file')
    assert.deepEqual(elements.get('token-source').classList._set.size, 0)
    renderState(Object.assign({}, state, { tokenFromConfigFile: false }))
    assert.ok(elements.get('token-source').classList.contains('hidden'))

    // The buttons must call the controller with the options their labels promise.
    const sampleButton = (id) => elements.get(id).listeners.click[0]
    await sampleButton('ping-live')()
    assert.deepEqual(pingCalls.pop(), { samples: 5 })
    await sampleButton('ping-japan')()
    assert.deepEqual(pingCalls.pop(), { samples: 5, simulateAddedRttMs: 240, simulateJitterMs: 18 })
    await sampleButton('copy-token')()
    assert.equal(elements.get('copy-token').textContent, 'Copied!',
      'the copy button must flash a confirmation')
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
