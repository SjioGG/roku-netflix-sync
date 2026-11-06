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


### D. Real-Time Acoustic Echo Cancellation (AEC) for Voice Calls ([BEE-222](https://linear.app/beeros/issue/BEE-222/roku-netflix-sync-build-real-time-acoustic-echo-cancellation-aec-to))
**The Problem:**
You are watching on the Roku Smart Soundbar in the room while talking to Japan on Messenger using the MacBook microphone. Because the TV audio comes out of the Roku Soundbar (not the MacBook's own speakers), macOS / Messenger's built-in voice processing does **not** have a digital loopback reference of the TV audio, so it treats loud TV dialogue/explosions as room sound and sends it over the call.

**The Solution Architecture (3 Viable Approaches):**

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
│ Python / Rust AEC Daemon on MacBook                    │
│  - Delay Estimation (Cross-correlation / GCC-PHAT)     │
│    Continuously tracks the ±300ms drift between        │
│    Chrome reference and Roku Soundbar room arrival     │
│  - Adaptive Filter (WebRTC AEC3 / SpeexDSP / NLMS)     │
│    Subtracts room impulse response * x(n - delay)      │
│  - Residual Post-Filter (RNNoise / Voice Isolation)    │
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
2. **Handling Sync Offset Between Chrome & Roku (`±300 ms`)**:
   Standard OS echo cancellers assume a fixed `< 50 ms` hardware delay between speaker and mic. Because Roku and Chrome can differ by `100–400 ms`, the AEC daemon runs a **sliding-window GCC-PHAT cross-correlator** (over a `±600 ms` buffer) every second to lock onto the exact acoustic lag \(\tau\) between the Chrome reference buffer and the MacBook mic, then feeds the delay-aligned reference \(x(t - \tau)\) into **WebRTC AudioProcessing (`aec3`)** or **SpeexDSP** before outputting to a second virtual device selected in Messenger.
3. **Hardware Zero-Drift Alternative**:
   If you want zero drift estimation, a $15 USB audio capture dongle fed from the TV's optical/aux audio-out provides the exact sample-accurate Roku audio into the MacBook as the AEC reference channel.
