# Roku Netflix Sync

Local experiment connecting Netflix in Chrome to a Roku on the same LAN.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design, roadmap, packaging guide, acoustic echo cancellation (AEC) design, and Linear tickets ([BEE-218](https://linear.app/beeros/issue/BEE-218/roku-netflix-sync-cross-country-netflix-watch-party-for-roku-chrome)).

Start both services from this folder:

```sh
python3 roku_dashboard.py
python3 sync_server.py
```

The dashboard is at http://127.0.0.1:8765. The authenticated relay is at
http://127.0.0.1:8766. Set `SYNC_TOKEN` to configure the room token (the relay
never logs the token to stdout/journald). Keep tokens out of source files.
`ROKU_URL` configures the relay's Roku endpoint; the diagnostic dashboard currently
uses the original local device address.

Load `extension/` as an unpacked Chrome extension, configure the relay URL and
token in its popup, and reload Netflix after extension updates. Chrome's Errors
panel retains old errors until cleared.

The popup's **Enable Roku sync** checkbox ([BEE-227](https://linear.app/beeros/issue/BEE-227/add-extension-enable-disable-toggle-so-solo-netflix-watching-is))
turns the extension off completely: no relay requests, no badge, and native
Netflix playback is untouched. Clear the checkbox to watch alone and tick it
again to reconnect the current tab without a reload.

The **Sync mode** selector picks between **Roku + Browser** (the default) and
**Browser-to-Browser (Master/Slave, No Roku)** ([BEE-228](https://linear.app/beeros/issue/BEE-228)). In peer mode no
Roku is needed: one tab holds the master baton and publishes its play, pause and
seek, while the other tabs follow it. The badge reads `Peer sync (Master)` or
`Peer sync (Slave)`, and clicking it passes or claims the baton, as does the
popup's **Claim / Pass Master Baton** button.

The content script now runs on Netflix, YouTube, Plex, Prime Video, Disney+,
Max, Apple TV, Hulu and Twitch ([BEE-229](https://linear.app/beeros/issue/BEE-229)). YouTube and the other HTML5 players
seek their own `<video>` element directly; Netflix keeps its Cadmium bridge.

## Native Netflix controls

The extension adds only a compact status indicator. Use Netflix's own playback
buttons, keyboard controls and timeline. There are no injected seek or sync buttons.

- Selecting a watch page requests that Netflix or YouTube title on Roku. If the
  Roku lands on the episode overview screen (Netflix) or its splash/player
  chrome (YouTube), the relay presses Select once after a short settle delay to
  start the video. YouTube's launch reports `close` for about five seconds until
  that press.
- Click the status badge to re-sync: it pauses Chrome quietly, re-samples Roku and
  re-runs the alignment sequence, which recovers a mid-episode buffer stall.
- When another Chrome client reports the same title, the badge shows its passive
  offset (for example `3s behind peer`).
- Either side can pause. Roku pause detection depends on reported player state.
- A native play from paused attempts an automatic Roku sample and future shared
  start when the title has loaded. It resumes ordinary playback if sync fails or
  takes too long. Press play again to override a pending attempt.
- While a fresh title is still loading, a play waits up to 60 s for the Roku
  player and shows a countdown on the badge instead of failing after 10 s
  ([BEE-230](https://linear.app/beeros/issue/BEE-230)). A play that already started on Roku is paused before sampling.
- Native Chrome seek events send the final scrub position after a short debounce.
  Exact Roku timestamp seeking remains unsupported by the tested Netflix app;
  Chrome's seek is kept and the status reports the limitation.
- Clock calibration uses repeated lowest-RTT measurements; pending starts are
  cancelled when playback or the title changes. An optional Roku start lead is
  configured through the extension popup.

## Measured limits

The Roku media-player response contains stream position, not a timestamp proving
when that position was displayed. HTTP acknowledgement and UI state do not prove
that a requested title or frame appeared. Roku's direct transport seek was not
reliably effective on this device, so exact seek requests remain explicitly
unsupported in the relay. Scheduled start therefore requires manually aligned
positions. Cross-country end-to-end synchronization within 500 ms is not verified.

The default bind addresses are loopback. A Cloudflare Tunnel can route to port
8766; only relay clients with the room token can control the Roku. The dashboard
is a separate local diagnostic; the relay no longer requires it (see
[Cloud relay with a home Roku bridge](#cloud-relay-with-a-home-roku-bridge)).

## Cloud relay with a home Roku bridge

Run the relay anywhere and keep only the Roku hop on the home LAN.

```
Cloud VPS / Docker            home network                 living room
sync_server.py  ◄── bridge ── roku_client.py  ──── ECP ────► Roku :8060
    :8766         state/commands                       192.168.1.100
```

`roku_client.py` reports the TV's state to the relay and executes queued ECP
requests, so `/query/media-player`, `/keypress/*`, `/launch/*`, seeks and
scheduled starts all work unchanged from the cloud.

### 1. Relay on the server

```sh
SYNC_TOKEN='pick-a-room-token' docker compose up -d
docker compose logs -f sync-server
```

`docker-compose.yml` publishes port 8766 and sets `ROKU_BRIDGE_ONLY=1`, so every
Roku command is queued for the bridge instead of dialled directly. For a bare
VPS, copy `deploy/roku-sync-server.service` to `/etc/systemd/system/`, put the
token in `/etc/roku-sync/sync.env`, then `systemctl enable --now roku-sync-server`.
`SYNC_HOST` defaults to `127.0.0.1`; set `SYNC_HOST=0.0.0.0` (or bind loopback
behind a Cloudflare Tunnel) for the container.

### 2. Bridge client at home

```sh
SYNC_SERVER_URL=https://netflix-sync.example.com \
SYNC_TOKEN='pick-a-room-token' \
ROKU_URL=http://192.168.1.100:8060 \
python3 roku_client.py
```

The client is stdlib-only Python 3 and prints one line per failed cycle. On the
Mac, `deploy/com.sjiogg.roku-bridge-client.plist` runs it under launchd (edit
the token, copy to `~/Library/LaunchAgents/`, then `launchctl load`). Logs go to
`/tmp/roku-bridge-client.log`.

The relay still dials the Roku directly when it can reach it, and switches a
request to the bridge when `ROKU_BRIDGE_ONLY=1`, or when a client reported in
the last 10 s and the configured `ROKU_URL` does not answer. `POST /sample` uses
the local dashboard when it is running and falls back to sampling through the
bridge, so no `roku_dashboard.py` is needed in the cloud.

## Acoustic echo cancellation for calls ([BEE-222](https://linear.app/beeros/issue/BEE-222/roku-netflix-sync-build-real-time-acoustic-echo-cancellation-aec-to))

`aec_daemon.py` removes the Roku soundbar's audio from the MacBook microphone
during a call. macOS cannot do this itself: the TV is a separate speaker in the
room, so there is no digital loopback for Messenger's voice processing to
subtract. The daemon supplies that loopback from the synced Chrome tab.

It is stdlib-only Python 3 (`math`, `cmath`, `array`, `struct`, `wave`,
`subprocess`, `argparse`) and uses `numpy` / `sounddevice` automatically when
they are installed.

### 1. Install the virtual audio devices (once)

```sh
brew install blackhole-2ch
```

Open **Audio MIDI Setup** and:

1. Create a **Multi-Output Device** containing **MacBook Pro Speakers** and
   **BlackHole 2ch**. Set it as the system output.
2. Create an **Aggregate Device** containing **BlackHole 2ch** and
   **BlackHole 16ch** (or `ZoomAudioDevice` when Zoom has created one).

Then route the audio:

- **Chrome** plays the synced episode into the Multi-Output Device. You still
  hear it, and BlackHole 2ch receives an exact digital copy as the AEC reference.
  Lower the Chrome tab volume if the room would otherwise play the episode twice.
- **`aec_daemon.py --live`** reads **BlackHole 2ch** (reference) and
  **MacBook Pro Microphone** (near end, which contains the Roku bleed) and writes
  the cleaned voice to **BlackHole 16ch** / **ZoomAudioDevice**.
- **Messenger** (or any call app) selects **BlackHole 16ch** / **ZoomAudioDevice**
  as its microphone.

No headphones are needed, and the TV keeps playing from the Roku soundbar.

### 2. Run the live daemon

```sh
pip install sounddevice          # or: pip install numpy sounddevice
python3 aec_daemon.py --list-devices --json   # structured devices + a recommendation
python3 aec_daemon.py --live --auto
```

`--live` auto-selects any device you do not pass explicitly ([BEE-232](https://linear.app/beeros/issue/BEE-232)): an
external USB soundcard or interface wins over the built-in mic whenever one is
plugged in, falling back to `MacBook Pro Microphone` when it is unplugged, and
never treating a virtual or Continuity (`iPhone Microphone`) device as the
physical mic. `--no-prefer-usb` keeps the built-in mic while a soundcard is
connected; `--prefer-mic-device NAME` pins a saved choice, which is ignored when
that device is gone. The only virtual device installed here is
`ZoomAudioDevice`, so the daemon uses it for both the reference and the clean
output and prints the `brew install --cask blackhole-2ch` hint for splitting the
two buses.

Pin devices manually when you want to:

```sh
python3 aec_daemon.py --live \
    --ref-device "BlackHole 2ch" \
    --mic-device "MacBook Pro Microphone" \
    --out-device "BlackHole 16ch"
```

`--list-devices --json` prints the structure the desktop app consumes:

```json
{
  "inputs":  [{"index": 0, "name": "MacBook Pro Microphone", "kind": "builtin", "channels": 1}],
  "outputs": [{"index": 1, "name": "ZoomAudioDevice", "kind": "virtual", "channels": 2}],
  "source": "system_profiler",
  "recommended": {
    "mic_device": "MacBook Pro Microphone",
    "ref_device": "ZoomAudioDevice",
    "out_device": "ZoomAudioDevice",
    "notes": ["Only one virtual audio device (ZoomAudioDevice) is installed. ..."]
  }
}
```

`kind` is one of `usb`, `builtin`, `virtual` or `continuity`, decided by name and
transport so it works through `sounddevice` or the `system_profiler` fallback.

The daemon prints the tracked Roku/Chrome lag and the live ERLE every few
blocks. `--backend ffmpeg` runs the same DSP over `ffmpeg -f avfoundation` pipes
when `sounddevice` is unavailable; it needs `--ref-index`, `--mic-index` and
`--out-index` (get the input indices from
`ffmpeg -f avfoundation -list_devices true -i ""`, and the output index from the
Audio MIDI Setup output order, since ffmpeg cannot enumerate audiotoolbox
outputs).

### 3. Verify the pipeline offline

```sh
python3 aec_daemon.py --selftest
python3 aec_daemon.py --ref-wav ref.wav --mic-wav mic.wav --out-wav clean.wav
```

`--selftest` plays a synthetic TV track through a multi-tap room response
delayed by 185 ms with a near-end speech burst on top, then prints the recovered
lag and the achieved ERLE. The WAV mode prints the same measurements for your own
recording pair, which is the quickest way to check a real living-room setup.

### How it works

1. **GCC-PHAT delay tracking** over a ±600 ms window. Normal speakerphone echo
   arrives within 30 ms, but the Roku and the Chrome tab can be offset by
   hundreds of milliseconds in either direction, so the correlator searches the
   whole span and only accepts a new lag when the correlation confidence clears
   a threshold. It needs about one second of TV audio before the first lock
   (the correlation frame has to cover the deepest lag it searches), then
   re-checks every half second; a silent or noisy reference keeps the previous
   delay.
2. **NLMS adaptive filter** on the delay-aligned reference, with a step size that
   starts high for a fast lock and decays to a small steady-state value.
3. **Double-talk detector** (Geigel bound plus a residual-to-echo ratio test) that
   freezes the filter while you speak, so your voice is passed through instead of
   being cancelled as echo.
4. **Residual echo suppressor** that attenuates the leftover nonlinear
   soundbar distortion when no near-end speech is present.

`tests/test_aec.py` covers delay recovery at ±180 ms, at least 15 dB of ERLE
through a multi-tap room response, near-end voice preservation during double
talk, the WAV CLI round trip, and device classification/auto-selection: an
external `Focusrite Scarlett 2i2 USB` or `USB PnP Sound Device` wins over the
built-in, Continuity and virtual devices, and unplugging it falls back to
`MacBook Pro Microphone`. It passes on a bare `python3` in `ubuntu-latest` with
no `pip install`.

## Desktop control center ([BEE-232](https://linear.app/beeros/issue/BEE-232))

`desktop/` is an Electron wrapper that runs both halves of the system from one
dark-mode window: the ANC microphone daemon and the Roku LAN bridge.

```sh
./bin/launch-desktop.sh            # Electron if available, else the instant web UI
./bin/launch-desktop.sh --install  # fetch Electron first (~200 MB, one time)
./bin/launch-desktop.sh --web      # force http://127.0.0.1:8767 in Chrome --app
```

The launcher never blocks on a download. It uses Electron from
`desktop/node_modules`, else unpacks an Electron zip already in
`~/Library/Caches/electron`, else starts `desktop/server.cjs` and opens
`http://127.0.0.1:8767` in a Chrome `--app` window. That last path serves the
same `index.html` and the same controller logic over HTTP, so it opens in about a
second.

- **ANC Microphone Studio** shows the detected microphone with an
  `Auto: External Soundcard` / `Auto: MacBook Mic` badge, a manual override
  dropdown, the reference loopback and the virtual mic output, live `Measured TV
  Delay`, `Echo Suppression (ERLE)` and `Speaking` / `Cancelling TV` meters, plus
  Start ANC, Stop ANC and Run 4s DSP self-test. The warning banner repeats the
  copyable `brew install --cask blackhole-2ch` command whenever only one virtual
  device exists.
- **Roku TV Bridge** edits the sync server URL, room token (with show/hide) and
  Roku LAN URL, then starts `roku_client.py` and shows the live player state, app
  and position.
- Device discovery re-runs every 4 seconds while the window is open, so plugging
  the USB soundcard in switches the active mic without a restart.

Settings persist at `~/.config/roku-netflix-sync/desktop-config.json`:
`serverUrl` (default `http://127.0.0.1:8766`), `token`, `rokuUrl` (default
`http://192.168.1.100:8060`), `autoPickSoundcard`, `preferredMicDevice`,
`preferredRefDevice` and `preferredOutDevice`.

All state, config, discovery and child-process logic lives in
`desktop/controller.cjs`, a plain Node module with no Electron import, so
`tests/desktop-app.cjs` drives the whole app under bare `node` with no display
server. `main.js` only owns the window and `ipcMain.handle` wiring
(`contextIsolation: true`, `nodeIntegration: false`), and `preload.js` exposes the
narrow `window.rokuDesktop` surface.

## Checks

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
for test in tests/*.cjs; do node "$test" || break; done
```

Python tests exercise real HTTP handler paths against mocked device I/O. JS tests
exercise extension event/race behavior and the Netflix API bridge in a simulated
page. They do not establish actual Netflix/DRM or Denmark–Japan playback behavior.
`tests/desktop-app.cjs` drives `desktop/controller.cjs` and the local UI server
directly: config persistence, live device discovery through
`aec_daemon.py --list-devices --json`, a real `--selftest --json` run, and the
spawn/stop lifecycle of both Python children.

The launcher can be checked without a display server:

```sh
./bin/launch-desktop.sh --web --no-open --port 8799   # serves http://127.0.0.1:8799
ROKU_SYNC_DESKTOP_SMOKE=1 ./bin/launch-desktop.sh --electron --foreground
```
`tests/test_aec.py` additionally needs only the standard library: it forces the
pure-Python FFT path even when `numpy` is installed, which is what the CI runner
uses.
