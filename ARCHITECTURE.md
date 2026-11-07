# Roku + Chrome Netflix Sync Architecture & Roadmap

Tracked in Linear under **Beeros (`BEE`) → `Build: Software`**:
- **Parent:** [BEE-218: roku-netflix-sync: Cross-country Netflix watch party for Roku + Chrome with AEC voice chat](https://linear.app/beeros/issue/BEE-218/roku-netflix-sync-cross-country-netflix-watch-party-for-roku-chrome)
- **QoL & Sync Polish:** [BEE-219: Add QoL sync features (auto episode-menu Select, Skip Intro sync, drift monitor, multi-client rooms)](https://linear.app/beeros/issue/BEE-219/roku-netflix-sync-add-qol-sync-features-auto-episode-menu-select-skip)
- **Japan Tunnel & Latency Validation:** [BEE-220: Expose relay over Cloudflare Tunnel / ZeroTier and validate <500ms sync to Japan](https://linear.app/beeros/issue/BEE-220/roku-netflix-sync-expose-relay-over-cloudflare-tunnel-zerotier-and)
- **Extension Packaging & Distribution:** [BEE-221: Package Chrome MV3 extension for easy install and auto-updates](https://linear.app/beeros/issue/BEE-221/roku-netflix-sync-package-chrome-mv3-extension-for-easy-install-and)
- **Enable/Disable Toggle:** [BEE-227: Add extension enable/disable toggle so solo Netflix watching is uninterrupted](https://linear.app/beeros/issue/BEE-227/add-extension-enable-disable-toggle-so-solo-netflix-watching-is)
- **Microphone Acoustic Echo Cancellation (AEC):** [BEE-222: Build real-time acoustic echo cancellation (AEC) to strip Roku TV audio from MacBook mic on calls](https://linear.app/beeros/issue/BEE-222/roku-netflix-sync-build-real-time-acoustic-echo-cancellation-aec-to)
- **Browser-to-Browser Peer Mode:** [BEE-228: Add Roku-less browser-to-browser Master/Slave sync mode with baton passing](https://linear.app/beeros/issue/BEE-228)
- **Multi-App Streaming Support:** [BEE-229: Add YouTube, Plex, and universal HTML5 streaming app support](https://linear.app/beeros/issue/BEE-229)
- **Roku Load Readiness:** [BEE-230: Harden Roku load readiness (60s patience, auto-retry, pre-start settle)](https://linear.app/beeros/issue/BEE-230)
- **Cloud Relay & Roku Bridge:** [BEE-231: Host the relay in the cloud with a home-network Roku bridge client](https://linear.app/beeros/issue/BEE-231)

---

## 1. System Architecture (Current Working State)

Because Netflix enforces Widevine / PlayReady DRM on video streams, rebroadcasting video from a server produces a black screen or requires unauthorized decryption. Instead, each device streams Netflix natively while the local server coordinates **title selection, timeline seeking, position sampling, and latency-compensated start times**.

```
┌─────────────────────────────────────────┐         HTTPS (Cloudflare Tunnel)         ┌───────────────────────────────────────────────┐
│ Chrome Client (Japan / Local MacBook)   │ ◄───────────────────────────────────────► │ Sync Relay (`sync_server.py`, :8766)          │
│                                         │   GET /sync, /clock                       │  - Bearer Token Auth                          │
│ - `content.js` (Isolated World)         │   POST /event, /sample, /schedule-start   │  - 500ms Roku ECP state poller                │
│    Hooks native <video> play/pause/seek  │   POST /telemetry                         │  - Double-toggle paused position sampler      │
│    Runs 5x NTP `/clock` burst            │                                           │  - 10s thumbnail scrubber seek engine         │
│ - `player-bridge.js` (MAIN World)       │                                           │  - Latency-compensated scheduled start worker │
│    Calls Netflix Cadmium `player.seek()` │                                           └──────────────────────┬────────────────────────┘
└─────────────────────────────────────────┘                                                                  │
                                                                                                             │ LAN HTTP (:8060 ECP)
                                                                                                             ▼
                                                                                      ┌───────────────────────────────────────────────┐
                                                                                      │ Roku Smart Soundbar (`192.168.1.100:8060`)     │
                                                                                      │  - `GET /query/media-player` (state/position) │
                                                                                      │  - `POST /launch/12` & `/input` (deep links)  │
                                                                                      │  - `POST /keypress/{Play,Left,Right,Select}`  │
                                                                                      └───────────────────────────────────────────────┘
```

### Key Technical Mechanisms Discovered & Implemented

1. **Refreshed Paused Position Sampling ("Double-Pause Trick")**:
   - Roku's `GET /query/media-player` returns `<position>XXXX ms</position>`, but Netflix on Roku freezes that reported number while playing or after pausing.
   - It only refreshes when transitioning into `play`.
   - `POST /sample` (via `roku_dashboard.py`'s `/sample-paused`) verifies Roku is paused, sends `Play` \(\rightarrow\) waits for `state="play"` (~220 ms) \(\rightarrow\) sends `Play` \(\rightarrow\) waits for `state="pause"`, yielding a fresh millisecond timestamp accurate to the on-screen timeline.

2. **Roku Thumbnail Scrubber Seeking (`perform_roku_seek`)**:
   - Netflix on Roku ignores ECP transport seek commands (`/input/12?type=transport&command=seek`).
   - Camera + telemetry inspection proved that pressing `Right` or `Left` **once** only opens Netflix's thumbnail scrubber strip at the current 10-second bucket (e.g. `01:00`).
   - Waiting `650 ms` for the strip to open and then sending \(N\) additional `Right`/`Left` presses spaced `140 ms` apart steps the scrubber by **exact 10-second increments**, and pressing `Play` commits the seek.
   - Once Roku transitions through `stop`/`buffer` to `play` at the new keyframe, the server pauses Roku, records the exact landed millisecond as a fresh sample, and Chrome aligns to that exact millisecond via `player-bridge.js` (`netflix.appContext.state.playerApp.getAPI().videoPlayer`).

3. **Ping / Clock-Offset Math & Player Trim (`<500 ms` Sync)**:
   - Before every synchronized start, Chrome runs a 5-ping burst against `GET /clock` and takes the lowest-RTT sample to compute the NTP clock offset and one-way network latency:
     $$\text{offset} = \frac{T_{\text{server\_recv}} + T_{\text{server\_send}}}{2} - \left(T_{\text{client\_send}} + \frac{\text{RTT}}{2}\right)$$
   - The server schedules `start_ms` in the future (`lead_ms = max(3000, 2000 + 4 * RTT)`).
   - The server also tracks its live LAN latency to the Roku (`roku_one_way_ms` from `roku_poll_ms` and `roku_toggle_ms`, ~27 ms) plus the empirical player unpause trim (`rokuLeadMs`, `-300 ms` because Chrome's HTML5 player unpauses ~300 ms slower than Roku's hardware decoder).

---

## 2. What Needs to Be Built Next (Roadmap)

### A. QoL Features & Edge Cases ([BEE-219](https://linear.app/beeros/issue/BEE-219/roku-netflix-sync-add-qol-sync-features-auto-episode-menu-select-skip))
- **Auto-Advance Past Roku Episode Menu on Launch** (implemented):
  When Chrome opens a new `/watch/<id>`, Roku `/launch/12?contentID=<id>&mediaType=episode` sometimes lands on the episode overview screen ("Play" button highlighted) instead of starting playback. `auto_select_after_launch()` waits a 1.2 s settle delay, then sends one `/keypress/Select` when Roku reports `close`/`stop`, or `play` at `< 1000 ms`. The check is skipped if the room has moved on to another title.
- **YouTube Launch Auto-Select** (implemented):
  `/launch/837?contentId=<id>` leaves the Roku reporting `<player state="close"><plugin id="837" name="YouTube"/></player>` for about five seconds until `/keypress/Select` arrives, which starts the video immediately. `auto_select_after_launch(title_id, app_id)` now runs for YouTube (`837`) exactly as for Netflix (`12`): `close`/`stop` (or `play` under one second) gets one `Select`, and the launch handler passes the target app id so both paths stay identical.
- **Click-to-Resync & Passive Drift Badge** (implemented):
  The status badge is clickable on any `/watch/<id>` page. A click pauses Chrome quietly, re-samples Roku and re-runs the full sample → align → scheduled-start sequence, so a mid-episode buffer stall does not need a page reload. When another Chrome client reports telemetry for the same title, the badge also shows the passive offset (`Ns behind peer` / `Ns ahead of peer`) once the gap exceeds 1 s.
- **Multi-Client Telemetry** (implemented):
  `POST /telemetry` accepts an optional `client_id` (up to 64 chars, default `default`). Each client is stored in `shared['clients']` and pruned after 60 s of silence, while `shared['chrome']` keeps the latest payload for backward compatibility. The reply includes `drift_ms`, the largest position spread between fresh clients on that title.
- **"Skip Intro" / "Skip Recap" / "Next Episode" Sync**:
  Clicking Netflix's native "Skip Intro" button in Chrome jumps `video.currentTime` forward by ~85 seconds while playing. Rapid native jumps already flow through the same debounced seek path as scrubs; verifying the exact result against the Roku thumbnail scrubber is still open.

### B. Japan Tunnel & Cross-Country Testing ([BEE-220](https://linear.app/beeros/issue/BEE-220/roku-netflix-sync-expose-relay-over-cloudflare-tunnel-zerotier-and))
- **Cloudflare Tunnel (`cloudflared`) Setup**:
  Expose `http://127.0.0.1:8766` via a dedicated HTTPS hostname (e.g. `netflix-sync.<your-domain>`) using `cloudflared` (or ZeroTier between Denmark and Japan).
- **CORS & Preflight Handling**:
  MV3 `background.js` runs `fetch()` from the extension service worker (which bypasses page CORS when host permissions or `<all_urls>` / optional permissions are granted), or add `https://*/*` to `host_permissions` in `extension/manifest.json` so the extension can reach your custom Cloudflare Tunnel domain without permission errors.
- **High-RTT & Jitter Validation**:
  Run a recorded calibration pass over a ~220–280 ms Denmark \(\leftrightarrow\) Japan link to verify the 5-sample minimum-RTT clock filter and tune the default player trim.

### C. Extension Packaging & Distribution ([BEE-221](https://linear.app/beeros/issue/BEE-221/roku-netflix-sync-package-chrome-mv3-extension-for-easy-install-and))
How to share the extension with the viewer in Japan:
- **Why raw `.crx` files are blocked**:
  Modern Chrome on macOS and Windows blocks dragging-and-dropping self-signed `.crx` files ("Package is invalid: CRX_REQUIRED_PROOF_MISSING") unless the extension comes from the Chrome Web Store or is force-installed via enterprise policy.
- **Option 1 (Easiest 2-minute setup for 1 friend): Unpacked `.zip`**:
  Run `./bin/package-extension.sh` to create `dist/roku-netflix-sync-extension.zip`. Send the zip, unzip it to a folder, open `chrome://extensions`, toggle **Developer mode** on, and click **Load unpacked**.
- **Option 2 (Best UX + auto-updates): Chrome Web Store "Unlisted"**:
  Upload `dist/roku-netflix-sync-extension.zip` to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) ($5 one-time registration) with visibility set to **Unlisted**. Only people with the direct link can install it in 1 click, and Chrome auto-updates it whenever you push a new version.
- **Host Permissions for Tunnel URL**:
  Before packaging for Japan, add `"host_permissions": ["http://127.0.0.1:8766/*", "http://localhost:8766/*", "https://*/*"]` in `extension/manifest.json` so the service worker can talk to your HTTPS Cloudflare Tunnel URL.
- **What `bin/package-extension.sh` checks**:
  The script validates `extension/manifest.json` with `python3 -m json.tool`, resolves every script and HTML file the manifest references and fails if one is missing, then writes `dist/roku-netflix-sync-extension.zip` and prints its contents and size. `tests/test_relay.py::test_package_script_builds_expected_zip` runs it and asserts the archive contains `manifest.json`, `background.js`, `content.js`, `player-bridge.js`, `popup.html`, and `popup.js`.

### C2. Extension Enable/Disable Toggle ([BEE-227](https://linear.app/beeros/issue/BEE-227/add-extension-enable-disable-toggle-so-solo-netflix-watching-is))
The popup has an **Enable Roku sync** checkbox at the top, persisted as `enabled` in `chrome.storage.local` and defaulting to `true`.

- The popup saves the checkbox immediately on `change` and also includes it when **Save** is clicked.
- `background.js` reads `enabled` with the other settings and returns `{disabled: true}` before any relay fetch, so a disabled extension never touches the network.
- `content.js` keeps a `syncEnabled` flag mirrored from storage (`chrome.storage.local.get` plus `chrome.storage.onChanged`). On disable it cancels any pending start, clears `pendingSeek`, hides the badge, ignores every native `play`/`pause`/`seeked` event, and stops sending `/sync`, `/telemetry` and `/event`. On re-enable it shows the badge and restarts `poll()` immediately, so no page reload is needed. A `{disabled: true}` reply from the service worker disables the content script too, which covers the popup being toggled before the tab re-reads storage.

With sync disabled Netflix behaves exactly as if the extension were not installed, which is the solo-watching path.

### C3. Browser-to-Browser Peer Mode with Baton Passing ([BEE-228](https://linear.app/beeros/issue/BEE-228))
When there is no Roku in the room, both viewers use Chrome. `shared['sync_mode']` is `'roku'` (default) or `'peer'`, and `shared['master_client_id']` names the tab that currently holds the baton.

- `POST /baton` takes `{'action': 'claim' | 'pass' | 'mode', 'client_id', 'target_client_id'?, 'sync_mode'?}`. `claim` puts the baton on that client, `pass` hands it to `target_client_id` or to the freshest other client in `shared['clients']` (clearing it when no peer is connected), and `mode` switches `roku`/`peer`.
- `POST /telemetry` promotes the first active client to Master, then records `shared['master_state']` only for the baton holder, so a slave's own playback never overwrites the room.
- `POST /event` rejects a slave with `409` in peer mode; the Master's play/pause/seek is published as a `master` event and returns without any Roku command.
- The badge shows `Peer sync (Master)` or `Peer sync (Slave)`, and clicking it passes or claims the baton. A slave maps `master_state` onto its own `<video>`, aligning when the offset exceeds 500–600 ms.

### C4. Multi-App Streaming Support ([BEE-229](https://linear.app/beeros/issue/BEE-229))
`content.js` runs on Netflix, YouTube, Plex, Prime Video, Disney+, Max, Apple TV, Hulu and Twitch. `detectMedia()` derives `{app, titleId}` from the host and URL: Netflix `/watch/<id>`, YouTube `?v=` and `/shorts/<id>`, Plex hash or metadata keys reduced to a relay-safe slug, and a `pathSlug` for other supported hosts when a `<video>` is present. Title IDs are validated with `[A-Za-z0-9_-]{1,64}`, so YouTube IDs and Plex metadata keys are accepted next to numeric Netflix IDs.

`alignChrome()` seeks the plain HTML5 element for non-Netflix apps and keeps the Cadmium `roku-sync-seek` bridge for Netflix. On the Roku side, `STREAMING_APPS` maps plugin IDs (`12` Netflix, `837` YouTube, `13535` Plex, plus Prime Video, Disney+, HBO Max, Apple TV, Hulu, Nebula, Twitch); any of them counts as an active player for polling and sampling, and `?app=` on `action: title` chooses the launch target. YouTube launches via `/launch/837?contentId=<id>&mediaType=live`, and the other apps relaunch only when the active app differs.

### C5. Hardened Roku Load Readiness ([BEE-230](https://linear.app/beeros/issue/BEE-230))
- `verify_scheduled_start()` runs 1.2 s after a scheduled start and presses `Play` once more if the Roku still reports `pause`, which recovers a dropped keypress. Only `/schedule-start` sets `'verify': True`, so direct `perform_scheduled_start` calls spawn no thread.
- `recover_stalled_launch()` is the second-stage launch recovery, 15 s after the initial settle: a Roku still in `buffer`, `close` or `stop` gets one `Select`, then a deep-link relaunch if that did not help, and `launch_status` becomes `'recovered'`.
- When a play arrives while a fresh title is loading, `waitForRokuReady()` polls `/sync` every 750 ms for up to 60 s, showing `Waiting for Roku to finish loading… (Ns left)`, and pauses a Roku that started playing before running the sample and 3 s countdown. A play from an already-paused Roku keeps the original 10 s timeout.


### C6. Cloud Relay and Home Roku Bridge ([BEE-231](https://linear.app/beeros/issue/BEE-231))
The relay can run on a cloud VPS while the Roku stays on the home LAN. `roku_client.py` (stdlib only) is the only hop that touches the TV.

```
Chrome clients ── HTTPS ──► sync_server.py (cloud, :8766) ◄── bridge ── roku_client.py (home) ── ECP ──► Roku
```

- **State in**: `POST /roku-bridge/state` (same `Bearer <TOKEN>`) carries `{roku, app_id, app_name, position_ms, roku_poll_ms, error}`. It updates `shared` (`bridge_active`, `last_update`) and publishes a `roku` play/pause event when the state changed outside the suppression window, mirroring `poll_roku`. The reply is `{'ok': True, 'commands': [...]}`.
- **Commands out**: `roku(path, post)` queues `{id, path, post}` on `bridge_commands` and blocks up to 5 s on `bridge_cond` for `bridge_results[id]`, returning the body as bytes or raising `OSError`. So `/query/media-player`, `/keypress/*`, `/launch/*`, `perform_roku_seek` and `verify_scheduled_start` need no changes. `POST /roku-bridge/result` stores `{id, body, error}` and notifies the waiter; `POST /roku-bridge/command` exposes the same queue for explicit callers.
- **When the bridge is used**: `ROKU_BRIDGE_ONLY=1` (or `shared['bridge_only']`) always routes through it; otherwise the relay keeps dialling the Roku and falls back to the bridge when a client reported within 10 s (`bridge_is_live`) and `ROKU_URL/query/device-info` does not answer. The reachability probe is cached for 5 s so the 500 ms poller does not pay a timeout each cycle. With a live bridge, `poll_roku` idles and lets the client supply state.
- **Sampling without the dashboard**: `sample_paused_direct()` runs the double-toggle against `roku()` and `apply_sample_result()` records the sample and timing calibration used by `/clock` and `/schedule-start`. `POST /sample` still tries `127.0.0.1:8765/sample-paused` first, and falls back to the direct sampler when the bridge is in use or the dashboard is unreachable.
- **Deployment**: `Dockerfile` (`python:3.12-slim`, `SYNC_HOST=0.0.0.0`, `SYNC_PORT=8766`, `ROKU_BRIDGE_ONLY=1`, unprivileged user, healthcheck), `docker-compose.yml` (`SYNC_TOKEN` required, read-only rootfs), `deploy/roku-sync-server.service` (systemd, loopback bind, hardened), and `deploy/com.sjiogg.roku-bridge-client.plist` (launchd `KeepAlive` for the Mac). The relay reads `SYNC_HOST`/`SYNC_PORT` in `__main__`.

### D. Real-Time Acoustic Echo Cancellation (AEC) for Voice Calls — implemented ([BEE-222](https://linear.app/beeros/issue/BEE-222/roku-netflix-sync-build-real-time-acoustic-echo-cancellation-aec-to))
**The Problem:**
You are watching on the Roku Smart Soundbar in the room while talking to Japan on Messenger using the MacBook microphone. Because the TV audio comes out of the Roku Soundbar (not the MacBook's own speakers), macOS / Messenger's built-in voice processing does **not** have a digital loopback reference of the TV audio, so it treats loud TV dialogue/explosions as room sound and sends it over the call.

**The Solution Architecture:**

```
┌────────────────────────────────────────────────────────┐
│ Reference Signal (Clean Netflix Audio)                 │
│  Option A: Local Chrome tab synced within ~200ms,      │
│            routed silently to BlackHole 2ch (0dB room) │
│  Option B: HDMI Audio Extractor / Line-In from TV      │
└───────────────────────────┬────────────────────────────┘
                            │ Far-End Reference x(n)
                            ▼
┌────────────────────────────────────────────────────────┐
│ aec_daemon.py on MacBook (stdlib; numpy/sounddevice    │
│ optional)                                              │
│  - Delay Estimation: GCC-PHAT over ±600 ms             │
│    Tracks the drift between the Chrome reference and   │
│    the Roku Soundbar's room arrival                     │
│  - Adaptive Filter: NLMS on x(n - τ)                   │
│    Subtracts room impulse response * x(n - delay)      │
│  - Geigel / residual double-talk detector              │
│  - Residual echo suppressor (nonlinear tail)           │
└───────────────────────────┬────────────────────────────┘
                            ▲ Near-End Mic d(n) = Voice + TV Room Echo
┌───────────────────────────┴────────────────────────────┐
│ MacBook Built-in Microphone                            │
└────────────────────────────────────────────────────────┘
                            │ Clean Voice Output e(n)
                            ▼
┌────────────────────────────────────────────────────────┐
│ Virtual Audio Device (`BlackHole 16ch` / Clean Mic)    │
│  Selected as Microphone Input in Messenger             │
└────────────────────────────────────────────────────────┘
```

1. **Why Local Chrome Reference + Delay-Tracking AEC Works**:
   Because your MacBook already has the exact same Netflix episode open and synced within `< 500 ms` of the Roku Soundbar, routing Chrome's audio output to a silent virtual audio device (`BlackHole 2ch`, `brew install blackhole-2ch`) gives your MacBook a crystal-clear digital reference of the TV track without playing double audio in the room.
2. **Handling Sync Offset Between Chrome & Roku (`±500 ms`)**:
   Standard OS echo cancellers assume a fixed `< 50 ms` hardware delay between speaker and mic. Because Roku and Chrome can differ by hundreds of milliseconds in either direction, the AEC daemon runs a **sliding-window GCC-PHAT cross-correlator** (over a `±600 ms` buffer) every half second to lock onto the exact acoustic lag \(\tau\) between the Chrome reference buffer and the MacBook mic, then feeds the delay-aligned reference \(x(t - \tau)\) into the NLMS adaptive filter before outputting to a second virtual device selected in Messenger. The "WebRTC AEC3 / SpeexDSP" variant was not used: both assume a short, fixed hardware delay and would need an explicit delay-compensation ring buffer anyway, so the engine implements the delay tracker, filter, double-talk detector and residual suppressor directly and stays stdlib-only.
3. **Hardware Zero-Drift Alternative**:
   If you want zero drift estimation, a $15 USB audio capture dongle fed from the TV's optical/aux audio-out provides the exact sample-accurate Roku audio into the MacBook as the AEC reference channel.

**Implemented engine (`aec_daemon.py`, stdlib only):**
Standard OS echo cancellers assume a fixed `< 50 ms` speaker-to-mic delay, and none of them can see the Roku's soundbar at all. `aec_daemon.py` implements the three stages above directly so it runs from a bare `python3` on the Mac and on the CI runner, with `numpy` and `sounddevice` used automatically when present.

```
Chrome (synced tab) ─► Multi-Output Device ─┬─► MacBook Speakers (you hear it)
                                            └─► BlackHole 2ch ──┐  reference x(n)
                                                                 ▼
                                              ┌────────────────────────────────┐
MacBook Pro Microphone ──► d(n) = voice + TV ─┤ aec_daemon.py --live           │
                                              │  1. GCC-PHAT lag (radix-2 FFT) │
                                              │  2. NLMS + Geigel/residual DTD │
                                              │  3. Residual echo suppressor   │
                                              └───────────────┬────────────────┘
                                                              ▼ e(n) clean voice
                                              BlackHole 16ch / ZoomAudioDevice
                                                              ▼
                                              Messenger microphone input
```

1. **`estimate_delay_samples(ref_frame, mic_frame, max_lag_samples)`** computes
   \(\tau\) over `[-max_lag, +max_lag]` with
   $$R_{xy}(\tau) = \mathcal{F}^{-1}\left[\frac{X(\omega)Y^*(\omega)}{|X(\omega)Y^*(\omega)| + \epsilon}\right]$$
   using an in-place iterative radix-2 Cooley-Tukey FFT/IFFT on a power-of-two
   buffer (`numpy.fft.rfft`/`irfft` on the fast path). The peak is refined with a
   parabolic fit and then scored with a normalised cross-correlation to produce
   the confidence the caller gates on. The convention is `mic[n] ≈ ref[n - τ]`,
   so a **positive** lag means the Roku soundbar is behind Chrome and a
   **negative** lag means Chrome is behind the Roku. ±600 ms covers the observed
   drift in both directions with room to spare.
2. **`AcousticEchoCanceller`** keeps a reference ring buffer of
   `max_delay_ms + filter_length` samples (plus the GCC frame), re-estimates the
   lag every `delay_update_s` (0.5 s) only while the reference is above the
   silence floor and double talk is not active, and only accepts a new lag whose
   confidence clears `delay_confidence` (0.4). The correlation frame is 1.5× the
   search span so every candidate lag still overlaps the reference by a third of
   the frame; below 16 kHz it is decimated before the FFT and the winning lag is
   refined at the native rate. This sets the first lock at about one second of
   TV audio, after which updates run on a rolling window. A jump of
   `delay_reset_samples` samples blanks the taps, so a re-lock never drags a
   stale room response into the new alignment. The delay-aligned reference vector
   feeds a 256-tap NLMS filter:
   \(\hat{y}(n) = \mathbf{w}^T\mathbf{x}(n-\tau)\), \(e(n) = d(n) - \hat{y}(n)\),
   with \(\mu\) starting at 0.5 and decaying toward `mu_min` so the initial lock is
   fast and the steady-state misadjustment is small.
3. **Double-talk detector**: a Geigel bound
   `|d(n)| > ξ · ||h||₁ · ||x(n)||₂` (which holds from silence, so it never
   blocks the first convergence) plus, once a residual-to-microphone ratio proves
   the filter has genuinely converged, a test that fires when the residual climbs
   back toward the predicted echo power. While triggered, the filter is frozen and
   the suppressor is bypassed, so the far-end caller hears the user's voice.
4. **Residual echo suppressor** applies a soft Wiener-style gate
   \(g = \frac{e^2/\hat{y}^2}{e^2/\hat{y}^2 + k}\) to the output only when no
   near-end speech is present, which cleans up the nonlinear soundbar distortion
   an NLMS filter cannot model.
5. **Stats**: `process_frame` returns the clean block plus `delay_ms`,
   `confidence`, `erle_db` (block-smoothed
   \(10\log_{10}\sum d^2/\sum e^2\)), `erle_total_db`, `double_talk`,
   `filter_energy`, `mu` and `latency_ms` (non-zero only in the Chrome-behind-Roku
   case, where the output must be held back by the lag).
6. **CLI modes**: `--list-devices` (sounddevice, else `ffmpeg -f avfoundation
   -list_devices`, else `system_profiler SPAudioDataType`),
   `--ref-wav/--mic-wav/--out-wav` (16-bit PCM in, printed delay and ERLE, 16-bit
   PCM out), `--live` (sounddevice streams, or `--backend ffmpeg` over
   `avfoundation` pipes), and `--selftest` (synthetic TV track + multi-tap room
   response + 185 ms offset + near-end burst, printing recovered lag and ERLE).

**Measured macOS setup** (no headphones, TV keeps playing):
- `brew install blackhole-2ch`, then in Audio MIDI Setup a **Multi-Output Device**
  (MacBook Pro Speakers + BlackHole 2ch) as the system output so Chrome's audio is
  both audible and captured digitally, and an **Aggregate Device**
  (BlackHole 2ch + BlackHole 16ch) as the daemon's device set.
- Chrome's synced episode plays into the Multi-Output Device; the daemon reads
  BlackHole 2ch as the reference and the MacBook Pro Microphone as the near end,
  and writes the cleaned voice to BlackHole 16ch / `ZoomAudioDevice`, which the
  call app selects as its microphone.
- Chrome's tab volume can be lowered (or the tab left out of the room mix entirely
  and the Roku left to make the room sound) without losing the reference.

**Verification** (`tests/test_aec.py`, no `pip install` needed):
- `test_gcc_phat_recovers_positive_and_negative_tv_drift` — ±180 ms and −120 ms
  recovered within ±2 samples through a room response.
- `test_nlms_cancels_room_echo_by_at_least_15db` — ≥15 dB steady-state ERLE with
  the room impulse `[0.7, -0.25, 0.12, ...]` at a +150 ms offset.
- `test_tracks_a_lag_near_the_search_limit` — a ±500 ms offset at 8 kHz and
  16 kHz is tracked exactly. This guards the correlation-window length, which
  silently broke offsets beyond ~250 ms when the window was shorter than the
  search span.
- `test_double_talk_preserves_near_end_voice` — the burst survives, the detector
  fires, weights stay bounded and cancellation resumes afterwards.
- `test_wav_cli_round_trip` — the CLI pipeline writes a WAV with lower echo energy
  than the input mic.
- `StdlibPathTest` forces `aec._np = None` so the pure-Python FFT is exercised
  even on a machine that has numpy, which is the GitHub Actions configuration.

**Measured on this machine** (stdlib path, no numpy): 5x realtime at 16 kHz and
9x at 8 kHz, 73–79 dB ERLE after four seconds of synthetic TV audio, exact lag
recovery at ±500 ms, and about 3% of one core for the periodic delay re-estimate.
