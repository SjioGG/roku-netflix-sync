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
  autoMirrorChrome: true,
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
// The echo canceller works best when Chrome's silent copy plays this far ahead
// of the TV (measured on a real Roku TV: ~25 dB at 100-250 ms, 4-6 dB at 0-50 ms).
const ACOUSTIC_TARGET_LEAD_MS = 200
const ACOUSTIC_FRESH_MS = 4000
const MIN_LEAD_MS = 3000
const MAX_LEAD_MS = 15000
const LEAD_BASE_MS = 2000
const LEAD_RTT_FACTOR = 4
const MIRROR_POLL_MS = 2500
const LOCAL_ROKU_POLL_MS = 800
const CHROME_TAP_DEVICE_NAME = 'Chrome Audio Tap (Auto-mute in room)'
const STREAMING_APPS_BY_ID = Object.freeze({
  '12': { name: 'Netflix', slug: 'netflix' },
  '837': { name: 'YouTube', slug: 'youtube' },
  '13535': { name: 'Plex', slug: 'plex' },
  '13': { name: 'Prime Video', slug: 'primevideo' },
  '291097': { name: 'Disney Plus', slug: 'disneyplus' },
  '61322': { name: 'HBO Max', slug: 'max' },
  '551012': { name: 'Apple TV', slug: 'appletv' },
  '2285': { name: 'Hulu', slug: 'hulu' },
  '624064': { name: 'Nebula', slug: 'nebula' },
  '817397': { name: 'Twitch', slug: 'twitch' },
})

function parseRokuMediaPlayerXml(xml) {
  const text = String(xml || '')
  const playerMatch = /<player\b[^>]*\bstate="([^"]+)"/i.exec(text)
  if (!playerMatch) return null
  const state = playerMatch[1]
  const pluginTag = /<plugin\b([^>]*)\/?>/i.exec(text)
  let appId = null
  let pluginName = null
  if (pluginTag) {
    const idMatch = /\bid="([^"]+)"/i.exec(pluginTag[1])
    const nameMatch = /\bname="([^"]+)"/i.exec(pluginTag[1])
    if (idMatch) appId = idMatch[1]
    if (nameMatch) pluginName = nameMatch[1].replace(/&amp;/g, '&')
  }
  const posMatch = /<position>\s*(\d+)\s*ms\s*<\/position>/i.exec(text)
  const positionMs = posMatch ? Number(posMatch[1]) : null
  const known = appId ? STREAMING_APPS_BY_ID[appId] : null
  return {
    roku: state,
    appId,
    appSlug: known ? known.slug : null,
    appName: known ? known.name : (pluginName && appId !== 'native-ui' ? pluginName : null),
    positionMs,
  }
}

function buildReferenceWatchUrl(app, titleId) {
  if (!app || !titleId) return null
  if (app === 'youtube' && /^[A-Za-z0-9_-]{6,20}$/.test(titleId)
      && titleId !== 'youtube-session' && titleId !== 'youtube-shorts') {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(titleId)}#roku-sync-ref`
  }
  if (app === 'netflix' && /^[A-Za-z0-9_-]{1,64}$/.test(titleId)) {
    return `https://www.netflix.com/watch/${encodeURIComponent(titleId)}#roku-sync-ref`
  }
  return null
}

function appSlugFromRoom(room) {
  if (!room) return null
  if (room.app_id && STREAMING_APPS_BY_ID[room.app_id]) return STREAMING_APPS_BY_ID[room.app_id].slug
  if (room.app_name === 'Netflix') return 'netflix'
  if (room.app_name === 'YouTube') return 'youtube'
  if (room.app_name === 'Plex') return 'plex'
  if (!room.app_id && !room.app_name) return (room.chrome && room.chrome.app) || null
  return null
}

function parseMediaLaunchUrl(rawUrl) {
  let parsed
  try { parsed = new URL(String(rawUrl || '').trim()) } catch {
    throw new Error('Paste a full YouTube or Netflix watch URL (https://...).')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS streaming URLs are supported.')
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'youtu.be') {
    const id = parsed.pathname.replace(/^\/+/, '').split('/')[0]
    if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      return {
        app: 'youtube',
        appName: 'YouTube',
        appId: '837',
        titleId: id,
        chromeUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        ecpPath: `/launch/837?contentId=${encodeURIComponent(id)}&mediaType=live`,
      }
    }
  }
  if (/(^|\.)youtube\.com$/.test(host)) {
    const v = parsed.searchParams.get('v')
    const shorts = /^\/shorts\/([A-Za-z0-9_-]{6,20})/.exec(parsed.pathname)
    const id = (v && /^[A-Za-z0-9_-]{6,20}$/.test(v) ? v : null) || (shorts && shorts[1])
    if (id) {
      return {
        app: 'youtube',
        appName: 'YouTube',
        appId: '837',
        titleId: id,
        chromeUrl: parsed.toString(),
        ecpPath: `/launch/837?contentId=${encodeURIComponent(id)}&mediaType=live`,
      }
    }
  }
  if (/(^|\.)netflix\.com$/.test(host)) {
    const watch = /^\/watch\/([A-Za-z0-9_-]{1,64})/.exec(parsed.pathname)
    if (watch) {
      const id = watch[1]
      return {
        app: 'netflix',
        appName: 'Netflix',
        appId: '12',
        titleId: id,
        chromeUrl: parsed.toString(),
        ecpPath: `/launch/12?contentID=${encodeURIComponent(id)}&mediaType=episode`,
      }
    }
  }
  throw new Error('Supported quick-mirror links: YouTube watch/shorts URLs and Netflix /watch/<id> URLs.')
}

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
/**
 * Abort ``req`` after ``ms`` of wall time. ``req.setTimeout`` only counts idle
 * time on a connected socket, so an unreachable host would hang until the OS
 * gives up (about 5 s on macOS) instead.
 */
function armDeadline(req, ms, message) {
  const timer = setTimeout(() => req.destroy(new Error(message)), ms)
  if (typeof timer.unref === 'function') timer.unref()
  req.once('close', () => clearTimeout(timer))
}

