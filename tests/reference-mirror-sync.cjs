'use strict'
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

function makeEnv({
  hostname = 'www.youtube.com',
  pathname = '/watch',
  search = '?v=aqz-KE-bpKQ',
  hash = '#roku-sync-ref',
  syncMode = 'roku',
  enabled = true,
  docStartRefAttr = false,
  localMirror = null,
  cadmiumBridgeActive = false,
  initialVideo = { paused: false, currentTime: 9, muted: true, volume: 0.1 },
  initialState = null,
} = {}) {
  let now = 1_800_000_000_000
  const listeners = {}
  const timers = []
  const messages = []
  const dispatched = []
  const sessionStore = new Map()
  let relayState = initialState || {
    seq: 1,
    roku: 'buffer',
    app_id: '837',
    app_name: 'YouTube',
    position_ms: 0,
    last_update: now / 1000,
    launch_status: 'sending',
    launch_started: now / 1000,
    title_id: 'aqz-KE-bpKQ',
    sync_mode: syncMode,
    master_client_id: null,
    master_state: null,
    scheduled: null,
    sample: null,
    clients: {},
  }

  let currentTimeWrites = 0
  let _ct = initialVideo.currentTime
  const video = {
    paused: initialVideo.paused,
    get currentTime() { return _ct },
    set currentTime(val) { currentTimeWrites += 1; _ct = val },
    muted: Boolean(initialVideo.muted),
    volume: initialVideo.volume ?? 1,
    readyState: 3,
    ended: false,
    addEventListener: (n, f) => { listeners[n] = f },
    removeEventListener: (n) => { delete listeners[n] },
    async play() {
      this.paused = false
      listeners.play?.({ type: 'play' })
    },
    pause() {
      this.paused = true
      listeners.pause?.({ type: 'pause' })
    },
  }

  const badge = {
    style: {},
    textContent: '',
    title: '',
    setAttribute() {},
    addEventListener: (n, f) => { if (n === 'click') badge.click = f },
  }

  const location = {
    hostname,
    pathname,
    search,
    hash,
    href: `https://${hostname}${pathname}${search}${hash}`,
  }

  const stored = {
    enabled,
    syncMode,
    server: 'https://relay.example',
    privacyConsent: { version: 1, server: 'https://relay.example' },
  }

  let localMirrorState = localMirror
  const docListeners = {}
  const docElAttrs = new Map()
  if (docStartRefAttr) docElAttrs.set('data-roku-sync-ref', '1')

  const ctx = {
    document: {
      createElement: () => badge,
      documentElement: {
        appendChild() {},
        getAttribute: (k) => (docElAttrs.has(k) ? docElAttrs.get(k) : null),
        setAttribute: (k, v) => docElAttrs.set(k, String(v)),
      },
      querySelector: () => video,
      querySelectorAll: () => [],
      addEventListener: (n, f) => { (docListeners[n] = docListeners[n] || []).push(f) },
      removeEventListener: (n, f) => {
        if (docListeners[n]) docListeners[n] = docListeners[n].filter((x) => x !== f)
      },
      dispatchEvent(ev) {
        dispatched.push(ev)
        if (cadmiumBridgeActive && ev.type === 'roku-sync-seek') {
          _ct = ev.detail.position / 1000
          for (const fn of (docListeners['roku-sync-seek-result'] || []).slice()) {
            fn({ detail: { id: ev.detail.id, error: null } })
          }
        }
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type
        this.detail = init && init.detail
      }
    },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
    },
    chrome: {
      storage: {
        local: {
          get: (_keys, cb) => {
            if (cb) cb(stored)
            return Promise.resolve(stored)
          },
        },
      },
      runtime: {
        sendMessage(m, cb) {
          messages.push(m)
          if (m.type === 'local-mirror') {
            if (!localMirrorState) cb({ error: 'local desktop server unavailable' })
            else cb({ data: Object.assign({ local_ms: now }, localMirrorState) })
            return
          }
          if (!enabled) {
            cb({ data: { disabled: true } })
            return
          }
          if (m.type === 'read') cb({ data: relayState })
          else if (m.type === 'clock') cb({ data: { server_ms: now, received_ms: now } })
          else cb({ data: { ok: true } })
        },
      },
    },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    location,
    performance: { now: () => now - 1_799_999_990_000 },
    Date: { now: () => now },
    setTimeout: (fn, delay = 0) => {
      timers.push({ fn, delay, due: now + delay })
      return timers.length
    },
    clearTimeout: () => {},
    Promise,
    Math,
    Number,
    String,
    Object,
    WeakMap,
    Set,
    Error,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    console,
  }

  vm.runInNewContext(fs.readFileSync('extension/content.js', 'utf8'), ctx)

  const step = async (advanceMs = 0) => {
    now += advanceMs
    for (let i = 0; i < 5; i += 1) {
      await new Promise(setImmediate)
      const ready = []
      const future = []
      for (const t of timers.splice(0)) {
        if (t.due <= now) ready.push(t)
        else future.push(t)
      }
      timers.push(...future)
      for (const t of ready) t.fn()
      await new Promise(setImmediate)
    }
  }

  return {
    video,
    badge,
    location,
    messages,
    dispatched,
    listeners,
    step,
    getNow: () => now,
    getCurrentTimeWrites: () => currentTimeWrites,
    resetCurrentTimeWrites: () => { currentTimeWrites = 0 },
    setLocalMirror: (next) => { localMirrorState = next },
    setState: (patch) => {
      relayState = Object.assign({}, relayState, patch, {
        last_update: patch.last_update === undefined ? now / 1000 : patch.last_update,
      })
    },
  }
}

