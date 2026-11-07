'use strict'
/*
 * Renderer for the Roku Sync desktop app.
 *
 * Runs unchanged in Electron (through `preload.js`) and in a normal browser
 * (through the `fetch` polyfill below, served by `desktop/server.cjs`), so the
 * Chrome `--app` fallback needs no separate UI code.
 */

/* ------------------------------------------------------------------------- */
/* API adapter: IPC in Electron, fetch against server.cjs in a browser.      */
/* ------------------------------------------------------------------------- */
function browserAdapter() {
  const call = async (method, url, body) => {
    const options = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) options.body = JSON.stringify(body)
    const response = await fetch(url, options)
    if (!response.ok) throw new Error(`${url} failed with ${response.status}`)
    return response.json()
  }
  const unwrap = (payload) => (payload && payload.snapshot ? payload.snapshot : payload)
  const listeners = { state: [], log: [] }
  let lastState = null
  let lastLogCount = 0

  const poll = async () => {
    try {
      const state = await call('GET', '/api/state')
      lastState = state
      listeners.state.forEach((fn) => fn(state))
      const logs = await call('GET', '/api/logs')
      if (Array.isArray(logs) && logs.length) {
        for (const entry of logs.slice(lastLogCount)) {
          listeners.log.forEach((fn) => fn(entry))
        }
        lastLogCount = logs.length
      }
      const next = await call('GET', '/api/state')
      if (next) lastState = next
    } catch (error) {
      /* the server may be restarting; the next tick retries */
    }
  }

  return {
    isElectron: false,
    getState: () => call('GET', '/api/state'),
    saveConfig: async (patch) => unwrap(await call('POST', '/api/config', { patch })),
    refreshDevices: () => call('POST', '/api/devices/refresh').then(unwrap),
    startAnc: () => call('POST', '/api/anc/start').then(unwrap),
    stopAnc: () => call('POST', '/api/anc/stop').then(unwrap),
    runSelfTest: () => call('POST', '/api/anc/selftest').then(unwrap),
    startBridge: () => call('POST', '/api/bridge/start').then(unwrap),
    stopBridge: () => call('POST', '/api/bridge/stop').then(unwrap),
    recentLogs: () => call('GET', '/api/logs'),
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(String(text || ''))
        return true
      } catch (error) {
        return false
      }
    },
    openExternal: async (url) => {
      if (/^https?:\/\//i.test(String(url || ''))) window.open(url, '_blank', 'noopener')
    },
    onState: (callback) => {
      listeners.state.push(callback)
      if (lastState) callback(lastState)
      return () => {
        const index = listeners.state.indexOf(callback)
        if (index >= 0) listeners.state.splice(index, 1)
      }
    },
    onLog: (callback) => {
      listeners.log.push(callback)
      return () => {
        const index = listeners.log.indexOf(callback)
        if (index >= 0) listeners.log.splice(index, 1)
      }
    },
    start: () => {
      poll()
      setInterval(poll, 1000)
    },
  }
}

const api = window.rokuDesktop && window.rokuDesktop.isElectron
  ? window.rokuDesktop
  : (window.rokuDesktop = browserAdapter())

