# Roku Netflix Sync

Local experiment connecting Netflix in Chrome to a Roku on the same LAN.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design, roadmap, packaging guide, acoustic echo cancellation (AEC) design, and Linear tickets ([BEE-218](https://linear.app/beeros/issue/BEE-218/roku-netflix-sync-cross-country-netflix-watch-party-for-roku-chrome)).

Start both services from this folder:

```sh
python3 roku_dashboard.py
python3 sync_server.py
```

The dashboard is at http://127.0.0.1:8765. The authenticated relay is at
http://127.0.0.1:8766. The relay prints a room token on startup. Set `SYNC_TOKEN`
to retain a chosen token across restarts. Keep tokens out of source files.
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

## Checks

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
for test in tests/*.cjs; do node "$test" || break; done
```

Python tests exercise real HTTP handler paths against mocked device I/O. JS tests
exercise extension event/race behavior and the Netflix API bridge in a simulated
page. They do not establish actual Netflix/DRM or Denmark–Japan playback behavior.
