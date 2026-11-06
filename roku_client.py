#!/usr/bin/env python3
"""Home-LAN bridge between a cloud ``sync_server.py`` and the local Roku.

The relay normally talks ECP straight to ``192.168.1.100:8060``. When it runs on
a cloud VPS that address is not reachable, so this client runs on the home
network instead:

1. reads ``/query/media-player`` from the Roku,
2. reports that state to ``POST /roku-bridge/state`` on the relay, which replies
   with any queued ECP requests,
3. replays each request against the Roku and posts the answer to
   ``POST /roku-bridge/result``.

Standard library only, so it runs from a plain macOS Python install or launchd.

Environment::

    SYNC_SERVER_URL   relay base URL          (default http://127.0.0.1:8766)
    SYNC_TOKEN        relay room token        (required unless the relay is open)
    ROKU_URL          Roku ECP base URL       (default http://192.168.1.100:8060)
    ROKU_CLIENT_POLL_MS  delay between polls  (default 300)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

DEFAULT_SERVER_URL = 'http://127.0.0.1:8766'
DEFAULT_ROKU_URL = 'http://192.168.1.100:8060'
DEFAULT_POLL_MS = 300
# Special command path: run the paused-position sample locally instead of
# forwarding it to the Roku. Kept identical to the relay's own sampler.
SAMPLE_PATH = '/__sample_paused'
SAMPLE_CONFIRM_TIMEOUT_S = 3.0
SAMPLE_CONFIRM_INTERVAL_S = 0.2
# Same plugin map as sync_server.STREAMING_APPS; only the active app matters here.
STREAMING_APPS = {'12': 'Netflix', '837': 'YouTube', '13535': 'Plex', '13': 'Prime Video', '291097': 'Disney Plus', '61322': 'HBO Max', '551012': 'Apple TV', '2285': 'Hulu', '624064': 'Nebula', '817397': 'Twitch'}


def http(url, data=None, method=None, timeout=5, token=None, content_type=None):
    """Open ``url`` and return the response body as bytes."""
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if content_type:
        headers['Content-Type'] = content_type
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def parse_media_player(raw):
    """Turn a ``/query/media-player`` document into bridge state fields."""
    root = ET.fromstring(raw)
    plugin = root.find('plugin')
    plugin_id = plugin.get('id') if plugin is not None else None
    position = None
    text = root.findtext('position', '') or ''
    if text.endswith(' ms'):
        first = text.split()[0]
        if first.isdigit():
            position = int(first)
    return {'roku': root.get('state', 'unknown'), 'app_id': plugin_id, 'app_name': STREAMING_APPS.get(plugin_id), 'position_ms': position}


def read_state(roku_url):
    """Read the Roku's player state, timing the round trip for calibration."""
    started = time.monotonic()
    try:
        raw = http(roku_url.rstrip('/') + '/query/media-player', timeout=3)
    except (OSError, urllib.error.URLError) as exc:
        return {'roku': 'unavailable', 'error': '%s: %s' % (type(exc).__name__, exc), 'roku_poll_ms': None}
    state = parse_media_player(raw)
    state['roku_poll_ms'] = round((time.monotonic() - started) * 1000)
    return state


def post_state(server_url, token, state):
    """Report state and return the queued commands the relay wants run."""
    payload = json.dumps(state).encode()
    body = http(server_url.rstrip('/') + '/roku-bridge/state', data=payload, method='POST', timeout=10, token=token, content_type='application/json')
    reply = json.loads(body or b'{}')
    commands = reply.get('commands') or []
    return commands if isinstance(commands, list) else []


def post_result(server_url, token, command_id, body='', error=None):
    payload = json.dumps({'id': command_id, 'body': body, 'error': error}).encode()
    http(server_url.rstrip('/') + '/roku-bridge/result', data=payload, method='POST', timeout=10, token=token, content_type='application/json')


