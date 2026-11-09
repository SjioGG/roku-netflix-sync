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
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')

const DEFAULT_CONFIG = Object.freeze({
  serverUrl: process.env.SYNC_SERVER_URL || 'http://127.0.0.1:8766',
  token: process.env.SYNC_TOKEN || '',
  rokuUrl: process.env.ROKU_URL || 'http://192.168.1.100:8060',
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
const ROKU_SCAN_TIMEOUT_MS = 40000
const STOP_GRACE_MS = 3000
const PING_SAMPLES = 5
const PING_SAMPLE_TIMEOUT_MS = 5000
const PING_JITTER_PATTERN = [-1, 0, 1, -0.5, 0.5]
const DEFAULT_PLAYER_TRIM_MS = -300
const MIN_LEAD_MS = 3000
const MAX_LEAD_MS = 15000
const LEAD_BASE_MS = 2000
const LEAD_RTT_FACTOR = 4

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

function relayOrigin(value) {
  const message = 'Use an HTTPS relay origin or localhost HTTP, without credentials, paths or queries.'
  let url
  try { url = new URL(value) } catch { throw new Error(message) }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(message)
  return url.origin
}

function classifyMicSource(source) {
  if (source === 'usb') return 'Auto: External Soundcard'
  if (source === 'builtin') return 'Auto: MacBook Mic'
  if (source === 'preferred') return 'Manual override'
  return source ? 'Auto' : 'None'
}

function describePingMath(result) {
  // One string the UI can drop into a `<pre>`: it names every input and the
  // exact arithmetic that decides the two fire times.
  const mode = result.mode === 'japan_simulation'
    ? `Japan simulation (+${result.simulated_added_rtt_ms} ms RTT, ±${result.simulated_jitter_ms} ms jitter)`
    : 'Live measurement'
  const best = (result.samples || []).find((sample) => sample.selected)
  const bestIndex = best ? best.index : '-'
  return [
    `Mode: ${mode} · ${result.server_url}`,
    `Best network RTT ${result.best_rtt_ms} ms (sample #${bestIndex} of ${(result.samples || []).length}), `
      + `jitter ${result.jitter_ms} ms, one-way ${result.one_way_network_ms} ms.`,
    `Clock offset ${result.clock_offset_ms} ms = round(server_mid - client_mid), where `
      + `server_mid = (received_ms + server_ms) / 2 and client_mid = wall_start + total_rtt / 2.`,
    `Adaptive lead ${result.adaptive_lead_ms} ms = clamp(2000 + best_RTT × 4, 3000, 15000).`,
    `Roku LAN one-way ${result.roku_one_way_ms} ms = (poll ${result.roku_poll_ms} + toggle ${result.roku_toggle_ms}) / 2; `
      + `effective Roku lead ${result.effective_roku_lead_ms} ms = player trim ${result.player_trim_ms} + ${result.roku_one_way_ms}.`,
    `Server fires Roku /keypress/Play at t=${result.roku_fire_at_ms} ms `
      + `(= lead ${result.adaptive_lead_ms} − effective lead ${result.effective_roku_lead_ms}).`,
    `Chrome fires video.play() at t=${result.chrome_fire_at_ms} ms on its own clock `
      + `(= lead, shifted by the ${result.clock_offset_ms} ms offset).`,
    'Target: 500 ms tolerance. These timing estimates do not prove displayed-frame alignment.',
  ].join('\n')
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
    this.rokuDevices = []
    this.rokuScanCandidates = 0
    this.lastRokuScan = null
    this.rokuScanError = null
    this.pingTest = { running: false, result: null, error: null }
    this._children = { anc: null, bridge: null, selftest: null }
    this._pollTimer = null
    this._pendingRefresh = null
    this._pendingScan = null
  }

  // -- config ---------------------------------------------------------------
  loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8')
      this.config = normaliseConfig(JSON.parse(raw))
      this.configLoadedFromDisk = true
    } catch (error) {
      this.config = normaliseConfig(null)
      this.configLoadedFromDisk = false
    }
    return this.config
  }

  saveConfig(patch = {}) {
    const next = normaliseConfig(Object.assign({}, this.config, patch))
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 })
    const temp = this.configPath + '.' + randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, this.configPath)
    } finally {
      fs.rmSync(temp, { force: true })
    }
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
      SYNC_SERVER_URL: relayOrigin(this.config.serverUrl),
      SYNC_TOKEN: this.config.token,
      ROKU_URL: this.config.rokuUrl,
      ROKU_CLIENT_STATUS_JSON: '1',
    }
  }

  startRokuBridge() {
    if (this._children.bridge) return { started: false, reason: 'already running' }
    let env
    try { env = this.bridgeEnv() } catch (error) {
      this.bridge.state = 'error'
      this.bridge.error = error.message
      this.emit('state', this.snapshot())
      return { started: false, reason: error.message }
    }
    this.bridge.running = true
    this.bridge.state = 'connecting'
    this.bridge.error = null
    this.bridge.roku = null
    this.bridge.app_name = null
    this.bridge.position_ms = null
    const child = this._launch('bridge', 'roku_client.py', [], env,
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

  // -- Roku LAN discovery ---------------------------------------------------
  async scanRokuDevices() {
    // A LAN scan costs at most one short round trip per candidate, so it is
    // cheap enough to run on startup next to the audio-device refresh.
    if (this._pendingScan) return this._pendingScan
    this._pendingScan = (async () => {
      try {
        const args = ['--discover', '--json']
        if (this.config.rokuUrl) args.push('--seed-url', this.config.rokuUrl)
        const stdout = await this._collect('roku_client.py', args, ROKU_SCAN_TIMEOUT_MS)
        const payload = JSON.parse(stdout)
        this.rokuDevices = Array.isArray(payload.devices) ? payload.devices : []
        this.rokuScanCandidates = Number(payload.scanned_candidates
          || this.rokuDevices.length) || 0
        this.rokuScanError = null
        this.lastRokuScan = Date.now()
      } catch (error) {
        this.rokuDevices = []
        this.rokuScanError = error.message || String(error)
        this.emit('log', { source: 'roku-scan', line: this.rokuScanError })
      } finally {
        this._pendingScan = null
      }
      this.emit('state', this.snapshot())
      return { devices: this.rokuDevices, error: this.rokuScanError }
    })()
    return this._pendingScan
  }

  // -- server ping / RTT ----------------------------------------------------
  _clockRequest(timeoutMs) {
    // Node's http/https keeps the timing measurement honest: `fetch` hides
    // parts of the connection setup that the RTT figure is supposed to include.
    return new Promise((resolve, reject) => {
      let target
      try {
        target = new URL('/clock', relayOrigin(this.config.serverUrl))
      } catch (error) {
        reject(error)
        return
      }
      const transport = target.protocol === 'https:' ? require('node:https') : require('node:http')
      const headers = { Accept: 'application/json' }
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`
      const request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers,
      }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          resolve({ status: response.statusCode || 0, body })
        })
      })
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`/clock timed out after ${timeoutMs} ms`))
      })
      request.on('error', reject)
      request.end()
    })
  }

  async pingServer(options = {}) {
    const samplesRequested = Number(options.samples === undefined ? PING_SAMPLES : options.samples)
    const sampleCount = Math.max(1, Math.min(20, Number.isFinite(samplesRequested) ? samplesRequested : PING_SAMPLES))
    const simulateAddedRttMs = Number(options.simulateAddedRttMs || 0)
    const simulateJitterMs = Number(options.simulateJitterMs || 0)
    const simulateClockSkewMs = Number(options.simulateClockSkewMs || 0)
    const playerTrimMs = options.playerTrimMs === undefined
      ? DEFAULT_PLAYER_TRIM_MS
      : Number(options.playerTrimMs)

    this.pingTest = { running: true, result: this.pingTest.result, error: null }
    this.emit('state', this.snapshot())

    const samples = []
    let lastData = null
    try {
      for (let index = 1; index <= sampleCount; index += 1) {
        const wallStart = Date.now()
        const started = performance.now()
        const response = await this._clockRequest(PING_SAMPLE_TIMEOUT_MS)
        const rawRtt = performance.now() - started
        if (response.status === 401) {
          throw new Error('401 Unauthorized — check Room Token or wait for nixos deploy')
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`/clock returned HTTP ${response.status}`)
        }
        let data
        try {
          data = JSON.parse(response.body)
        } catch (error) {
          throw new Error('/clock returned invalid JSON')
        }
        lastData = data
        const receivedMs = Number(data.received_ms === undefined ? data.server_ms : data.received_ms)
        const serverMs = Number(data.server_ms)
        if (!Number.isFinite(receivedMs) || !Number.isFinite(serverMs)) {
          throw new Error('/clock did not report server_ms')
        }

        // A simulated far-away client adds a deterministic, bounded delay per
        // sample so the jitter figure moves the same way it would across the
        // Pacific instead of sitting at exactly zero.
        let addedRttMs = 0
        if (simulateAddedRttMs > 0) {
          const pattern = PING_JITTER_PATTERN[index % PING_JITTER_PATTERN.length]
          addedRttMs = simulateAddedRttMs + simulateJitterMs * pattern
        }
        const totalRttMs = rawRtt + addedRttMs
        const serverMid = (receivedMs + serverMs) / 2 + simulateClockSkewMs
        const clientMid = wallStart + totalRttMs / 2
        const offsetMs = Math.round(serverMid - clientMid)
        // Whatever part of the trip the server itself spent handling the
        // request is not network latency, so it never counts towards the lead.
        const networkRttMs = Math.max(0, totalRttMs - Math.max(0, serverMs - receivedMs))
        samples.push({
          index,
          raw_rtt_ms: Math.round(rawRtt * 10) / 10,
          added_rtt_ms: Math.round(addedRttMs * 10) / 10,
          total_rtt_ms: Math.round(totalRttMs * 10) / 10,
          network_rtt_ms: Math.round(networkRttMs * 10) / 10,
          offset_ms: offsetMs,
          selected: false,
        })
      }

      // Lowest network RTT wins, exactly like `extension/content.js`: the
      // least-congested sample is the one that predicts the next request best.
      let best = samples[0]
      for (const sample of samples) {
        if (sample.network_rtt_ms < best.network_rtt_ms) best = sample
      }
      best.selected = true

      const rtts = samples.map((sample) => sample.network_rtt_ms)
      const minRtt = Math.min.apply(null, rtts)
      const maxRtt = Math.max.apply(null, rtts)
      const avgRtt = rtts.reduce((sum, value) => sum + value, 0) / rtts.length
      const rokuPollMs = Number((lastData && lastData.roku_poll_ms) ?? 15)
      const rokuToggleMs = Number((lastData && lastData.roku_toggle_ms) ?? 40)
      const rokuOneWayMs = Math.round((rokuPollMs + rokuToggleMs) / 2)
      const effectiveRokuLeadMs = Math.round(playerTrimMs + rokuOneWayMs)
      const adaptiveLeadMs = Math.min(MAX_LEAD_MS,
        Math.max(MIN_LEAD_MS, Math.ceil(LEAD_BASE_MS + best.total_rtt_ms * LEAD_RTT_FACTOR)))
      const rokuFireAtMs = adaptiveLeadMs - effectiveRokuLeadMs
      const oneWayNetworkMs = Math.round((best.network_rtt_ms / 2) * 10) / 10

      const result = {
        mode: simulateAddedRttMs > 0 ? 'japan_simulation' : 'live',
        server_url: this.config.serverUrl,
        samples,
        best_rtt_ms: Math.round(best.network_rtt_ms * 10) / 10,
        avg_rtt_ms: Math.round(avgRtt * 10) / 10,
        min_rtt_ms: Math.round(minRtt * 10) / 10,
        max_rtt_ms: Math.round(maxRtt * 10) / 10,
        jitter_ms: Math.round((maxRtt - minRtt) * 10) / 10,
        one_way_network_ms: oneWayNetworkMs,
        clock_offset_ms: best.offset_ms,
        roku_poll_ms: rokuPollMs,
        roku_toggle_ms: rokuToggleMs,
        roku_one_way_ms: rokuOneWayMs,
        player_trim_ms: playerTrimMs,
        effective_roku_lead_ms: effectiveRokuLeadMs,
        adaptive_lead_ms: adaptiveLeadMs,
        roku_fire_at_ms: rokuFireAtMs,
        chrome_fire_at_ms: adaptiveLeadMs,
        simulated_added_rtt_ms: simulateAddedRttMs,
        simulated_jitter_ms: simulateJitterMs,
        simulated_clock_skew_ms: simulateClockSkewMs,
        measured_at: Date.now(),
        formula_summary: '',
      }
      result.formula_summary = describePingMath(result)
      this.pingTest = { running: false, result, error: null }
      this.emit('state', this.snapshot())
      return result
    } catch (error) {
      this.pingTest = { running: false, result: null, error: error.message || String(error) }
      this.emit('state', this.snapshot())
      return this.pingTest
    }
  }

  // -- snapshot -------------------------------------------------------------
  snapshot() {
    const config = this.getConfig()
    delete config.token
    return {
      config,
      tokenConfigured: Boolean(this.config.token),
      configPath: this.configPath,
      configLoadedFromDisk: Boolean(this.configLoadedFromDisk),
      tokenFromConfigFile: Boolean(this.configLoadedFromDisk && this.config.token),
      devices: this.devices,
      deviceError: this.deviceError,
      deviceSource: this.deviceSource,
      lastDeviceRefresh: this.lastDeviceRefresh,
      anc: Object.assign({}, this.anc),
      bridge: Object.assign({}, this.bridge),
      selfTest: Object.assign({}, this.selfTest),
      rokuDevices: this.rokuDevices.slice(),
      lastRokuScan: this.lastRokuScan,
      rokuScanError: this.rokuScanError,
      pingTest: Object.assign({}, this.pingTest),
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
  PING_SAMPLES,
  DEFAULT_PLAYER_TRIM_MS,
  MIN_LEAD_MS,
  MAX_LEAD_MS,
  defaultConfigPath,
  normaliseConfig,
  classifyMicSource,
  describePingMath,
  parseJsonLine,
}
