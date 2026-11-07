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
    ROKU_CLIENT_STATUS_JSON  1 to print one JSON status line per poll, which is
                     what the Electron desktop app parses (default off)

``python3 roku_client.py --discover [--json] [--seed-url URL]`` scans the LAN
(SSDP + arp + seeds) for Rokus and prints the AirPlay-style device list instead
of running the bridge loop.
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DEFAULT_SERVER_URL = 'http://127.0.0.1:8766'
DEFAULT_ROKU_URL = 'http://192.168.1.100:8060'
DEFAULT_POLL_MS = 300
# LAN discovery: one short SSDP window and one probe round trip per candidate.
DISCOVER_TIMEOUT_S = 1.2
SSDP_TIMEOUT_S = 0.8
SSDP_ADDRESS = ('239.255.255.250', 1900)
SSDP_SEARCH = ('M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\n'
               'Man: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 1\r\n\r\n')
# Only private-LAN ranges are worth an ECP probe.
PRIVATE_IP = re.compile(r'^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)\d')
ARP_ENTRY = re.compile(r'\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([^\s]+)', re.IGNORECASE)
SSDP_LOCATION = re.compile(r'^LOCATION:\s*(\S+)', re.IGNORECASE | re.MULTILINE)
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


def parse_device_info(xml_bytes, base_url, latency_ms=None, active_app=None):
    """Turn a Roku ``/query/device-info`` document into AirPlay-style metadata.

    ``latency_ms`` is the measured ECP round trip and ``active_app`` the app name
    from ``/query/active-app``; both are optional so the parser works on a bare
    device-info fetch too. Every field degrades to a sensible default rather
    than raising, because network devices answer with partial documents more
    often than one would hope.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        root = ET.Element('device-info')

    def text(tag):
        value = root.findtext(tag)
        return value.strip() if isinstance(value, str) else ''

    friendly_device_name = text('friendly-device-name')
    user_device_name = text('user-device-name')
    friendly_model_name = text('friendly-model-name')
    model_name = text('model-name')
    model_number = text('model-number')
    user_device_location = text('user-device-location')
    name = user_device_name or friendly_device_name or model_name or 'Roku Device'
    location = user_device_location or ''
    model = model_name or friendly_model_name or 'Roku'
    is_soundbar = 'soundbar' in model_name.lower() or 'soundbar' in friendly_device_name.lower()
    supports_airplay = text('supports-airplay').lower() == 'true'
    label = '%s (%s)' % (name, location) if location and location.lower() not in name.lower() else name
    return {
        'url': base_url,
        'name': name,
        'location': location,
        'model_name': model,
        'model_number': model_number or '',
        'vendor_name': text('vendor-name') or 'Roku',
        'serial_number': text('serial-number') or '',
        'udn': text('udn') or '',
        'network_name': text('network-name') or '',
        'network_type': text('network-type') or '',
        'power_mode': text('power-mode') or 'PowerOn',
        'software_version': text('software-version') or '',
        'supports_airplay': supports_airplay,
        'is_tv': text('is-tv').lower() == 'true',
        'is_soundbar': is_soundbar,
        'active_app': active_app,
        'latency_ms': latency_ms,
        'label': label,
    }


def ssdp_candidates(timeout=SSDP_TIMEOUT_S):
    """Ask the LAN for Roku ECP providers and return their base URLs."""
    found = []
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(max(0.05, min(timeout, SSDP_TIMEOUT_S)))
        sock.sendto(SSDP_SEARCH.encode(), SSDP_ADDRESS)
        while True:
            try:
                payload, _address = sock.recvfrom(8192)
            except (socket.timeout, OSError):
                break
            match = SSDP_LOCATION.search(payload.decode('utf-8', 'replace'))
            if not match:
                continue
            location = match.group(1)
            parsed = urllib.parse.urlsplit(location)
            if parsed.scheme not in ('http', 'https') or not parsed.netloc:
                continue
            found.append('http://%s' % parsed.netloc)
    except OSError:
        return []
    finally:
        sock.close()
    return found


def arp_candidates(runner=None):
    """Parse ``arp -a`` for plausible LAN hosts to probe for ECP."""
    runner = runner or subprocess.run
    try:
        output = runner(['arp', '-a'], capture_output=True, text=True, timeout=3).stdout or ''
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for ip, mac in ARP_ENTRY.findall(output):
        if not PRIVATE_IP.match(ip):
            continue
        if mac.lower().startswith('(incomplete'):
            continue
        found.append('http://%s' % ip)
    return found


def _probe_url(base_url, timeout):
    """Probe one candidate for ECP; return parsed metadata or ``None``."""
    root = base_url.rstrip('/')
    started = time.monotonic()
    try:
        raw = http(root + '/query/device-info', timeout=timeout)
    except (OSError, urllib.error.URLError, ValueError):
        return None
    latency_ms = round((time.monotonic() - started) * 1000)
    active_app = None
    try:
        active = ET.fromstring(http(root + '/query/active-app', timeout=timeout))
        app = active.find('app')
        if app is not None:
            active_app = (app.text or '').strip() or app.get('id')
        if not active_app:
            active_app = active.get('id') or None
    except (OSError, urllib.error.URLError, ValueError, ET.ParseError):
        active_app = None
    return parse_device_info(raw, root, latency_ms=latency_ms, active_app=active_app)


def discover_roku_devices(seed_urls=None, timeout=DISCOVER_TIMEOUT_S, include_arp=True, include_ssdp=True):
    """Find Roku devices on the LAN, AirPlay-style.

    Candidates come from explicit seeds, ``ROKU_URL``, SSDP and the ARP table,
    and every candidate is probed concurrently so a scan costs one short round
    trip rather than one per address. Returns ``{'devices': [...], 'scanned_candidates': n}``
    with the configured ``ROKU_URL`` first and the rest ordered by latency.
    """
    configured = (os.environ.get('ROKU_URL') or DEFAULT_ROKU_URL).strip()
    candidates = []

    def add(url):
        if not url:
            return
        text = str(url).strip()
        if not text:
            return
        if not text.startswith(('http://', 'https://')):
            text = 'http://' + text
        parsed = urllib.parse.urlsplit(text)
        if parsed.port is None:
            text = '%s://%s:8060' % (parsed.scheme, parsed.netloc)
        text = text.rstrip('/')
        if text not in candidates:
            candidates.append(text)

    add(configured)
    for url in seed_urls or []:
        add(url)
    if include_ssdp:
        for url in ssdp_candidates(timeout=min(timeout, SSDP_TIMEOUT_S)):
            add(url)
    if include_arp:
        for url in arp_candidates():
            add(url)

    found = {}
    lock = threading.Lock()
    probe_timeout = max(0.2, min(timeout, DISCOVER_TIMEOUT_S))

    def probe(url):
        device = _probe_url(url, probe_timeout)
        if not device:
            return
        with lock:
            found[url] = device

    threads = [threading.Thread(target=probe, args=(url,), daemon=True) for url in candidates]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + probe_timeout + 0.25
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))

    with lock:
        devices = list(found.values())
    devices.sort(key=lambda device: (
        0 if device['url'] == configured else 1,
        device.get('latency_ms') if device.get('latency_ms') is not None else 9999,
        device['name'],
    ))
    return {'devices': devices, 'scanned_candidates': len(candidates)}


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


def status_line(summary):
    """One machine-readable status line for the desktop app.

    Kept flat and small: the Electron controller only needs the connection
    state, the active app and the reported position.
    """
    state = summary.get('state') or {}
    return json.dumps({'event': 'status', 'roku': state.get('roku'),
                       'app_id': state.get('app_id'), 'app_name': state.get('app_name'),
                       'position_ms': state.get('position_ms'),
                       'roku_poll_ms': state.get('roku_poll_ms'),
                       'error': state.get('error'),
                       'commands': summary.get('commands', 0)})


def run_forever(server_url=None, token=None, roku_url=None, poll_ms=None):
    """Poll the Roku and serve relay commands until interrupted."""
    server_url = server_url or os.environ.get('SYNC_SERVER_URL', DEFAULT_SERVER_URL)
    token = token if token is not None else os.environ.get('SYNC_TOKEN', '')
    roku_url = roku_url or os.environ.get('ROKU_URL', DEFAULT_ROKU_URL)
    poll_ms = poll_ms or int(os.environ.get('ROKU_CLIENT_POLL_MS', str(DEFAULT_POLL_MS)))
    status_json = os.environ.get('ROKU_CLIENT_STATUS_JSON', '') not in ('', '0', 'false')
    if status_json:
        print(json.dumps({'event': 'start', 'server_url': server_url, 'roku_url': roku_url}),
              flush=True)
    if not token:
        print('SYNC_TOKEN is not set; the relay will reject the bridge. Set it to the room token.', file=sys.stderr, flush=True)
    if not status_json:
        print('Roku bridge client: %s -> %s (Roku %s)' % (roku_url, server_url, roku_url), flush=True)
    while True:
        try:
            summary = run_once(server_url, token, roku_url)
            if status_json:
                print(status_line(summary), flush=True)
            time.sleep(max(0.05, poll_ms / 1000))
        except KeyboardInterrupt:
            return
        except (OSError, urllib.error.URLError, ValueError) as exc:
            print('Roku bridge cycle failed: %s' % exc, file=sys.stderr, flush=True)
            if status_json:
                print(json.dumps({'event': 'status', 'roku': 'error', 'error': str(exc)}),
                      flush=True)
            time.sleep(2)


if __name__ == '__main__':
    if '--discover' in sys.argv:
        seeds = []
        for index, argument in enumerate(sys.argv):
            if argument == '--seed-url' and index + 1 < len(sys.argv):
                seeds.append(sys.argv[index + 1])
            elif argument.startswith('--seed-url='):
                seeds.append(argument.split('=', 1)[1])
        discovery = discover_roku_devices(seed_urls=seeds)
        if '--json' in sys.argv:
            print(json.dumps(discovery, indent=2))
        else:
            devices = discovery['devices']
            print('Found %d Roku device(s) from %d candidate(s)' % (len(devices), discovery['scanned_candidates']))
            for device in devices:
                details = [device['model_name']]
                if device['model_number']:
                    details.append(device['model_number'])
                if device['network_name']:
                    details.append('%s: %s' % (device['network_type'] or 'LAN', device['network_name']))
                if device['active_app']:
                    details.append('Active: %s' % device['active_app'])
                if device['latency_ms'] is not None:
                    details.append('%s ms' % device['latency_ms'])
                details.append('AirPlay Ready' if device['supports_airplay'] else 'No AirPlay')
                print('  %s  %s  %s' % (device['label'], device['url'], ' · '.join(details)))
        sys.exit(0)
    try:
        run_forever()
    except KeyboardInterrupt:
        pass