def sample_paused(roku_url):
    """Double-toggle paused sample, run entirely against the local Roku.

    Returns the same payload shape as ``roku_dashboard.py``'s
    ``/sample-paused``. Raises ``ValueError`` when the player is not in the
    state each step expects, so the relay can report a clean 409.
    """
    started = time.monotonic()
    timings = []

    def query():
        sent = time.monotonic()
        state = parse_media_player(http(roku_url.rstrip('/') + '/query/media-player', timeout=3))
        timings.append({'operation': 'query', 'round_trip_ms': round((time.monotonic() - sent) * 1000), 'received_at_ms': round(time.time() * 1000)})
        if state['app_id'] not in STREAMING_APPS:
            raise ValueError('A supported streaming app is not the active player')
        return state

    def toggle():
        sent = time.monotonic()
        http(roku_url.rstrip('/') + '/keypress/Play', data=b'', method='POST', timeout=3)
        timings.append({'operation': 'toggle', 'round_trip_ms': round((time.monotonic() - sent) * 1000), 'received_at_ms': round(time.time() * 1000)})

    before = query()
    if before['roku'] != 'pause':
        raise ValueError('Roku must report paused before sampling; no command sent.')
    toggle()
    state = before
    deadline = time.monotonic() + SAMPLE_CONFIRM_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(SAMPLE_CONFIRM_INTERVAL_S)
        state = query()
        if state['roku'] == 'play':
            break
    if state['roku'] != 'play':
        raise ValueError('Could not confirm Roku started playing. Check the TV and pause it manually if needed; no second toggle sent.')
    toggle()
    after = state
    deadline = time.monotonic() + SAMPLE_CONFIRM_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(SAMPLE_CONFIRM_INTERVAL_S)
        after = query()
        if after['roku'] == 'pause':
            break
    if after['roku'] != 'pause':
        raise ValueError('Could not confirm Roku paused again. Check the TV.')
    return {'before': '%s ms' % before['position_ms'] if before['position_ms'] is not None else None,
            'after': '%s ms' % after['position_ms'] if after['position_ms'] is not None else None,
            'state': after['roku'], 'duration_ms': round((time.monotonic() - started) * 1000),
            'timings': timings, 'warning': 'Roku-reported values may be stale; verify against the TV.'}


def run_command(command, roku_url):
    """Execute one queued command, returning ``(body, error)``."""
    path = command.get('path') or ''
    if not isinstance(path, str) or not path.startswith('/'):
        return '', 'Invalid command path'
    if path == SAMPLE_PATH:
        try:
            return json.dumps(sample_paused(roku_url)), None
        except (ValueError, OSError, urllib.error.URLError, ET.ParseError) as exc:
            return '', str(exc)
    post = bool(command.get('post'))
    try:
        body = http(roku_url.rstrip('/') + path, data=b'' if post else None, method='POST' if post else None, timeout=15)
    except urllib.error.HTTPError as exc:
        return '', 'HTTP %s from Roku for %s' % (exc.code, path)
    except (OSError, urllib.error.URLError) as exc:
        return '', '%s: %s' % (type(exc).__name__, exc)
    return body.decode('utf-8', 'replace'), None


def run_once(server_url, token, roku_url):
    """One bridge cycle: report state, then run and answer every command.

    Returns a summary dict so callers and tests can see what happened without
    scraping logs.
    """
    state = read_state(roku_url)
    commands = post_state(server_url, token, state)
    executed = []
    for command in commands:
        if not isinstance(command, dict):
            continue
        command_id = command.get('id')
        if not command_id:
            continue
        body, error = run_command(command, roku_url)
        post_result(server_url, token, command_id, body, error)
        executed.append({'id': command_id, 'path': command.get('path'), 'error': error})
    return {'state': state, 'commands': len(commands), 'executed': executed}


def run_forever(server_url=None, token=None, roku_url=None, poll_ms=None):
    """Poll the Roku and serve relay commands until interrupted."""
    server_url = server_url or os.environ.get('SYNC_SERVER_URL', DEFAULT_SERVER_URL)
    token = token if token is not None else os.environ.get('SYNC_TOKEN', '')
    roku_url = roku_url or os.environ.get('ROKU_URL', DEFAULT_ROKU_URL)
    poll_ms = poll_ms or int(os.environ.get('ROKU_CLIENT_POLL_MS', str(DEFAULT_POLL_MS)))
    if not token:
        print('SYNC_TOKEN is not set; the relay will reject the bridge. Set it to the room token.', file=sys.stderr, flush=True)
    print('Roku bridge client: %s -> %s (Roku %s)' % (roku_url, server_url, roku_url), flush=True)
    while True:
        try:
            run_once(server_url, token, roku_url)
            time.sleep(max(0.05, poll_ms / 1000))
        except KeyboardInterrupt:
            return
        except (OSError, urllib.error.URLError, ValueError) as exc:
            print('Roku bridge cycle failed: %s' % exc, file=sys.stderr, flush=True)
            time.sleep(2)


if __name__ == '__main__':
    try:
        run_forever()
    except KeyboardInterrupt:
        pass
