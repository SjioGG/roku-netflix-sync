'use strict'
/*
 * Pure Node.js core for the Roku Sync desktop app.
 *
 * Everything the UI needs lives here: config persistence, audio-device
 * discovery, and the lifetime of the two Python children (the ANC microphone
 * daemon and the Roku LAN bridge). It deliberately does not require
 * `electron`, so `tests/desktop-app.cjs` can drive all of it under plain node
 * with no display server, and `desktop/server.cjs` can reuse the exact same
 * behaviour behind a browser UI.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const DEFAULT_CONFIG = Object.freeze({
  serverUrl: 'http://127.0.0.1:8766',
  token: '',
  rokuUrl: 'http://192.168.1.100:8060',
  autoPickSoundcard: true,
  preferredMicDevice: '',
  preferredRefDevice: '',
  preferredOutDevice: '',
})

const CONFIG_DIR_NAME = 'roku-netflix-sync'
const CONFIG_FILE_NAME = 'desktop-config.json'
const DEVICE_POLL_MS = 4000
const SELF_TEST_TIMEOUT_MS = 120000
const DEVICE_LIST_TIMEOUT_MS = 30000
const STOP_GRACE_MS = 3000

function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}

function normaliseConfig(raw) {
  const config = Object.assign({}, DEFAULT_CONFIG)
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const value = raw[key]
      if (value === undefined || value === null) continue
      if (typeof DEFAULT_CONFIG[key] === 'boolean') {
        config[key] = Boolean(value)
      } else {
        config[key] = String(value)
      }
    }
  }
  return config
}

function classifyMicSource(source) {
  if (source === 'usb') return 'Auto: External Soundcard'
  if (source === 'builtin') return 'Auto: MacBook Mic'
  if (source === 'preferred') return 'Manual override'
  return source ? 'Auto' : 'None'
}

function parseJsonLine(line) {
  const text = String(line || '').trim()
  if (!text || text[0] !== '{') return null
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

/**
 * Owns the desktop app state and the two Python child processes.
 *
 * Events: `state` (full snapshot) and `log` ({source, line}).
 */
class DesktopController extends EventEmitter {
  constructor(options = {}) {
    super()
    this.rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'))
    this.configPath = path.resolve(options.configPath || defaultConfigPath())
    this.pythonPath = options.pythonPath || process.env.ROKU_SYNC_PYTHON || 'python3'
    this.spawn = options.spawn || spawn
    this.devicePollMs = options.devicePollMs === undefined ? DEVICE_POLL_MS : options.devicePollMs
    this.config = this.loadConfig()
    this.devices = null
    this.deviceError = null
    this.deviceSource = null
    this.lastDeviceRefresh = null
    this.anc = {
      running: false,
      state: 'stopped',
      error: null,
      notes: [],
      mic_device: null,
      ref_device: null,
      out_device: null,
      delay_ms: 0,
      erle_db: 0,
      confidence: 0,
      double_talk: false,
      samples: 0,
    }
    this.bridge = {
      running: false,
      state: 'stopped',
      error: null,
      roku: null,
      app_name: null,
      position_ms: null,
      commands: 0,
    }
    this.selfTest = { running: false, result: null, error: null }
    this._children = { anc: null, bridge: null, selftest: null }
    this._pollTimer = null
    this._pendingRefresh = null
  }