class DesktopController extends EventEmitter {
  constructor(options = {}) {
    super()
    this.rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'))
    this.configPath = path.resolve(options.configPath || defaultConfigPath())
    this.pythonPath = options.pythonPath || process.env.ROKU_SYNC_PYTHON || 'python3'
    this.spawn = options.spawn || spawn
    this.platform = options.platform || process.platform
    this.devicePollMs = options.devicePollMs === undefined ? DEVICE_POLL_MS : options.devicePollMs
    this.mirrorPollMs = options.mirrorPollMs === undefined
      ? (process.env.ROKU_SYNC_TEST_OFFLINE === '1' ? 0 : MIRROR_POLL_MS)
      : options.mirrorPollMs
    this.localRokuPollMs = options.localRokuPollMs === undefined
      ? (process.env.ROKU_SYNC_TEST_OFFLINE === '1' ? 0 : LOCAL_ROKU_POLL_MS)
      : options.localRokuPollMs
    this.referenceProfileDir = path.resolve(options.referenceProfileDir
      || process.env.ROKU_SYNC_REFERENCE_PROFILE
      || path.join(os.homedir(), 'Library', 'Application Support', 'Roku Sync', 'Reference Chrome'))
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
      ref_rms_db: -90,
      mic_rms_db: -90,
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
    this.micPreview = {
      running: false,
      phase: 'idle',
      clipId: null,
      elapsedMs: 0,
      totalMs: 5000,
      refRmsDb: -90,
      micRmsDb: -90,
      cleanRmsDb: -90,
      result: null,
      error: null,
    }
    this.rokuDevices = []
    this.rokuScanCandidates = 0
    this.rokuLocalNetworkBlocked = false
    this.lastRokuScan = null
    this.rokuScanError = null
    this.pingTest = { running: false, result: null, error: null }
    this.mirror = {
      state: 'idle',
      mode: null,
      app: null,
      titleId: null,
      positionMs: null,
      paused: null,
      driftMs: null,
      detail: null,
    }
    this._children = { anc: null, bridge: null, selftest: null, preview: null }
    this._previewDir = null
    this._previewFiles = { clipId: null, cleanPath: null, rawPath: null }
    this._pollTimer = null
    this._localRokuTimer = null
    this._localRokuInFlight = null
    this._localRoku = {
      roku: null,
      appId: null,
      appSlug: null,
      appName: null,
      rawPositionMs: null,
      anchorPosMs: null,
      anchorAtMs: 0,
      posFresh: false,
      updatedAtMs: 0,
    }
    this._desiredMirror = { app: null, titleId: null, at: 0 }
    this._acoustic = { leadMs: null, targetLeadMs: ACOUSTIC_TARGET_LEAD_MS, score: 0, seq: 0, at: 0 }
    this._relayMaster = null
    this._localMirrorClient = null
    this._autoOpenedKeys = new Set()
    this._mirrorTimer = null
    this._mirrorCheckInFlight = null
    this._mirrorSeenTarget = { key: null, since: 0 }
    this._lastMirrorOpen = { key: null, at: 0 }
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
  tapEnv() {
    return { ROKU_SYNC_REFERENCE_PROFILE: this.referenceProfileDir }
  }

  _spawnArgv(script, args, extraEnv) {
    return {
      command: this.pythonPath,
      args: [path.join(this.rootDir, script)].concat(args),
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }, extraEnv || {}),
    }
  }

  _launch(slot, script, args, extraEnv, onLine, onExit) {
    const spec = this._spawnArgv(script, args, extraEnv)
    let child
    try {
      child = this.spawn(spec.command, spec.args, {
        cwd: this.rootDir,
        env: spec.env,
        stdio: [slot === 'anc' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      onExit(error, null)
      return null
    }
    this._children[slot] = child
    const stderrLines = []
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => onLine(line))
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        const text = String(line || '').trim()
        if (text) {
          stderrLines.push(text)
          if (stderrLines.length > 12) stderrLines.shift()
          this.emit('log', { source: slot, line: text })
        }
      })
    }
    child.on('error', (error) => {
      if (this._children[slot] === child) this._children[slot] = null
      onExit(error, null)
    })
    // close follows the final stderr data, unlike exit, which can race it.
    child.on('close', (code, signal) => {
      if (this._children[slot] === child) this._children[slot] = null
      if (slot === 'anc' && code && this.anc.state !== 'stopping' && stderrLines.length) {
        this.anc.error = stderrLines.join('\n').slice(-2000)
      }
      if (slot === 'preview' && code && this.micPreview.phase !== 'stopping' && stderrLines.length) {
        this.micPreview.error = stderrLines.join('\n').slice(-2000)
      }
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
    if (!this._pollTimer && this.devicePollMs) {
      this._pollTimer = setInterval(() => {
        this.refreshDevices().catch(() => {})
      }, this.devicePollMs)
      if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref()
    }
    this.startLocalRokuPolling()
  }

  stopDevicePolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    this.stopLocalRokuPolling()
  }

  // -- ANC daemon -----------------------------------------------------------
  ancArgs() {
    // `--live --auto --json` makes the daemon emit one JSON telemetry object per
    // report interval; the preference flags only apply when those devices are
    // actually connected, so unplugging still falls back automatically.
    // 10 ms blocks match WebRTC AEC3 frames and keep voice latency low.
    const args = ['--live', '--auto', '--json', '--block', '160']
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
    // A new daemon numbers its lag measurements from zero again.
    this._acoustic = { leadMs: null, targetLeadMs: ACOUSTIC_TARGET_LEAD_MS, score: 0, seq: 0, at: 0 }
    this._acousticSession = randomUUID()
    this.anc.acoustic_lead_ms = null
    this.anc.mic_delay_ms = null
    const child = this._launch('anc', 'aec_daemon.py', this.ancArgs(), this.tapEnv(),
      (line) => this._onAncLine(line),
      (error, exit) => this._onAncExit(error, exit))
    if (!child) return { started: false, reason: this.anc.error || 'spawn failed' }
    this.startMirrorPolling()
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
    if (payload.event === 'preview_start' || payload.event === 'preview_progress'
        || payload.event === 'preview_done') {
      this._onPreviewPayload(payload)
      return
    }
    if (payload.event === 'start') {
      this.anc.state = 'running'
      this.anc.mic_device = payload.mic_device || this.anc.mic_device
      this.anc.ref_device = payload.ref_device || this.anc.ref_device
      this.anc.out_device = payload.out_device || this.anc.out_device
      if (Array.isArray(payload.notes)) this.anc.notes = payload.notes
    } else if (payload.event === 'telemetry' || (!payload.event && payload.delay_ms !== undefined)) {
      this.anc.state = 'running'
      this.anc.delay_ms = Number(payload.delay_ms || 0)
      this.anc.erle_db = Number(payload.erle_db || 0)
      if (payload.ref_rms_db !== undefined) this.anc.ref_rms_db = Number(payload.ref_rms_db)
      if (payload.mic_rms_db !== undefined) this.anc.mic_rms_db = Number(payload.mic_rms_db)
      this.anc.confidence = Number(payload.confidence || 0)
      this.anc.double_talk = Boolean(payload.double_talk)
      this.anc.samples = Number(payload.samples || 0)
      if (payload.engine) this.anc.engine = String(payload.engine)
      if (payload.mic_delay_ms !== undefined) this.anc.mic_delay_ms = Number(payload.mic_delay_ms || 0)
      const seq = Number(payload.acoustic_measurements || 0)
      if (Number.isFinite(Number(payload.acoustic_lead_ms)) && payload.acoustic_lead_ms !== null
          && seq > (this._acoustic.seq || 0)) {
        this._acoustic = {
          leadMs: Number(payload.acoustic_lead_ms),
          targetLeadMs: Number(payload.target_lead_ms || ACOUSTIC_TARGET_LEAD_MS),
          score: Number(payload.acoustic_score || 0),
          seq,
          at: Date.now(),
        }
        this.anc.acoustic_lead_ms = this._acoustic.leadMs
      } else if (this._acoustic.at && (Date.now() - this._acoustic.at) > 2 * ACOUSTIC_FRESH_MS) {
        // The mic stopped matching the reference: a different video on the
        // TV (autoplay), an ad, or the TV is muted.
        this.anc.acoustic_lead_ms = null
      }
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
    this.stopMirrorPolling()
    if (this.micPreview.running && !this._children.preview) {
      this.micPreview.running = false
      this.micPreview.phase = 'idle'
    }
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
    this.stopMirrorPolling()
    await this._stopChild('anc')
    this.anc.running = false
    this.anc.state = 'stopped'
    this.anc.double_talk = false
    this.anc.ref_rms_db = -90
    this.anc.mic_rms_db = -90
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

  // -- Discord-style mic playback preview -----------------------------------
  _ensurePreviewDir() {
    if (!this._previewDir || !fs.existsSync(this._previewDir)) {
      this._previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-sync-preview-'))
      fs.chmodSync(this._previewDir, 0o700)
    }
    return this._previewDir
  }

  _previewArgs(clipId, seconds, cleanPath, rawPath) {
    const args = [
      '--preview', '--auto', '--json',
      '--preview-id', clipId,
      '--preview-seconds', String(seconds),
      '--preview-clean-wav', cleanPath,
      '--preview-raw-wav', rawPath,
    ]
    if (!this.config.autoPickSoundcard) args.push('--no-prefer-usb')
    if (this.config.preferredMicDevice) args.push('--prefer-mic-device', this.config.preferredMicDevice)
    if (this.config.preferredRefDevice) args.push('--prefer-ref-device', this.config.preferredRefDevice)
    if (this.config.preferredOutDevice) args.push('--prefer-out-device', this.config.preferredOutDevice)
    return args
  }

  startMicPreview(options = {}) {
    if (this.micPreview.running) return { started: false, reason: 'already recording' }
    const requested = Number(options.seconds === undefined ? 5 : options.seconds)
    const seconds = Math.max(1, Math.min(15, Number.isFinite(requested) ? requested : 5))
    const dir = this._ensurePreviewDir()
    const clipId = randomUUID()
    const cleanPath = path.join(dir, 'clean.wav')
    const rawPath = path.join(dir, 'raw.wav')
    fs.rmSync(cleanPath, { force: true })
    fs.rmSync(rawPath, { force: true })
    this._previewFiles = { clipId, cleanPath, rawPath }
    this.micPreview = {
      running: true,
      phase: 'recording',
      clipId,
      elapsedMs: 0,
      totalMs: Math.round(seconds * 1000),
      refRmsDb: -90,
      micRmsDb: -90,
      cleanRmsDb: -90,
      result: null,
      error: null,
    }

    const ancChild = this._children.anc
    if (ancChild && this.anc.state === 'running' && ancChild.stdin && !ancChild.stdin.destroyed) {
      try {
        ancChild.stdin.write(JSON.stringify({
          cmd: 'preview',
          id: clipId,
          seconds,
          clean_wav: cleanPath,
          raw_wav: rawPath,
        }) + '\n')
        this.emit('state', this.snapshot())
        return { started: true, mode: 'live', clipId }
      } catch (error) {
        /* fall back to standalone capture if stdin closed */
      }
    }

    const child = this._launch('preview', 'aec_daemon.py',
      this._previewArgs(clipId, seconds, cleanPath, rawPath), this.tapEnv(),
      (line) => this._onPreviewLine(line),
      (error, exit) => this._onPreviewExit(error, exit))
    if (!child) {
      this.micPreview.running = false
      this.micPreview.phase = 'error'
      this.micPreview.error = this.micPreview.error || 'Could not start microphone preview'
      this.emit('state', this.snapshot())
      return { started: false, reason: this.micPreview.error }
    }
    this.emit('state', this.snapshot())
    return { started: true, mode: 'standalone', clipId, pid: child.pid }
  }

  _onPreviewLine(line) {
    this.emit('log', { source: 'preview', line })
    const payload = parseJsonLine(line)
    if (!payload) {
      if (/sounddevice|Traceback|Error|No microphone/i.test(line)) {
        this.micPreview.error = this.micPreview.error || line
      }
      return
    }
    this._onPreviewPayload(payload)
  }

  _onPreviewPayload(payload) {
    if (payload.event === 'preview_start') {
      this.micPreview.running = true
      this.micPreview.phase = 'recording'
      this.micPreview.clipId = payload.id || this.micPreview.clipId
      this.micPreview.totalMs = Number(payload.total_ms || this.micPreview.totalMs)
      this.micPreview.elapsedMs = 0
      this.micPreview.error = null
    } else if (payload.event === 'preview_progress') {
      this.micPreview.running = true
      this.micPreview.phase = 'recording'
      this.micPreview.elapsedMs = Number(payload.elapsed_ms || 0)
      this.micPreview.totalMs = Number(payload.total_ms || this.micPreview.totalMs)
      this.micPreview.refRmsDb = Number(payload.ref_rms_db ?? -90)
      this.micPreview.micRmsDb = Number(payload.mic_rms_db ?? -90)
      this.micPreview.cleanRmsDb = Number(payload.clean_rms_db ?? -90)
    } else if (payload.event === 'preview_done') {
      const summary = Object.assign({}, payload)
      delete summary.clean_wav
      delete summary.raw_wav
      delete summary.event
      this.micPreview = {
        running: false,
        phase: 'ready',
        clipId: payload.id || this._previewFiles.clipId,
        elapsedMs: Number(payload.duration_ms || this.micPreview.totalMs),
        totalMs: Number(payload.duration_ms || this.micPreview.totalMs),
        refRmsDb: Number(payload.ref_rms_db ?? -90),
        micRmsDb: Number(payload.mic_rms_db ?? -90),
        cleanRmsDb: Number(payload.clean_rms_db ?? -90),
        result: summary,
        error: null,
      }
    }
    this.emit('state', this.snapshot())
  }

  _onPreviewExit(error, exit) {
    if (!this.micPreview.running && this.micPreview.phase === 'ready') {
      this.emit('state', this.snapshot())
      return
    }
    this.micPreview.running = false
    if (error) {
      this.micPreview.phase = 'error'
      this.micPreview.error = error.message || String(error)
    } else if (exit && exit.code !== 0 && exit.code !== null && this.micPreview.phase !== 'stopping') {
      this.micPreview.phase = 'error'
      this.micPreview.error = this.micPreview.error || `Preview exited with code ${exit.code}`
    } else if (this.micPreview.phase !== 'ready') {
      this.micPreview.phase = 'idle'
    }
    this.emit('state', this.snapshot())
  }

  async stopMicPreview() {
    if (!this.micPreview.running) return { stopped: false }
    this.micPreview.phase = 'stopping'
    if (this._children.preview) {
      await this._stopChild('preview')
    } else if (this._children.anc && this._children.anc.stdin && !this._children.anc.stdin.destroyed) {
      try {
        this._children.anc.stdin.write(JSON.stringify({ cmd: 'preview_stop' }) + '\n')
      } catch (error) {
        /* ignore */
      }
      const deadline = Date.now() + 1000
      while (this.micPreview.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    if (this.micPreview.running) {
      this.micPreview.running = false
      if (this.micPreview.phase !== 'ready') this.micPreview.phase = 'idle'
    }
    this.emit('state', this.snapshot())
    return { stopped: true }
  }

  getMicPreviewAudio() {
    const { clipId, cleanPath, rawPath } = this._previewFiles
    if (!clipId || !cleanPath || !fs.existsSync(cleanPath)) {
      return { clipId: null, cleanDataUrl: null, rawDataUrl: null }
    }
    const cleanDataUrl = 'data:audio/wav;base64,' + fs.readFileSync(cleanPath).toString('base64')
    const rawDataUrl = rawPath && fs.existsSync(rawPath)
      ? 'data:audio/wav;base64,' + fs.readFileSync(rawPath).toString('base64')
      : null
    return { clipId, cleanDataUrl, rawDataUrl }
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
    if (!payload.error && payload.roku && payload.roku !== 'unavailable' && payload.roku !== 'error') {
      const known = payload.app_id ? STREAMING_APPS_BY_ID[payload.app_id] : null
      this._applyLocalRokuReading({
        roku: payload.roku,
        appId: payload.app_id || null,
        appSlug: known ? known.slug : (payload.app_name === 'Netflix' ? 'netflix' : payload.app_name === 'YouTube' ? 'youtube' : null),
        appName: payload.app_name || (known && known.name) || null,
        positionMs: payload.position_ms === undefined ? null : payload.position_ms,
      }, false)
    }
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
        this.rokuLocalNetworkBlocked = Boolean(payload.local_network_blocked)
        this.rokuScanError = null
        this.lastRokuScan = Date.now()
      } catch (error) {
        this.rokuDevices = []
        this.rokuLocalNetworkBlocked = false
        this.rokuScanError = error.message || String(error)
        this.emit('log', { source: 'roku-scan', line: this.rokuScanError })
      } finally {
        this._pendingScan = null
      }
      this.emit('state', this.snapshot())
      return {
        devices: this.rokuDevices,
        error: this.rokuScanError,
        localNetworkBlocked: this.rokuLocalNetworkBlocked,
      }
    })()
    return this._pendingScan
  }

  async rescanAll() {
    await Promise.all([this.refreshDevices(), this.scanRokuDevices()])
    return this.snapshot()
  }

  _applyLocalRokuReading(reading, updateIdleBridge = true) {
    if (!reading) return
    const now = Date.now()
    const prev = this._localRoku
    let anchorPosMs = prev.anchorPosMs
    let anchorAtMs = prev.anchorAtMs
    let posFresh = prev.posFresh
    if (prev.appId && reading.appId && prev.appId !== reading.appId) {
      anchorPosMs = null
      anchorAtMs = 0
      posFresh = false
    }
    if (Number.isFinite(reading.positionMs)) {
      const posChanged = reading.positionMs !== prev.rawPositionMs
      const enteredPlay = prev.roku !== 'play' && reading.roku === 'play'
      const enteredPause = prev.roku === 'play' && reading.roku === 'pause'
      if (posChanged || enteredPlay || anchorPosMs === null) {
        anchorPosMs = reading.positionMs
        anchorAtMs = now
        posFresh = true
      } else if (enteredPause && anchorPosMs !== null) {
        anchorPosMs += Math.max(0, now - anchorAtMs)
        anchorAtMs = now
        posFresh = false
      }
    } else if (reading.roku === 'none' || reading.roku === 'close') {
      anchorPosMs = null
      anchorAtMs = 0
      posFresh = false
    }

    const livePos = this._extrapolatedRokuPosition({
      roku: reading.roku,
      anchorPosMs,
      anchorAtMs,
    }, now)

    this._localRoku = {
      roku: reading.roku,
      appId: reading.appId || null,
      appSlug: reading.appSlug || null,
      appName: reading.appName || null,
      rawPositionMs: reading.positionMs,
      anchorPosMs,
      anchorAtMs,
      posFresh,
      updatedAtMs: now,
    }

    if (updateIdleBridge && (!this.bridge.running || this.bridge.state === 'error')) {
      const changed = this.bridge.roku !== reading.roku
        || this.bridge.app_name !== reading.appName
        || this.bridge.position_ms !== livePos
      this.bridge.roku = reading.roku
      this.bridge.app_name = reading.appName
      this.bridge.position_ms = livePos
      if (changed) this.emit('state', this.snapshot())
    }
  }

  _extrapolatedRokuPosition(lr = this._localRoku, now = Date.now()) {
    if (!lr || !Number.isFinite(lr.anchorPosMs)) return null
    if (lr.roku === 'play' && lr.anchorAtMs > 0) {
      return Math.round(lr.anchorPosMs + Math.max(0, now - lr.anchorAtMs))
    }
    return Math.round(lr.anchorPosMs)
  }

  startLocalRokuPolling() {
    if (this._localRokuTimer || !this.localRokuPollMs) return
    this._localRokuTimer = setInterval(() => {
      if (this.bridge.running && this.bridge.state === 'connected') return
      this.pollLocalRokuOnce().catch(() => {})
    }, this.localRokuPollMs)
    if (typeof this._localRokuTimer.unref === 'function') this._localRokuTimer.unref()
    this.pollLocalRokuOnce().catch(() => {})
  }

  stopLocalRokuPolling() {
    if (this._localRokuTimer) {
      clearInterval(this._localRokuTimer)
      this._localRokuTimer = null
    }
  }

  pollLocalRokuOnce(timeoutMs = 1500) {
    if (this._localRokuInFlight) return this._localRokuInFlight
    this._localRokuInFlight = new Promise((resolve) => {
      let target
      try {
        const base = String(this.config.rokuUrl || DEFAULT_CONFIG.rokuUrl).trim()
        target = new URL('/query/media-player', base.endsWith('/') ? base : base + '/')
      } catch {
        resolve(null)
        return
      }
      if (target.protocol !== 'http:') {
        resolve(null)
        return
      }
      const http = require('node:http')
      const req = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 8060,
        path: target.pathname,
        method: 'GET',
        headers: { 'User-Agent': 'RokuSync/0.4' },
      }, (res) => {
        let xml = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { xml += c })
        res.on('end', () => {
          const parsed = (res.statusCode >= 200 && res.statusCode < 300)
            ? parseRokuMediaPlayerXml(xml)
            : null
          if (parsed) this._applyLocalRokuReading(parsed, true)
          resolve(parsed)
        })
      })
      armDeadline(req, timeoutMs, 'timeout')
      req.on('error', () => resolve(null))
      req.end()
    }).finally(() => {
      this._localRokuInFlight = null
    })
    return this._localRokuInFlight
  }

  /** The daemon's latest measured Chrome-ahead-of-TV lead, when it is fresh. */
  _acousticState(now = Date.now()) {
    const ac = this._acoustic
    if (!this.anc.running || !ac || !ac.seq || (now - ac.at) > ACOUSTIC_FRESH_MS) return null
    return {
      leadMs: ac.leadMs,
      targetLeadMs: ac.targetLeadMs,
      score: ac.score,
      seq: ac.seq,
      session: this._acousticSession || null,
      ageMs: now - ac.at,
    }
  }

  getLocalMirrorState(now = Date.now()) {
    const acoustic = this._acousticState(now)
    const master = this._relayMaster
    if (master && Number.isFinite(master.updatedAtMs) && (now - master.updatedAtMs) < 20000) {
      const posMs = master.paused
        ? master.positionMs
        : Math.round(master.positionMs + Math.max(0, now - master.updatedAtMs))
      return {
        active: true,
        source: 'relay-master',
        mode: 'peer',
        roku: master.paused ? 'pause' : 'play',
        app: master.app,
        appName: master.app === 'netflix' ? 'Netflix' : master.app === 'youtube' ? 'YouTube' : master.app,
        titleId: master.titleId,
        positionMs: posMs,
        paused: Boolean(master.paused),
        posFresh: true,
        updatedAtMs: master.updatedAtMs,
        local_ms: now,
        desiredApp: master.app,
        desiredTitleId: master.titleId,
        acoustic,
      }
    }

    const lr = this._localRoku
    const fresh = lr.updatedAtMs > 0 && (now - lr.updatedAtMs) < 10000
    const livePos = fresh ? this._extrapolatedRokuPosition(lr, now) : null
    const desiredMatches = this._desiredMirror.titleId
      && (!lr.appSlug || lr.appSlug === this._desiredMirror.app)
    const titleId = desiredMatches ? this._desiredMirror.titleId : null
    return {
      active: Boolean(fresh && lr.roku && !['none', 'unavailable', 'error'].includes(lr.roku)),
      source: 'local-roku',
      mode: 'roku',
      roku: fresh ? lr.roku : 'unavailable',
      app: fresh ? lr.appSlug : this._desiredMirror.app,
      appName: fresh ? lr.appName : null,
      titleId,
      positionMs: livePos,
      paused: fresh ? lr.roku !== 'play' : true,
      posFresh: Boolean(fresh && lr.posFresh),
      updatedAtMs: lr.updatedAtMs || now,
      local_ms: now,
      desiredApp: this._desiredMirror.app,
      desiredTitleId: desiredMatches ? this._desiredMirror.titleId : null,
      acoustic,
    }
  }

  recordLocalMirrorHeartbeat(payload = {}) {
    const now = Date.now()
    const clientId = String(payload.client_id || 'ref-local').slice(0, 64)
    const app = String(payload.app || '').slice(0, 32) || null
    const titleId = String(payload.title_id || '').slice(0, 64) || null
    const positionMs = Number.isFinite(Number(payload.position_ms))
      ? Math.round(Number(payload.position_ms))
      : null
    const paused = Boolean(payload.paused)
    this._localMirrorClient = {
      client_id: clientId,
      app,
      title_id: titleId,
      position_ms: positionMs,
      paused,
      at: now,
    }
    const target = this.getLocalMirrorState()
    const driftMs = (positionMs !== null && Number.isFinite(target.positionMs))
      ? Math.round(positionMs - target.positionMs)
      : null
    this.mirror = {
      state: 'synced',
      mode: target.mode || 'roku',
      app: app || target.app,
      titleId: titleId || target.titleId,
      positionMs,
      paused,
      driftMs,
      detail: 'Silent Chrome reference locked directly to Roku Sync player timing.',
    }
    this.emit('state', this.snapshot())
    return { ok: true, mirror: this.getLocalMirrorState() }
  }

  _rokuPost(ecpPath, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let target
      try {
        const base = String(this.config.rokuUrl || DEFAULT_CONFIG.rokuUrl).trim()
        target = new URL(ecpPath, base.endsWith('/') ? base : base + '/')
      } catch (error) {
        reject(new Error('Invalid Roku LAN URL'))
        return
      }
      if (target.protocol !== 'http:') {
        reject(new Error('Roku ECP requires a local HTTP URL'))
        return
      }
      const http = require('node:http')
      const req = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 8060,
        path: target.pathname + target.search,
        method: 'POST',
        headers: { 'Content-Length': '0', 'User-Agent': 'RokuSync/0.4' },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode || 0))
      })
      armDeadline(req, timeoutMs, 'Roku launch timed out')
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * The silent reference plays in its own Chrome profile. The audio tap only
   * mutes that instance, so a Messenger call in everyday Chrome stays audible.
   */
  referenceChromeArgs(chromeUrl) {
    return ['-n', '-g', '-a', 'Google Chrome', '--args',
      `--user-data-dir=${this.referenceProfileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      chromeUrl]
  }

  openReferenceChrome(chromeUrl = 'https://www.netflix.com/login') {
    try { fs.mkdirSync(this.referenceProfileDir, { recursive: true, mode: 0o700 }) } catch { /* open reports it */ }
    const opened = this.openInChrome(chromeUrl)
    return { opened, profileDir: this.referenceProfileDir }
  }

  openInChrome(chromeUrl) {
    if (this.platform === 'darwin') {
      try {
        const child = this.spawn('/usr/bin/open', this.referenceChromeArgs(chromeUrl), {
          stdio: 'ignore',
          detached: true,
        })
        if (child && typeof child.unref === 'function') child.unref()
        return true
      } catch {
        return false
      }
    }
    return false
  }

  _relayJson(method, pathname, payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let target
      try {
        target = new URL(pathname, relayOrigin(this.config.serverUrl))
      } catch (error) {
        reject(error)
        return
      }
      const transport = target.protocol === 'https:' ? require('node:https') : require('node:http')
      const bodyText = payload !== undefined ? JSON.stringify(payload) : null
      const headers = {
        Accept: 'application/json',
        'User-Agent': 'RokuSync/0.4',
      }
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`
      if (bodyText !== null) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(Buffer.byteLength(bodyText))
      }
      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      }, (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { out += chunk })
        res.on('end', () => {
          let data = null
          try { data = out ? JSON.parse(out) : {} } catch { data = null }
          resolve({ status: res.statusCode || 0, data, raw: out })
        })
      })
      armDeadline(req, timeoutMs, `${pathname} timed out after ${timeoutMs} ms`)
      req.on('error', reject)
      if (bodyText !== null) req.write(bodyText)
      req.end()
    })
  }

  startMirrorPolling() {
    if (this._mirrorTimer || !this.mirrorPollMs) return
    this._mirrorTimer = setInterval(() => {
      this.syncMirrorOnce().catch(() => {})
    }, this.mirrorPollMs)
    if (typeof this._mirrorTimer.unref === 'function') this._mirrorTimer.unref()
    this.syncMirrorOnce().catch(() => {})
  }

  stopMirrorPolling() {
    if (this._mirrorTimer) {
      clearInterval(this._mirrorTimer)
      this._mirrorTimer = null
    }
  }

  async syncMirrorOnce(options = {}) {
    if (this._mirrorCheckInFlight) return this._mirrorCheckInFlight
    const nowStart = Date.now()
    if (this._localMirrorClient && (nowStart - this._localMirrorClient.at) < 8000 && !this.config.token) {
      return this.mirror
    }
    if (!this.config.token) return this.mirror
    const allowAutoOpen = options.allowAutoOpen !== false
    this._mirrorCheckInFlight = (async () => {
      try {
        if (!this.bridge.running && this.localRokuPollMs > 0) {
          await this.pollLocalRokuOnce(900).catch(() => {})
        }
        const res = await this._relayJson('GET', '/sync', undefined, 4000)
        if (res.status < 200 || res.status >= 300 || !res.data) return this.mirror
        const room = res.data
        const now = Date.now()
        const clients = (room.clients && typeof room.clients === 'object') ? room.clients : {}

        let refClient = null
        if (this._localMirrorClient && (now - this._localMirrorClient.at) < 8000) {
          refClient = Object.assign({}, this._localMirrorClient, {
            received_at_ms: this._localMirrorClient.at,
            client_ms: this._localMirrorClient.at,
          })
        }
        for (const [cid, entry] of Object.entries(clients)) {
          if (!cid.startsWith('ref-') || !entry) continue
          const stamp = Number.isFinite(entry.client_ms) ? entry.client_ms : entry.received_at_ms
          if (Number.isFinite(stamp) && Math.abs(now - stamp) < 15000) {
            if (!refClient || (entry.received_at_ms || 0) > (refClient.received_at_ms || 0)) {
              refClient = Object.assign({ client_id: cid }, entry)
            }
          }
        }

        const mode = room.sync_mode === 'peer' ? 'peer' : 'roku'
        let targetApp = null
        let targetTitle = null
        if (mode === 'peer') {
          const ms = room.master_state
          const msStamp = ms && (Number.isFinite(ms.client_ms) ? ms.client_ms : ms.received_at_ms)
          const msFresh = Boolean(ms && Number.isFinite(msStamp) && Math.abs(now - msStamp) < 60000)
          targetApp = (msFresh && ms.app) || null
          targetTitle = (msFresh && ms.title_id) || null
          if (msFresh && Number.isFinite(ms.position_ms)) {
            const elapsed = ms.paused ? 0 : Math.max(0, Math.min(15000, now - msStamp))
            this._relayMaster = {
              app: targetApp,
              titleId: targetTitle,
              positionMs: Math.round(ms.position_ms + elapsed),
              paused: Boolean(ms.paused),
              updatedAtMs: now,
            }
          } else {
            this._relayMaster = null
          }
        } else {
          this._relayMaster = null
          const lr = this._localRoku
          const lrFresh = lr.updatedAtMs > 0 && (now - lr.updatedAtMs) < 8000
          const effectiveRokuState = lrFresh ? lr.roku : room.roku
          const effectiveAppSlug = lrFresh ? lr.appSlug : appSlugFromRoom(room)
          const roomAgeS = typeof room.last_update === 'number' ? (now / 1000 - room.last_update) : 999
          const launchSendingFresh = room.launch_status === 'sending'
            && typeof room.launch_started === 'number'
            && (now / 1000 - room.launch_started) < 30
          const rokuActuallyPlaying = ['play', 'pause', 'buffer'].includes(effectiveRokuState)
            && (lrFresh || roomAgeS < 10)
          if ((rokuActuallyPlaying || launchSendingFresh)
              && (effectiveAppSlug === 'netflix' || effectiveAppSlug === 'youtube')
              && room.title_id) {
            targetApp = effectiveAppSlug
            targetTitle = room.title_id
            this._desiredMirror = { app: targetApp, titleId: targetTitle, at: now }
          }
        }

        const watchUrl = buildReferenceWatchUrl(targetApp, targetTitle)
        const targetKey = watchUrl ? `${targetApp}:${targetTitle}` : null
        if (targetKey !== this._mirrorSeenTarget.key) {
          this._mirrorSeenTarget = { key: targetKey, since: targetKey ? now : 0 }
        }

        if (refClient && (!targetTitle || String(refClient.title_id) === String(targetTitle))) {
          let driftMs = null
          const localTarget = this.getLocalMirrorState(now)
          if (Number.isFinite(refClient.position_ms) && Number.isFinite(localTarget.positionMs)) {
            driftMs = Math.round(refClient.position_ms - localTarget.positionMs)
          } else if (mode === 'peer' && room.master_state && Number.isFinite(room.master_state.position_ms)) {
            driftMs = Math.round(refClient.position_ms - room.master_state.position_ms)
          } else if (mode === 'roku' && room.app_id !== '12' && Number.isFinite(room.position_ms)) {
            driftMs = Math.round(refClient.position_ms - room.position_ms)
          }
          this.mirror = {
            state: 'synced',
            mode,
            app: refClient.app || targetApp,
            titleId: refClient.title_id,
            positionMs: refClient.position_ms,
            paused: Boolean(refClient.paused),
            driftMs,
            detail: `Silent Chrome reference tab synced (${mode === 'peer' ? 'following Master' : 'following Roku TV'}).`,
          }
          this.emit('state', this.snapshot())
          return this.mirror
        }

        if (!watchUrl) {
          if (this.mirror.state !== 'idle' && !refClient) {
            this.mirror = {
              state: 'idle', mode, app: null, titleId: null,
              positionMs: null, paused: null, driftMs: null, detail: null,
            }
            this.emit('state', this.snapshot())
          }
          return this.mirror
        }

        const shouldAutoOpen = allowAutoOpen && this.config.autoMirrorChrome && this.anc.running
        // Give an already-open ref-* tab 5s to navigate itself in-place before spawning any tab,
        // and NEVER auto-open the same (app:titleId) more than once!
        const waitingForInPlaceNav = Boolean(refClient && now - this._mirrorSeenTarget.since < 5000)
        const alreadyAutoOpened = this._autoOpenedKeys.has(targetKey)

        if (shouldAutoOpen && !waitingForInPlaceNav && !alreadyAutoOpened) {
          this._autoOpenedKeys.add(targetKey)
          if (this._autoOpenedKeys.size > 50) {
            const oldest = this._autoOpenedKeys.values().next().value
            this._autoOpenedKeys.delete(oldest)
          }
          const opened = this.openInChrome(watchUrl)
          if (opened) {
            this._lastMirrorOpen = { key: targetKey, at: now }
            this.emit('log', {
              source: 'mirror',
              line: `Auto-opened silent Chrome reference tab once for ${targetApp} (${targetTitle})`,
            })
            this.mirror = {
              state: 'opening',
              mode,
              app: targetApp,
              titleId: targetTitle,
              positionMs: null,
              paused: null,
              driftMs: null,
              detail: `Opened silent Chrome reference tab for ${targetApp} (${targetTitle})…`,
            }
            this.emit('state', this.snapshot())
            return this.mirror
          }
        }

        if (this._lastMirrorOpen.key === targetKey && (now - this._lastMirrorOpen.at) > 7000) {
          this.mirror = {
            state: 'needs-extension',
            mode,
            app: targetApp,
            titleId: targetTitle,
            positionMs: null,
            paused: null,
            driftMs: null,
            detail: 'Reference tab opened once in the reference Chrome window, but it has not connected. In that window: sign in to Netflix, load the roku-sync extension, and click Connect Roku Sync app in its popup.',
          }
          this.emit('state', this.snapshot())
        }
      } catch {
        /* transient relay errors are retried on the next poll */
      } finally {
        this._mirrorCheckInFlight = null
      }
      return this.mirror
    })()
    return this._mirrorCheckInFlight
  }

  async launchMirrorUrl(rawUrl, options = {}) {
    const parsed = parseMediaLaunchUrl(rawUrl)
    const refUrl = buildReferenceWatchUrl(parsed.app, parsed.titleId) || `${parsed.chromeUrl}#roku-sync-ref`
    const targetKey = `${parsed.app}:${parsed.titleId}`
    this._desiredMirror = { app: parsed.app, titleId: parsed.titleId, at: Date.now() }
    this._autoOpenedKeys.add(targetKey)
    this.startLocalRokuPolling()

    // 1. Ensure Chrome Audio Tap is selected and ANC is running BEFORE Chrome plays
    //    so Chrome audio is muted in the room immediately.
    const hasTap = ((this.devices && this.devices.inputs) || [])
      .some((entry) => entry.name === CHROME_TAP_DEVICE_NAME)
    if (hasTap && this.config.preferredRefDevice !== CHROME_TAP_DEVICE_NAME) {
      this.saveConfig({ preferredRefDevice: CHROME_TAP_DEVICE_NAME })
    }
    if (options.autoStartAnc !== false && !this.anc.running) {
      this.startAnc()
    }

    // 2. Ensure Roku Bridge is running so Roku's live timestamp feeds the relay every 300ms.
    if (options.autoStartBridge !== false && this.config.token && !this.bridge.running) {
      this.startRokuBridge()
    }

    // 3. Coordinate through the relay in `roku` mode + launch on the Roku TV.
    let rokuLaunched = false
    let rokuError = null
    let relayAnnounced = false
    if (this.config.token) {
      try {
        await this._relayJson('POST', '/baton', { action: 'mode', sync_mode: 'roku' }, 4000)
        const ev = await this._relayJson('POST', '/event', {
          action: 'title',
          title_id: parsed.titleId,
          app: parsed.app,
        }, 5000)
        relayAnnounced = ev.status >= 200 && ev.status < 300
      } catch {
        relayAnnounced = false
      }
    }
    if (options.launchRoku !== false) {
      try {
        const status = await this._rokuPost(parsed.ecpPath)
        rokuLaunched = status >= 200 && status < 300
        if (rokuLaunched) {
          setTimeout(() => { this._rokuPost('/keypress/Select', 2500).catch(() => {}) }, 1600).unref?.()
        } else if (!relayAnnounced) {
          rokuError = `Roku returned HTTP ${status}`
        } else {
          rokuLaunched = true
        }
      } catch (error) {
        if (relayAnnounced) rokuLaunched = true
        else rokuError = error.message || String(error)
      }
    }

    // 4. Reuse an already-connected silent #roku-sync-ref tab if one is live (it
    //    self-navigates in-place), otherwise spawn a background Chrome tab once.
    const liveLocalTab = Boolean(this._localMirrorClient && (Date.now() - this._localMirrorClient.at) < 8000)
    let chromeOpened = false
    let reusedTab = false
    if (options.openChrome !== false) {
      if (liveLocalTab || (this.mirror.state === 'synced' && relayAnnounced)) {
        reusedTab = true
        chromeOpened = true
      } else {
        chromeOpened = this.openInChrome(refUrl)
      }
      if (chromeOpened) {
        this._lastMirrorOpen = { key: targetKey, at: Date.now() }
        this.mirror = {
          state: reusedTab ? 'synced' : 'opening',
          mode: 'roku',
          app: parsed.app,
          titleId: parsed.titleId,
          positionMs: null,
          paused: true,
          driftMs: 0,
          detail: reusedTab
            ? `Switched existing silent Chrome reference tab to ${parsed.appName}.`
            : `Opened silent Chrome reference tab — waiting for Roku ${parsed.appName} to start…`,
        }
        this.emit('state', this.snapshot())
      }
    }

    if (this.config.token) {
      setTimeout(() => { this.syncMirrorOnce({ allowAutoOpen: false }).catch(() => {}) }, 2200).unref?.()
      setTimeout(() => { this.syncMirrorOnce({ allowAutoOpen: false }).catch(() => {}) }, 6500).unref?.()
    }

    this.emit('log', {
      source: 'mirror',
      line: `Mirror ${parsed.appName} (${parsed.titleId}): Chrome=${reusedTab ? 'reused-tab' : (chromeOpened ? 'opened' : 'skipped')}, Roku=${rokuLaunched ? 'launched' : (rokuError || 'skipped')}`,
    })
    return {
      ok: Boolean(chromeOpened || rokuLaunched),
      app: parsed.app,
      appName: parsed.appName,
      titleId: parsed.titleId,
      chromeUrl: refUrl,
      chromeOpened,
      reusedTab,
      rokuLaunched,
      rokuError,
      snapshot: this.snapshot(),
    }
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
      micPreview: Object.assign({}, this.micPreview),
      mirror: Object.assign({}, this.mirror),
      rokuDevices: this.rokuDevices.slice(),
      rokuLocalNetworkBlocked: Boolean(this.rokuLocalNetworkBlocked),
      lastRokuScan: this.lastRokuScan,
      rokuScanError: this.rokuScanError,
      pingTest: Object.assign({}, this.pingTest),
    }
  }

  async dispose() {
    this.stopDevicePolling()
    this.stopMirrorPolling()
    await Promise.all([
      this._stopChild('anc'),
      this._stopChild('bridge'),
      this._stopChild('preview'),
    ])
    if (this._previewDir) {
      fs.rmSync(this._previewDir, { recursive: true, force: true })
      this._previewDir = null
    }
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
  CHROME_TAP_DEVICE_NAME,
  parseMediaLaunchUrl,
  parseRokuMediaPlayerXml,
  buildReferenceWatchUrl,
  defaultConfigPath,
  normaliseConfig,
  classifyMicSource,
  describePingMath,
  parseJsonLine,
}
