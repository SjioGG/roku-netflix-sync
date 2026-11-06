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

- Selecting a watch page requests that Netflix title on Roku. If Netflix lands on
  the episode overview screen, the relay presses Select once after a short settle
  delay to start the episode.
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
is a separate local diagnostic, required by the relay's sample endpoint.

## Checks

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
for test in tests/*.cjs; do node "$test" || break; done
```

Python tests exercise real HTTP handler paths against mocked device I/O. JS tests
exercise extension event/race behavior and the Netflix API bridge in a simulated
page. They do not establish actual Netflix/DRM or Denmark–Japan playback behavior.