;(async () => {
  // 1. Silent #roku-sync-ref tab waits while Roku boots YouTube, unmutes for tap,
  //    prefixes client_id with ref-, never emits play/pause/title, then locks onto Roku live position.
  {
    const env = makeEnv()
    await env.step(0)
    const tel = env.messages.find((m) => m.type === 'telemetry')
    assert.ok(tel, 'reference tab sends telemetry')
    assert.match(tel.data.client_id, /^ref-/, 'reference tab marks its client_id with ref-')
    assert.equal(env.video.muted, false, 'reference tab unmutes <video> so CoreAudio tap gets signal')
    assert.equal(env.video.volume, 1, 'reference tab sets unity volume for clean reference')
    assert.equal(env.video.paused, true, 'reference tab waits paused while Roku is still buffering/launching')
    assert.equal(env.messages.some((m) => m.type === 'event'), false, 'reference tab never sends control events')

    // Roku starts playing at 83.6s; reference tab aligns (accounting for poll age) and plays.
    env.setState({ seq: 2, roku: 'play', position_ms: 83600, launch_status: 'sent', last_update: (env.getNow() + 800) / 1000 })
    await env.step(800)
    assert.equal(env.video.paused, false, 'reference tab plays as soon as Roku plays')
    assert.ok(Math.abs(env.video.currentTime - 83.6) < 0.25, `expected ~83.6s, got ${env.video.currentTime}`)

    // Roku scrubs to 140.0s on YouTube; reference tab follows within one poll.
    env.setState({ seq: 3, roku: 'play', position_ms: 140000, last_update: (env.getNow() + 3000) / 1000 })
    await env.step(3000)
    assert.ok(Math.abs(env.video.currentTime - 140.0) < 0.25, `expected ~140s after Roku scrub, got ${env.video.currentTime}`)
  }

  // 2. Netflix frozen position_ms quirk: while Netflix plays continuously with frozen XML position_ms,
  //    reference tab advances smoothly and pauses in-place without jumping back.
  {
    const env = makeEnv({
      hostname: 'www.netflix.com',
      pathname: '/watch/80057281',
      search: '',
      hash: '#roku-sync-ref',
      initialVideo: { paused: true, currentTime: 120, muted: false, volume: 1 },
      initialState: {
        seq: 1,
        roku: 'play',
        app_id: '12',
        app_name: 'Netflix',
        title_id: '80057281',
        position_ms: 120000,
        last_update: 1_800_000_000,
        launch_status: 'sent',
        sync_mode: 'roku',
        clients: {},
      },
    })
    await env.step(0)
    assert.equal(env.video.paused, false)
    // Simulate 12 seconds of normal playback while Roku's XML freezes position_ms at 120000.
    env.video.currentTime = 132
    env.dispatched.length = 0
    env.setState({ seq: 1, roku: 'play', position_ms: 120000 })
    await env.step(12000)
    assert.equal(env.dispatched.length, 0, 'must NOT seek Netflix back to frozen 120s XML timestamp')
    assert.equal(env.video.currentTime, 132)

    // Now Roku pauses while XML still says 120000; reference tab pauses at 132s without jumping back.
    env.setState({ seq: 2, roku: 'pause', position_ms: 120000, event: { source: 'roku', action: 'pause' } })
    await env.step(800)
    assert.equal(env.video.paused, true, 'reference tab pauses when Roku pauses')
    assert.equal(env.video.currentTime, 132, 'must keep 132s rather than seeking to stale 120s')
  }

  // 3. Reference tab joins a remote browser's scheduled start (e.g. Japan starting playback with Roku).
  {
    const env = makeEnv({
      initialVideo: { paused: true, currentTime: 12, muted: false, volume: 1 },
    })
    await env.step(0)
    const fireAt = env.getNow() + 3200
    env.setState({
      seq: 2,
      roku: 'pause',
      position_ms: 45000,
      launch_status: 'sent',
      scheduled: { id: 'sched-japan-1', at_ms: fireAt, state: 'pending', roku_position_ms: 45000 },
    })
    await env.step(800)
    assert.equal(env.video.paused, true, 'stays paused before scheduled fire time')
    assert.ok(Math.abs(env.video.currentTime - 45) < 0.3, `aligned to 45s before countdown, got ${env.video.currentTime}`)
    await env.step(3000)
    assert.equal(env.video.paused, false, 'starts playing on the scheduled start timestamp')
  }

  // 4. Stale master_state (e.g. 23 hours old from yesterday) is ignored instead of seeking to hour 23,
  //    and Slave / Reference tabs auto-navigate when Master switches YouTube or Netflix titles.
  {
    const env = makeEnv({
      syncMode: 'peer',
      hash: '#roku-sync-ref',
      initialVideo: { paused: true, currentTime: 5, muted: false, volume: 1 },
    })
    await env.step(0)
    const staleStamp = env.getNow() - 85_000_000
    env.setState({
      seq: 1,
      sync_mode: 'peer',
      title_id: 'aqz-KE-bpKQ',
      master_client_id: 'japan-master',
      master_state: {
        client_id: 'japan-master',
        title_id: 'aqz-KE-bpKQ',
        app: 'youtube',
        position_ms: 0,
        paused: false,
        received_at_ms: staleStamp,
        client_ms: staleStamp,
      },
    })
    await env.step(0)
    assert.equal(env.video.currentTime, 5, 'stale 23h-old master_state must not jump video to the end')

    // Master switches to a new YouTube video -> Slave/Ref tab navigates automatically, keeping #roku-sync-ref!
    const freshNow = env.getNow()
    env.setState({
      seq: 2,
      sync_mode: 'peer',
      title_id: 'dQw4w9WgXcQ',
      event: { seq: 2, source: 'master', action: 'title', position: 0 },
      master_client_id: 'japan-master',
      master_state: {
        client_id: 'japan-master',
        title_id: 'dQw4w9WgXcQ',
        app: 'youtube',
        position_ms: 0,
        paused: false,
        received_at_ms: freshNow,
        client_ms: freshNow,
      },
    })
    await env.step(800)
    assert.equal(env.location.href, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#roku-sync-ref')
  }

  // 5. Normal interactive YouTube tab in roku mode also pauses/plays when Roku remote pauses/plays.
  {
    const env = makeEnv({
      hash: '',
      initialVideo: { paused: false, currentTime: 30, muted: false, volume: 1 },
    })
    env.setState({ seq: 1, roku: 'play', position_ms: 30000, launch_status: 'sent' })
    await env.step(0)
    env.setState({
      seq: 2,
      roku: 'pause',
      position_ms: 30500,
      event: { seq: 2, source: 'roku', action: 'pause', position: 30500 },
    })
    await env.step(800)
    assert.equal(env.video.paused, true, 'Roku remote pause pauses YouTube in Chrome too')
  }

  // 6. Direct Roku Sync.app local player timing (/api/local-mirror) syncs Netflix even when:
  //    - Netflix stripped location.hash before document_idle (captured at document_start),
  //    - global Chrome extension `enabled` is false (solo watching), and
  //    - Netflix Cadmium player-bridge handles seeking without raw video.currentTime writes!
  {
    const env = makeEnv({
      hostname: 'www.netflix.com',
      pathname: '/watch/70208247',
      search: '?trackId=14170286',
      hash: '',
      enabled: false,
      docStartRefAttr: true,
      cadmiumBridgeActive: true,
      initialVideo: { paused: true, currentTime: 4, muted: true, volume: 0.2 },
      localMirror: {
        active: true,
        source: 'local-roku',
        roku: 'play',
        app: 'netflix',
        appName: 'Netflix',
        titleId: '70208247',
        positionMs: 92500,
        paused: false,
        updatedAtMs: 1_800_000_000_000,
      },
    })
    env.resetCurrentTimeWrites()
    await env.step(0)
    assert.equal(env.video.muted, false, 'Netflix ref tab unmutes even after URL hash was stripped')
    assert.equal(env.video.paused, false, 'Netflix ref tab plays using Roku Sync.app local timing even with enabled=false')
    assert.ok(Math.abs(env.video.currentTime - 92.5) < 0.3, `expected ~92.5s from local Roku Sync.app player, got ${env.video.currentTime}`)
    assert.equal(env.getCurrentTimeWrites(), 0, 'Cadmium bridge handled seek; raw video.currentTime must NOT be written on Netflix')
    assert.equal(env.messages.some((m) => m.type === 'read'), false, 'must not hit external cloud relay when enabled=false')
  }

  // 7. Microphone-measured acoustic lead trims Chrome with playbackRate (no
  //    seek), acts once per measurement, and a restarted canceller session is
  //    not ignored because its measurement numbers start over.
  {
    const base = {
      active: true, source: 'local-roku', roku: 'play', app: 'youtube', appName: 'YouTube',
      titleId: 'aqz-KE-bpKQ', positionMs: 9000, paused: false, updatedAtMs: 1_800_000_000_000,
    }
    const env = makeEnv({ initialVideo: { paused: false, currentTime: 9, muted: false, volume: 1 }, localMirror: base })
    env.video.playbackRate = 1
    await env.step(0)
    env.resetCurrentTimeWrites()
    env.setLocalMirror(Object.assign({}, base, {
      positionMs: 9000 + 900, // coarse Roku position is 900 ms off: ignored under acoustic lock
      acoustic: { leadMs: 50, targetLeadMs: 200, seq: 7, session: 'a' },
    }))
    await env.step(500)
    assert.ok(env.video.playbackRate > 1, `Chrome 150 ms short of the target lead speeds up, got ${env.video.playbackRate}`)
    assert.equal(env.getCurrentTimeWrites(), 0, 'acoustic trim must not seek')
    assert.match(env.badge.textContent, /Echo lock/)
    await env.step(6000)
    assert.equal(env.video.playbackRate, 1, 'rate returns to 1 when the trim is done')
    await env.step(6000)
    assert.equal(env.video.playbackRate, 1, 'the same measurement is not acted on twice')
    assert.equal(env.getCurrentTimeWrites(), 0, 'no coarse seek while the mic lock is fresh')
    env.setLocalMirror(Object.assign({}, base, {
      positionMs: 9000,
      acoustic: { leadMs: 500, targetLeadMs: 200, seq: 1, session: 'b' },
    }))
    await env.step(500)
    assert.ok(env.video.playbackRate < 1, `a new canceller session with Chrome 300 ms too far ahead slows down, got ${env.video.playbackRate}`)
    env.setLocalMirror(Object.assign({}, base, { roku: 'pause', paused: true, acoustic: null }))
    await env.step(500)
    assert.equal(env.video.playbackRate, 1, 'pausing ends any trim')
  }

  console.log('Reference mirror sync, Netflix frozen-position handling, scheduled-start follower, and Slave navigation pass')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