/* ------------------------------------------------------------------------- */
/* DOM helpers                                                               */
/* ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id)
const el = {
  connection: $('connection-chip'),
  refresh: $('refresh-devices'),
  micSelect: $('mic-select'),
  micBadge: $('mic-badge'),
  autoPick: $('auto-pick-soundcard'),
  refSelect: $('ref-select'),
  outSelect: $('out-select'),
  warning: $('device-warning'),
  warningBody: $('device-warning-body'),
  brew: $('brew-command'),
  copyBrew: $('copy-brew'),
  delayValue: $('delay-value'),
  delayBar: $('delay-bar'),
  erleValue: $('erle-value'),
  erleBar: $('erle-bar'),
  talkValue: $('talk-value'),
  talkBar: $('talk-bar'),
  ancStatus: $('anc-status'),
  ancError: $('anc-error'),
  startAnc: $('start-anc'),
  stopAnc: $('stop-anc'),
  selftest: $('run-selftest'),
  selftestResult: $('selftest-result'),
  bridgeStatus: $('bridge-status'),
  bridgeError: $('bridge-error'),
  serverUrl: $('server-url'),
  roomToken: $('room-token'),
  toggleToken: $('toggle-token'),
  rokuUrl: $('roku-url'),
  configPath: $('config-path'),
  rokuPlayer: $('roku-player'),
  rokuApp: $('roku-app'),
  rokuPosition: $('roku-position'),
  startBridge: $('start-bridge'),
  stopBridge: $('stop-bridge'),
  log: $('log'),
  clearLog: $('clear-log'),
}

const BREW_COMMAND = 'brew install --cask blackhole-2ch'

function setChip(node, text, variant) {
  node.textContent = text
  node.className = `chip chip-${variant}`
}

function fillSelect(select, entries, current, fallbackLabel) {
  // Deduplicate by name: virtual devices appear in both the input and output
  // enumeration, and a repeated option is confusing in a picker.
  const names = []
  for (const entry of entries) {
    if (entry && entry.name && !names.includes(entry.name)) names.push(entry.name)
  }
  if (current && !names.includes(current)) names.unshift(current)
  const signature = names.join('\u0000')
  if (select.dataset.signature !== signature) {
    select.innerHTML = ''
    if (!names.length) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = fallbackLabel
      select.appendChild(option)
    }
    for (const name of names) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }
    select.dataset.signature = signature
  }
  if (current) select.value = current
}

function formatPosition(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-'
  const total = Math.max(0, Math.floor(Number(value) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function renderDevices(state) {
  const devices = state.devices
  const recommended = (devices && devices.recommended) || {}
  const inputs = (devices && devices.inputs) || []
  const outputs = (devices && devices.outputs) || []
  // A loopback must be a virtual device: plain speakers have no input side and
  // cannot carry the Chrome reference into the canceller.
  const loopbacks = outputs.concat(inputs).filter((entry) => entry.kind === 'virtual')

  const micName = state.anc.mic_device || recommended.mic_device
  fillSelect(el.micSelect, inputs, micName, 'No microphone detected')
  fillSelect(el.refSelect, loopbacks, state.anc.ref_device || recommended.ref_device,
    'No virtual loopback installed')
  fillSelect(el.outSelect, loopbacks, state.anc.out_device || recommended.out_device,
    'No virtual output installed')

  const micEntry = inputs.find((entry) => entry.name === micName)
  const isUsb = (recommended.mic_source === 'usb') || (micEntry && micEntry.kind === 'usb')
  el.micBadge.textContent = devices ? (devices.micBadge || 'Auto') : 'Scanning'
  el.micBadge.className = 'badge' + (isUsb ? ' usb' : '')

  const notes = (devices && devices.warnings) || []
  const singleVirtual = notes.find((note) => /Only one virtual audio device/i.test(note))
  if (singleVirtual) {
    el.warning.classList.remove('hidden')
    el.warningBody.textContent = singleVirtual
  } else {
    el.warning.classList.add('hidden')
  }
  el.brew.textContent = BREW_COMMAND

  el.autoPick.checked = Boolean(state.config.autoPickSoundcard)
}

function renderAnc(state) {
  const anc = state.anc
  const labels = { stopped: ['Stopped', 'idle'], starting: ['Starting', 'warn'],
    running: ['Running', 'running'], stopping: ['Stopping', 'warn'],
    error: ['Error', 'error'] }
  const [text, variant] = labels[anc.state] || ['Stopped', 'idle']
  setChip(el.ancStatus, text, variant)

  el.delayValue.innerHTML = `${Number(anc.delay_ms || 0).toFixed(1)} <small>ms</small>`
  const delayPct = Math.max(0, Math.min(100, (Number(anc.delay_ms || 0) / 600) * 100))
  el.delayBar.style.width = `${delayPct}%`

  const erle = Number(anc.erle_db || 0)
  el.erleValue.innerHTML = `${erle.toFixed(1)} <small>dB</small>`
  el.erleBar.style.width = `${Math.max(0, Math.min(100, (erle / 40) * 100))}%`

  const talking = Boolean(anc.double_talk)
  el.talkValue.textContent = talking ? 'Speaking' : 'Cancelling TV'
  el.talkBar.style.width = talking ? '100%' : '32%'

  el.startAnc.disabled = anc.running
  el.stopAnc.disabled = !anc.running
  el.selftest.disabled = state.selfTest.running
  el.selftest.textContent = state.selfTest.running ? 'Running self-test...' : 'Run 4s DSP self-test'

  if (anc.error) {
    el.ancError.classList.remove('hidden')
    el.ancError.textContent = anc.error
  } else {
    el.ancError.classList.add('hidden')
  }

  const result = state.selfTest.result
  if (result) {
    el.selftestResult.textContent = `${result.ok ? 'PASS' : 'FAIL'} - delay ${Number(result.delay_ms).toFixed(1)} ms, `
      + `ERLE ${Number(result.erle_db).toFixed(1)} dB, voice ${Number(result.near_end_preserved_db).toFixed(1)} dB`
  } else if (state.selfTest.error) {
    el.selftestResult.textContent = `Self-test failed: ${state.selfTest.error}`
  }
}

function renderBridge(state) {
  const bridge = state.bridge
  const labels = { stopped: ['Stopped', 'idle'], connecting: ['Connecting', 'warn'],
    connected: ['Connected', 'running'], stopping: ['Stopping', 'warn'],
    error: ['Bridge error', 'error'] }
  const [text, variant] = labels[bridge.state] || ['Stopped', 'idle']
  setChip(el.bridgeStatus, text, variant)

  el.rokuPlayer.textContent = bridge.roku || 'unknown'
  el.rokuApp.textContent = bridge.app_name || '-'
  el.rokuPosition.textContent = formatPosition(bridge.position_ms)
  el.startBridge.disabled = bridge.running
  el.stopBridge.disabled = !bridge.running

  if (bridge.error) {
    el.bridgeError.classList.remove('hidden')
    el.bridgeError.textContent = bridge.error
  } else {
    el.bridgeError.classList.add('hidden')
  }
}

function renderConfig(state) {
  // Never clobber a field the user is mid-edit on.
  const active = document.activeElement
  if (active !== el.serverUrl) el.serverUrl.value = state.config.serverUrl || ''
  if (active !== el.roomToken) el.roomToken.value = state.config.token || ''
  if (active !== el.rokuUrl) el.rokuUrl.value = state.config.rokuUrl || ''
  el.configPath.textContent = state.configPath || el.configPath.textContent
}

function renderState(state) {
  if (!state) return
  renderConfig(state)
  renderDevices(state)
  renderAnc(state)
  renderBridge(state)
  const busy = state.anc.running || state.bridge.running
  setChip(el.connection, busy ? 'Active' : 'Idle', busy ? 'running' : 'idle')
}

/* ------------------------------------------------------------------------- */
/* Log                                                                       */
/* ------------------------------------------------------------------------- */
let logs = []