  // -- config ---------------------------------------------------------------
  loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8')
      this.config = normaliseConfig(JSON.parse(raw))
    } catch (error) {
      this.config = normaliseConfig(null)
    }
    return this.config
  }

  saveConfig(patch = {}) {
    const next = normaliseConfig(Object.assign({}, this.config, patch))
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    const temp = this.configPath + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, this.configPath)
    this.config = next
    this.emit('state', this.snapshot())
    return next
  }

  getConfig() {
    return Object.assign({}, this.config)
  }

  // -- children -------------------------------------------------------------
  _spawnArgv(script, args, extraEnv) {
    return {
      command: this.pythonPath,
      args: [path.join(this.rootDir, script)].concat(args),
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }, extraEnv || {}),
    }
  }

  _launch(slot, script, args, extraEnv, onLine, onExit) {
    const spec = this._spawnArgv(script, args, extraEnv)
    let child
    try {
      child = this.spawn(spec.command, spec.args, {
        cwd: this.rootDir,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      onExit(error, null)
      return null
    }
    this._children[slot] = child
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => onLine(line))
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        const text = String(line || '').trim()
        if (text) {
          this.emit('log', { source: slot, line: text })
        }
      })
    }
    child.on('error', (error) => {
      if (this._children[slot] === child) this._children[slot] = null
      onExit(error, null)
    })
    child.on('exit', (code, signal) => {
      if (this._children[slot] === child) this._children[slot] = null
      onExit(null, { code, signal })
    })
    return child
  }

  _stopChild(slot, graceMs = STOP_GRACE_MS) {
    const child = this._children[slot]
    if (!child) return Promise.resolve()
    this._children[slot] = null
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch (error) {
          /* already gone */
        }
        finish()
      }, graceMs)
      child.once('exit', finish)
      try {
        child.kill('SIGTERM')
      } catch (error) {
        finish()
      }
    })
  }

  // -- devices --------------------------------------------------------------
  _deviceArgs() {
    // `--list-devices` reuses the daemon's own auto-selection, so the desktop
    // app and the CLI can never disagree about which device is active.
    const args = ['--list-devices', '--json']
    if (!this.config.autoPickSoundcard) args.push('--no-prefer-usb')
    if (this.config.preferredMicDevice) args.push('--prefer-mic-device', this.config.preferredMicDevice)
    if (this.config.preferredRefDevice) args.push('--prefer-ref-device', this.config.preferredRefDevice)
    if (this.config.preferredOutDevice) args.push('--prefer-out-device', this.config.preferredOutDevice)
    return args
  }

  _collect(script, args, timeoutMs) {
    const spec = this._spawnArgv(script, args)
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawn(spec.command, spec.args, { cwd: this.rootDir, env: spec.env })
      } catch (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      let finished = false
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        try {
          child.kill('SIGKILL')
        } catch (error) {
          /* already gone */
        }
        reject(new Error(`${script} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk })
      if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`${script} exited with ${code}: ${(stderr || stdout).trim().slice(0, 600)}`))
          return
        }
        resolve(stdout)
      })
    })
  }

  async listDevices() {
    const stdout = await this._collect('aec_daemon.py', this._deviceArgs(), DEVICE_LIST_TIMEOUT_MS)
    const payload = parseJsonLine(stdout) || JSON.parse(stdout)
    return payload
  }

  async refreshDevices() {
    if (this._pendingRefresh) return this._pendingRefresh
    this._pendingRefresh = (async () => {
      try {
        const discovery = await this.listDevices()
        const recommended = discovery.recommended || {}
        this.devices = {
          inputs: Array.isArray(discovery.inputs) ? discovery.inputs : [],
          outputs: Array.isArray(discovery.outputs) ? discovery.outputs : [],
          source: discovery.source || null,
          recommended,
          micBadge: classifyMicSource(recommended.mic_source),
          warnings: Array.isArray(recommended.notes) ? recommended.notes : [],
          blackholeInstalled: Boolean(
            (recommended.virtual_devices || []).some((name) => /blackhole 2ch/i.test(name)),
          ),
          virtualDevices: Array.isArray(recommended.virtual_devices)
            ? recommended.virtual_devices
            : [],
        }
        this.deviceSource = discovery.source || null
        this.deviceError = null
        this.lastDeviceRefresh = Date.now()
        this.anc.mic_device = recommended.mic_device || this.anc.mic_device
        this.anc.ref_device = recommended.ref_device || this.anc.ref_device
        this.anc.out_device = recommended.out_device || this.anc.out_device
      } catch (error) {
        this.deviceError = error.message || String(error)
        this.emit('log', { source: 'devices', line: this.deviceError })
      } finally {
        this._pendingRefresh = null
      }
      this.emit('state', this.snapshot())
      return this.devices
    })()
    return this._pendingRefresh
  }

  startDevicePolling() {
    if (this._pollTimer || !this.devicePollMs) return
    this._pollTimer = setInterval(() => {
      this.refreshDevices().catch(() => {})
    }, this.devicePollMs)
    if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref()
  }

  stopDevicePolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  // -- ANC daemon -----------------------------------------------------------
  ancArgs() {
    // `--live --auto --json` makes the daemon emit one JSON telemetry object per
    // report interval; the preference flags only apply when those devices are
    // actually connected, so unplugging still falls back automatically.
    const args = ['--live', '--auto', '--json']
    if (!this.config.autoPickSoundcard) args.push('--no-prefer-usb')
    if (this.config.preferredMicDevice) args.push('--prefer-mic-device', this.config.preferredMicDevice)
    if (this.config.preferredRefDevice) args.push('--prefer-ref-device', this.config.preferredRefDevice)
    if (this.config.preferredOutDevice) args.push('--prefer-out-device', this.config.preferredOutDevice)
    return args
  }

  startAnc() {
    if (this._children.anc) return { started: false, reason: 'already running' }
    this.anc.running = true
    this.anc.state = 'starting'
    this.anc.error = null
    this.anc.notes = []
    const child = this._launch('anc', 'aec_daemon.py', this.ancArgs(), null,
      (line) => this._onAncLine(line),
      (error, exit) => this._onAncExit(error, exit))
    if (!child) return { started: false, reason: this.anc.error || 'spawn failed' }
    this.emit('state', this.snapshot())
    return { started: true, pid: child.pid }
  }

  _onAncLine(line) {
    this.emit('log', { source: 'anc', line })
    const payload = parseJsonLine(line)
    if (!payload) {
      // A plain-text line means the daemon failed before it could stream JSON.
      if (/sounddevice|Traceback|Error/i.test(line)) this.anc.error = this.anc.error || line
      return
    }
    if (payload.event === 'start') {
      this.anc.state = 'running'
      this.anc.mic_device = payload.mic_device || this.anc.mic_device
      this.anc.ref_device = payload.ref_device || this.anc.ref_device
      this.anc.out_device = payload.out_device || this.anc.out_device
      if (Array.isArray(payload.notes)) this.anc.notes = payload.notes
    } else if (payload.event === 'telemetry' || payload.delay_ms !== undefined) {
      this.anc.state = 'running'
      this.anc.delay_ms = Number(payload.delay_ms || 0)
      this.anc.erle_db = Number(payload.erle_db || 0)
      this.anc.confidence = Number(payload.confidence || 0)
      this.anc.double_talk = Boolean(payload.double_talk)
      this.anc.samples = Number(payload.samples || 0)
      if (payload.mic_device) this.anc.mic_device = payload.mic_device
      if (payload.ref_device) this.anc.ref_device = payload.ref_device
      if (payload.out_device) this.anc.out_device = payload.out_device
    } else if (payload.event === 'stop') {
      this.anc.running = false
      this.anc.state = 'stopped'
    }
    this.emit('state', this.snapshot())
  }

  _onAncExit(error, exit) {
    this.anc.running = false
    if (error) {
      this.anc.state = 'error'
      this.anc.error = error.message || String(error)
    } else if (exit && exit.code !== 0 && exit.code !== null && this.anc.state !== 'stopping') {
      this.anc.state = 'error'
      this.anc.error = this.anc.error || `aec_daemon.py exited with code ${exit.code}`
    } else {
      this.anc.state = 'stopped'
    }
    this.emit('state', this.snapshot())
  }

  async stopAnc() {
    if (!this._children.anc) {
      this.anc.running = false
      this.anc.state = 'stopped'
      this.emit('state', this.snapshot())
      return { stopped: false }
    }
    this.anc.state = 'stopping'
    await this._stopChild('anc')
    this.anc.running = false
    this.anc.state = 'stopped'
    this.anc.double_talk = false
    this.anc.error = null
    this.emit('state', this.snapshot())
    return { stopped: true }
  }

  // -- self test ------------------------------------------------------------
  async runSelfTest() {
    if (this.selfTest.running) return this.selfTest.result
    this.selfTest.running = true
    this.selfTest.error = null
    this.emit('state', this.snapshot())
    const started = Date.now()
    try {
      const stdout = await this._collect('aec_daemon.py', ['--selftest', '--json'],
        SELF_TEST_TIMEOUT_MS)
      // The CLI pretty-prints its result, so parse the whole document first and
      // only fall back to scanning for a single JSON object on noisy output.
      let result = null
      try {
        result = JSON.parse(stdout)
      } catch (error) {
        const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
        for (let index = lines.length - 1; index >= 0 && !result; index -= 1) {
          result = parseJsonLine(lines[index])
        }
      }
      if (!result) throw new Error('self-test returned no JSON')
      result.duration_ms = Date.now() - started
      this.selfTest.result = result
    } catch (error) {
      this.selfTest.error = error.message || String(error)
      this.selfTest.result = null
    } finally {
      this.selfTest.running = false
      this.emit('state', this.snapshot())
    }
    return this.selfTest.result
  }

  // -- Roku bridge ----------------------------------------------------------
  bridgeEnv() {
    return {
      SYNC_SERVER_URL: this.config.serverUrl,
      SYNC_TOKEN: this.config.token,
      ROKU_URL: this.config.rokuUrl,
      ROKU_CLIENT_STATUS_JSON: '1',
    }
  }

  startRokuBridge() {
    if (this._children.bridge) return { started: false, reason: 'already running' }
    this.bridge.running = true
    this.bridge.state = 'connecting'
    this.bridge.error = null
    this.bridge.roku = null
    this.bridge.app_name = null
    this.bridge.position_ms = null
    const child = this._launch('bridge', 'roku_client.py', [], this.bridgeEnv(),
      (line) => this._onBridgeLine(line),
      (error, exit) => this._onBridgeExit(error, exit))
    if (!child) return { started: false, reason: this.bridge.error || 'spawn failed' }
    this.emit('state', this.snapshot())
    return { started: true, pid: child.pid }
  }

  _onBridgeLine(line) {
    this.emit('log', { source: 'bridge', line })
    const payload = parseJsonLine(line)
    if (!payload) return
    if (payload.event === 'start') {
      this.bridge.state = 'connected'
      return
    }
    if (payload.event !== 'status') return
    this.bridge.state = payload.error ? 'error' : 'connected'
    this.bridge.roku = payload.roku || null
    this.bridge.app_name = payload.app_name || null
    this.bridge.position_ms = payload.position_ms === undefined ? null : payload.position_ms
    this.bridge.commands = Number(payload.commands || 0)
    this.bridge.error = payload.error || null
    this.emit('state', this.snapshot())
  }

  _onBridgeExit(error, exit) {
    this.bridge.running = false
    this.bridge.roku = null
    if (error) {
      this.bridge.state = 'error'
      this.bridge.error = error.message || String(error)
    } else if (exit && exit.code && exit.code !== 0) {
      this.bridge.state = 'error'
      this.bridge.error = `roku_client.py exited with code ${exit.code}`
    } else {
      this.bridge.state = 'stopped'
    }
    this.emit('state', this.snapshot())
  }

  async stopRokuBridge() {
    if (!this._children.bridge) {
      this.bridge.running = false
      this.bridge.state = 'stopped'
      this.emit('state', this.snapshot())
      return { stopped: false }
    }
    this.bridge.state = 'stopping'
    await this._stopChild('bridge')
    this.bridge.running = false
    this.bridge.state = 'stopped'
    this.bridge.roku = null
    this.bridge.app_name = null
    this.bridge.position_ms = null
    this.bridge.error = null
    this.emit('state', this.snapshot())
    return { stopped: true }
  }

  // -- snapshot -------------------------------------------------------------
  snapshot() {
    return {
      config: this.getConfig(),
      configPath: this.configPath,
      devices: this.devices,
      deviceError: this.deviceError,
      deviceSource: this.deviceSource,
      lastDeviceRefresh: this.lastDeviceRefresh,
      anc: Object.assign({}, this.anc),
      bridge: Object.assign({}, this.bridge),
      selfTest: Object.assign({}, this.selfTest),
    }
  }

  async dispose() {
    this.stopDevicePolling()
    await Promise.all([this._stopChild('anc'), this._stopChild('bridge')])
    this.removeAllListeners()
  }
}

module.exports = {
  DesktopController,
  DEFAULT_CONFIG,
  DEVICE_POLL_MS,
  defaultConfigPath,
  normaliseConfig,
  classifyMicSource,
  parseJsonLine,
}