function appendLog(entry) {
  if (!entry) return
  logs.push(`[${entry.source}] ${entry.line}`)
  if (logs.length > 300) logs.shift()
  el.log.textContent = logs.slice(-160).join('\n')
  el.log.scrollTop = el.log.scrollHeight
}

/* ------------------------------------------------------------------------- */
/* Events                                                                    */
/* ------------------------------------------------------------------------- */
const saveConfig = async (patch) => {
  try {
    renderState(await api.saveConfig(patch))
  } catch (error) {
    appendLog({ source: 'config', line: error.message })
  }
}

el.autoPick.addEventListener('change', () => saveConfig({ autoPickSoundcard: el.autoPick.checked }))
el.micSelect.addEventListener('change', () => saveConfig({ preferredMicDevice: el.micSelect.value }))
el.refSelect.addEventListener('change', () => saveConfig({ preferredRefDevice: el.refSelect.value }))
el.outSelect.addEventListener('change', () => saveConfig({ preferredOutDevice: el.outSelect.value }))

let configTimer = null
const scheduleConfigSave = () => {
  clearTimeout(configTimer)
  configTimer = setTimeout(() => saveConfig({
    serverUrl: el.serverUrl.value.trim(),
    token: el.roomToken.value,
    rokuUrl: el.rokuUrl.value.trim(),
  }), 400)
}
el.serverUrl.addEventListener('input', scheduleConfigSave)
el.roomToken.addEventListener('input', scheduleConfigSave)
el.rokuUrl.addEventListener('input', scheduleConfigSave)

el.toggleToken.addEventListener('click', () => {
  const hidden = el.roomToken.type === 'password'
  el.roomToken.type = hidden ? 'text' : 'password'
  el.toggleToken.textContent = hidden ? 'Hide' : 'Show'
  el.toggleToken.setAttribute('aria-label', hidden ? 'Hide token' : 'Show token')
})

el.refresh.addEventListener('click', async () => {
  el.refresh.disabled = true
  try {
    renderState(await api.refreshDevices())
  } finally {
    el.refresh.disabled = false
  }
})

el.startAnc.addEventListener('click', async () => {
  renderState(await api.startAnc())
})
el.stopAnc.addEventListener('click', async () => {
  renderState(await api.stopAnc())
})
el.selftest.addEventListener('click', async () => {
  renderState(await api.runSelfTest())
})

el.startBridge.addEventListener('click', async () => {
  // Flush any pending typing before the bridge picks up the config.
  clearTimeout(configTimer)
  await saveConfig({ serverUrl: el.serverUrl.value.trim(),
    token: el.roomToken.value,
    rokuUrl: el.rokuUrl.value.trim() })
  renderState(await api.startBridge())
})
el.stopBridge.addEventListener('click', async () => {
  renderState(await api.stopBridge())
})

el.copyBrew.addEventListener('click', async () => {
  const copied = await api.copy(BREW_COMMAND)
  el.copyBrew.textContent = copied ? 'Copied' : 'Copy failed'
  setTimeout(() => { el.copyBrew.textContent = 'Copy' }, 1500)
})

el.clearLog.addEventListener('click', () => {
  logs = []
  el.log.textContent = ''
})

/* ------------------------------------------------------------------------- */
/* Boot                                                                      */
/* ------------------------------------------------------------------------- */
api.onState(renderState)
api.onLog(appendLog)
if (typeof api.start === 'function') api.start()

api.getState().then(renderState).catch((error) => {
  appendLog({ source: 'ui', line: `could not load state: ${error.message}` })
})
if (typeof api.recentLogs === 'function') {
  api.recentLogs().then((entries) => {
    (entries || []).forEach(appendLog)
  }).catch(() => {})
}
