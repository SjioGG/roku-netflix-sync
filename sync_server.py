#!/usr/bin/env python3
"""Experimental Roku/Chrome control bridge. Binds to loopback.

The operator token (``SYNC_TOKEN``) opens the Roku room. ``POST /rooms`` hands
out tokens for extra browser-to-browser rooms, which have no Roku.
"""
import copy, hashlib, hmac, json, os, re, secrets, threading, time, urllib.parse, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if __name__ == '__main__':
    from local_env import load_local_env
    load_local_env()

ROKU = os.environ.get('ROKU_URL', 'http://192.168.1.100:8060').rstrip('/')
TOKEN = os.environ.get('SYNC_TOKEN') or secrets.token_urlsafe(24)
# Local diagnostic sampler; optional now that :func:`sample_paused_direct` exists.
DASHBOARD_SAMPLE_URL = os.environ.get('DASHBOARD_SAMPLE_URL', 'http://127.0.0.1:8765/sample-paused')
# Remote Roku bridge timing: how long a queued ECP call waits for the home client,
# and how recently that client must have reported for the link to count as live.
BRIDGE_TIMEOUT_S = 5.0
BRIDGE_FRESH_S = 10.0
# Re-entrant so ``roku()`` may wait on the bridge from code that already holds the
# room lock (for example a remote keypress inside ``with lock`` in ``/event``).
lock = threading.RLock()

# Roku ECP plugin IDs for the streaming apps the relay can launch and follow.
STREAMING_APPS = {'12': 'Netflix', '837': 'YouTube', '13535': 'Plex', '13': 'Prime Video', '291097': 'Disney Plus', '61322': 'HBO Max', '551012': 'Apple TV', '2285': 'Hulu', '624064': 'Nebula', '817397': 'Twitch'}
APP_IDS_BY_NAME = {'netflix': '12', 'youtube': '837', 'plex': '13535', 'primevideo': '13', 'disneyplus': '291097', 'max': '61322', 'appletv': '551012', 'hulu': '2285', 'nebula': '624064', 'twitch': '817397'}
SYNC_MODES = ('roku', 'peer')
TITLE_ID_RE = re.compile(r'[A-Za-z0-9_-]{1,64}')
APP_NAME_RE = re.compile(r'[A-Za-z0-9_-]{1,32}')

ROOM_DEFAULTS = {'seq': 0, 'event': None, 'roku': 'unknown', 'position_ms': None, 'error': None, 'last_update': 0, 'title_id': None, 'launch_status': None, 'launch_started': None, 'timing': None, 'sample': None, 'scheduled': None, 'generation': 0, 'sampling': False, 'chrome': None, 'clients': {}, 'drift_ms': None, 'roku_poll_ms': 15, 'roku_toggle_ms': 40, 'roku_state_transition_ms': 220, 'app_id': None, 'app_name': None, 'sync_mode': 'roku', 'master_client_id': None, 'master_state': None, 'bridge_active': False, 'bridge_only': False}
shared = copy.deepcopy(ROOM_DEFAULTS)
suppress_until = 0
launch_lock = threading.Lock()
seek_lock = threading.Lock()

# --- Remote Roku bridge ------------------------------------------------------
# A cloud-hosted relay cannot reach the home LAN, so ``roku_client.py`` runs on
# the home network and long-polls ``/roku-bridge/state``. It reports what the TV
# is doing and drains queued ECP requests, so every existing feature keeps using
# plain ``roku(path, post)`` calls.
bridge_commands = []
bridge_results = {}
bridge_cond = threading.Condition(lock)
bridge_last_seen = 0.0
bridge_seq = 0


def bridge_enabled():
    """True when ECP traffic must travel through ``roku_client.py``."""
    return os.environ.get('ROKU_BRIDGE_ONLY') == '1' or bool(shared.get('bridge_only'))


def bridge_is_live(now=None):
    """True when a bridge client reported within :data:`BRIDGE_FRESH_S`."""
    seen = bridge_last_seen
    if not seen:
        return False
    return (time.monotonic() if now is None else now) - seen <= BRIDGE_FRESH_S


def reset_bridge():
    """Clear bridge queues and liveness. Tests call this between cases."""
    global bridge_last_seen, bridge_seq
    with bridge_cond:
        bridge_commands.clear()
        bridge_results.clear()
        bridge_last_seen = 0.0
        bridge_seq = 0
        bridge_cond.notify_all()
    _direct_probe.update({'at': 0.0, 'ok': None})


def bridge_roku(path, post=False, timeout=BRIDGE_TIMEOUT_S):
    """Queue one ECP request for the home client and wait for its result."""
    global bridge_seq
    command_id = secrets.token_urlsafe(9)
    command = {'id': command_id, 'path': path, 'post': bool(post)}
    with bridge_cond:
        bridge_seq += 1
        command['seq'] = bridge_seq
        bridge_commands.append(command)
        bridge_cond.notify_all()
        deadline = time.monotonic() + timeout
        while command_id not in bridge_results:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                bridge_commands[:] = [c for c in bridge_commands if c['id'] != command_id]
                raise OSError('Roku bridge timed out after %gs. Is roku_client.py running?' % timeout)
            bridge_cond.wait(remaining)
        result = bridge_results.pop(command_id)
    if result.get('error'):
        raise OSError('Roku bridge error: ' + str(result['error']))
    body = result.get('body') or ''
    return body.encode() if isinstance(body, str) else body


def roku(path, post=False):
    """Send an ECP request, locally or through a remote bridge client."""
    if bridge_enabled() or (bridge_is_live() and not direct_roku_reachable()):
        return bridge_roku(path, post)
    req = urllib.request.Request(ROKU + path, data=b'' if post else None)
    with urllib.request.urlopen(req, timeout=3) as response:
        return response.read()


_direct_probe = {'at': 0.0, 'ok': None}
DIRECT_PROBE_TTL_S = 5.0


def direct_roku_reachable():
    """Whether the configured Roku address answers from this host.

    A cloud relay cannot reach the home LAN, so a failed probe routes ECP
    traffic through the bridge client instead. Results are cached briefly: the
    state poller calls :func:`roku` every 500 ms and each probe costs a timeout.
    """
    now = time.monotonic()
    if _direct_probe['ok'] is not None and now - _direct_probe['at'] < DIRECT_PROBE_TTL_S:
        return _direct_probe['ok']
    try:
        with urllib.request.urlopen(ROKU + '/query/device-info', timeout=1) as response:
            response.read(1)
        reachable = True
    except (OSError, urllib.error.URLError, ValueError):
        reachable = False
    _direct_probe.update({'at': now, 'ok': reachable})
    return reachable

def query_roku_media():
    """Return ``(state, plugin_id, position_ms)`` for the active Roku media player."""
    root = ET.fromstring(roku('/query/media-player'))
    plugin = root.find('plugin')
    plugin_id = plugin.get('id') if plugin is not None else None
    pos = root.findtext('position', '')
    position = int(pos.split()[0]) if pos.endswith(' ms') and pos.split()[0].isdigit() else None
    return root.get('state', 'unknown'), plugin_id, position

def query_roku_player():
    """``(state, supported_streaming_app_active, position_ms)``.

    Any plugin ID listed in :data:`STREAMING_APPS` counts as active, so YouTube,
    Plex and the other video apps get the same launch/readiness treatment as
    Netflix. The active app is published on ``shared`` for the dashboard.
    """
    state, plugin_id, position = query_roku_media()
    supported = plugin_id in STREAMING_APPS
    # Plain dict assignments so callers may invoke this with ``lock`` held.
    shared['app_id'] = plugin_id if supported else None
    shared['app_name'] = STREAMING_APPS.get(plugin_id) if supported else None
    return state, supported, position

def perform_roku_seek(target_ms):
    """Uses Netflix's 10s thumbnail scrubber on Roku to jump to the nearest 10s bucket, then pauses."""
    global suppress_until
    with seek_lock:
        suppress_until = time.monotonic() + 15
        try:
            state, plugin_id, cur_ms = query_roku_media()
            if plugin_id != '12' or state not in ('play', 'pause', 'buffer'):
                raise RuntimeError('Netflix player is not active on Roku.')
            was_playing = (state == 'play')
            if state == 'play':
                roku('/keypress/Play', post=True)
                for _ in range(20):
                    time.sleep(0.15)
                    state, netflix, _ = query_roku_player()
                    if state == 'pause':
                        break
            # Always refresh paused position via quick play->pause before computing bucket delta
            roku('/keypress/Play', post=True)
            for _ in range(15):
                time.sleep(0.15)
                state, _, _ = query_roku_player()
                if state == 'play':
                    break
            roku('/keypress/Play', post=True)
            for _ in range(15):
                time.sleep(0.15)
                state, _, cur_ms = query_roku_player()
                if state == 'pause':
                    break
            if cur_ms is None:
                raise RuntimeError('Roku position unavailable before seek.')
            cur_bucket = round(cur_ms / 10000)
            target_bucket = max(0, round(target_ms / 10000))
            steps = max(-180, min(180, target_bucket - cur_bucket))
            if steps == 0:
                with lock:
                    shared.update(roku='pause', position_ms=cur_ms, last_update=time.time())
                return {'ok': True, 'before_ms': cur_ms, 'after_ms': cur_ms, 'steps': 0, 'was_playing': was_playing}
            key = 'Right' if steps > 0 else 'Left'
            # 1st press opens thumbnail scrubber at cur_bucket
            roku('/keypress/' + key, post=True)
            time.sleep(0.65)
            for _ in range(abs(steps)):
                roku('/keypress/' + key, post=True)
                time.sleep(0.14)
            time.sleep(0.15)
            roku('/keypress/Play', post=True)
            saw_transition = False
            landed_ms = cur_ms
            deadline = time.monotonic() + 7.0
            while time.monotonic() < deadline:
                time.sleep(0.12)
                state, netflix, pos = query_roku_player()
                if state in ('stop', 'buffer'):
                    saw_transition = True
                elif state == 'play' and pos is not None and (saw_transition or abs(pos - cur_ms) > 2000):
                    landed_ms = pos
                    break
            else:
                # If state remained 'stop' (e.g. seeked to 0:00), press Play once more to start playback
                if state == 'stop':
                    roku('/keypress/Play', post=True)
                    for _ in range(25):
                        time.sleep(0.15)
                        state, netflix, pos = query_roku_player()
                        if state == 'play' and pos is not None:
                            landed_ms = pos
                            break
            time.sleep(0.15)
            roku('/keypress/Play', post=True)
            for _ in range(20):
                time.sleep(0.12)
                state, netflix, pos = query_roku_player()
                if state == 'pause':
                    if pos is not None:
                        landed_ms = pos
                    break
            with lock:
                sample = {'position_ms': landed_ms, 'at_ms': round(time.time() * 1000), 'id': secrets.token_urlsafe(12), 'generation': shared['generation'], 'title_id': shared['title_id']}
                shared['sample'] = sample
                shared.update(roku='pause', position_ms=landed_ms, last_update=time.time())
            return {'ok': True, 'before_ms': cur_ms, 'after_ms': landed_ms, 'steps': steps, 'sample_id': sample['id'], 'was_playing': was_playing}
        finally:
            with lock:
                suppress_until = time.monotonic() + 2

def publish(source, action, position=None, state=None):
    state = shared if state is None else state
    state['seq'] += 1
    state['event'] = {'seq': state['seq'], 'source': source, 'action': action, 'position': position, 'time': time.time()}

AUTO_SELECT_SETTLE_S = 1.2
AUTO_RECOVERY_DELAY_S = 15.0
VERIFY_START_DELAY_S = 1.2
STALLED_LAUNCH_STATES = ('buffer', 'close', 'stop')

def recover_stalled_launch(title_id, app_id=None):
    """Second-stage launch recovery for a Roku stuck buffering or off the player.

    Called after :func:`auto_select_after_launch` has had its settle window.
    When the room is still on ``title_id`` and the Roku has not reached
    ``play``/``pause``, press ``Select`` once (Netflix overview screens) and
    re-launch the deep link if that did not help. Returns the recovery status
    string, or ``None`` when nothing needed doing.
    """
    global suppress_until
    with lock:
        if shared['title_id'] != title_id:
            return None
    try:
        state, plugin_id, position = query_roku_media()
    except (OSError, urllib.error.URLError, ET.ParseError, ValueError):
        return None
    if state not in STALLED_LAUNCH_STATES:
        return None
    with lock:
        if shared['title_id'] != title_id:
            return None
        suppress_until = time.monotonic() + 3
    try:
        roku('/keypress/Select', post=True)
    except (OSError, urllib.error.URLError):
        return None
    try:
        state, plugin_id, position = query_roku_media()
    except (OSError, urllib.error.URLError, ET.ParseError, ValueError):
        state, plugin_id, position = 'unknown', None, None
    if state not in ('play', 'pause'):
        with lock:
            known_app = shared.get('app_id')
        target = app_id if app_id in STREAMING_APPS else (known_app if known_app in STREAMING_APPS else '12')
        if target == '12':
            query = urllib.parse.urlencode({'contentID': title_id, 'mediaType': 'episode'})
        elif target == '837':
            query = urllib.parse.urlencode({'contentId': title_id, 'mediaType': 'live'})
        else:
            query = ''
        try:
            roku('/launch/' + target + ('?' + query if query else ''), post=True)
        except (OSError, urllib.error.URLError):
            return None
    with lock:
        if shared['title_id'] == title_id:
            shared['launch_status'] = 'recovered'
            return 'recovered'
    return None


def schedule_launch_recovery(title_id, app_id=None):
    """Spawn the delayed second-stage recovery in a daemon thread."""
    def worker():
        time.sleep(AUTO_SELECT_SETTLE_S + AUTO_RECOVERY_DELAY_S)
        recover_stalled_launch(title_id, app_id)
    threading.Thread(target=worker, daemon=True).start()


def client_drift_ms(title_id, now_ms, window_ms=10000, state=None):
    """Largest playback spread between recent clients watching the same title.

    Call with ``lock`` held. Returns ``None`` when fewer than two clients have
    fresh telemetry for the title, so a single viewer never sees a drift badge.
    """
    state = shared if state is None else state
    fresh=[value for value in state.get('clients',{}).values()
           if value.get('title_id')==title_id and now_ms-value.get('received_at_ms',0)<=window_ms]
    if len(fresh)<2:
        return None
    positions=[value['position_ms'] for value in fresh]
    return round(max(positions)-min(positions))

def auto_select_after_launch(title_id, app_id=None):
    """Press Select once when a launch left Roku on a menu instead of playing.

    Netflix deep links sometimes land on the episode overview (or a stalled
    player) instead of playing. YouTube behaves the same way: after
    ``/launch/837?contentId=<id>`` the Roku reports
    ``<player state="close"><plugin id="837"/></player>`` for about five seconds
    until ``Select`` is pressed, which starts the video immediately. Both apps
    are therefore treated identically; ``app_id`` is only informational.
    Skipped when the room has since moved to another title.
    """
    global suppress_until
    time.sleep(AUTO_SELECT_SETTLE_S)
    with lock:
        if shared['title_id'] != title_id:
            return False
    try:
        state, active_app, position = query_roku_player()
    except (OSError, urllib.error.URLError, ET.ParseError, ValueError):
        return False
    if state != 'close' and not active_app and state != 'stop':
        return False
    # The YouTube splash and the Netflix overview both report close/stop; a
    # position under a second at 'play' means the same thing.
    stalled = state in ('close', 'stop') or (state == 'play' and position is not None and position < 1000)
    if not stalled:
        return False
    with lock:
        if shared['title_id'] != title_id:
            return False
        suppress_until = time.monotonic() + 3
    try:
        roku('/keypress/Select', post=True)
    except (OSError, urllib.error.URLError):
        return False
    return True

def invalidate_sync(state=None):
    """Called with the room lock held whenever playback intent changes."""
    state = shared if state is None else state
    state['generation'] += 1
    state['sample'] = None
    pending = state['scheduled']
    if pending and pending['state'] == 'pending':
        pending['state'] = 'cancelled'


def poll_roku():
    """Poll the Roku directly, unless a bridge client is supplying state.

    A connected ``roku_client.py`` already polls the TV from the home LAN, so
    the relay must not spend its own requests (or log errors) on an address it
    cannot reach.
    """
    global suppress_until
    last = None
    while True:
        if bridge_enabled() or (bridge_is_live() and not direct_roku_reachable()):
            # Bridge state and its play/pause events arrive on POST /roku-bridge/state.
            if bridge_enabled() and not bridge_is_live():
                with lock:
                    if not shared.get('error'):
                        # Explain an idle room instead of leaving the last state up.
                        shared.update(error='Roku bridge client not connected', roku='unavailable')
            time.sleep(0.5)
            continue
        try:
            query_started=time.monotonic()
            root = ET.fromstring(roku('/query/media-player'))
            roku_poll_ms=round((time.monotonic()-query_started)*1000)
            state = root.get('state', 'unknown')
            plugin = root.find('plugin')
            plugin_id = plugin.get('id') if plugin is not None else None
            active = plugin_id in STREAMING_APPS
            pos = root.findtext('position', '')
            position = int(pos.split()[0]) if pos.endswith(' ms') and pos.split()[0].isdigit() else None
            with lock:
                shared.update(roku=state if active else 'not Netflix', position_ms=position, error=None, last_update=time.time(), roku_poll_ms=roku_poll_ms)
                shared['app_id'] = plugin_id if active else None
                shared['app_name'] = STREAMING_APPS.get(plugin_id) if active else None
                if active and state in ('play', 'pause'):
                    if last in ('play', 'pause') and state != last and time.monotonic() > suppress_until:
                        invalidate_sync()
                        publish('roku', state, position)
                    last = state
                else:
                    last = None
        except (OSError, ValueError, ET.ParseError, urllib.error.URLError) as exc:
            with lock: shared.update(error=str(exc), roku='unavailable')
            last = None
        time.sleep(0.5)

def verify_scheduled_start(scheduled):
    """Post-start check: recover a missed Play keypress on the Roku.

    Runs only for scheduled starts created by ``POST /schedule-start`` (those
    set ``verify: True``), so direct unit tests of
    :func:`perform_scheduled_start` stay free of background work.
    """
    if VERIFY_START_DELAY_S > 0:
        time.sleep(VERIFY_START_DELAY_S)
    with lock:
        if scheduled.get('generation') != shared['generation']:
            return False
    try:
        state, active_app, position = query_roku_player()
    except (OSError, urllib.error.URLError, ET.ParseError, ValueError):
        return False
    if state != 'pause' or not active_app:
        return False
    with lock:
        if scheduled.get('generation') != shared['generation']:
            return False
    try:
        roku('/keypress/Play', post=True)
    except (OSError, urllib.error.URLError):
        return False
    scheduled['retried_play'] = True
    return True


def perform_scheduled_start(scheduled, deadline):
    global suppress_until
    time.sleep(max(0,deadline-time.monotonic()))
    with lock:
        if scheduled['state'] != 'pending' or scheduled['generation'] != shared['generation']:
            return
        if shared['roku']!='pause' or time.time()-shared['last_update']>=2:
            scheduled['state']='aborted: Roku no longer reports paused'
            return
        suppress_until=time.monotonic()+3
        try:
            scheduled['sent_at_ms']=round(time.time()*1000)
            roku('/keypress/Play',post=True)
            scheduled['state']='sent'
            scheduled['ack_at_ms']=round(time.time()*1000)
        except (OSError,urllib.error.URLError) as exc:
            scheduled['state']='error: '+str(exc)
    if scheduled.get('state') == 'sent' and scheduled.get('verify'):
        threading.Thread(target=verify_scheduled_start,args=(scheduled,),daemon=True).start()


def sample_paused_direct():
    """Double-toggle paused position sample without the local dashboard.

    Mirrors ``roku_dashboard.py``'s ``/sample-paused`` but talks to the Roku over
    :func:`roku`, so it works when the relay is deployed away from the LAN (the
    request goes out through ``roku_client.py``). Returns the same payload shape
    the dashboard replies with, and raises ``ValueError`` for a player that is
    not paused/playing as expected.
    """
    started = time.monotonic()
    timings = []

    def query():
        sent = time.monotonic()
        root = ET.fromstring(roku('/query/media-player'))
        timings.append({'operation': 'query', 'round_trip_ms': round((time.monotonic() - sent) * 1000), 'received_at_ms': round(time.time() * 1000)})
        plugin = root.find('plugin')
        if plugin is None or plugin.get('id') not in STREAMING_APPS:
            raise ValueError('A supported streaming app is not the active player')
        return root.get('state'), root.findtext('position')

    def toggle():
        sent = time.monotonic()
        roku('/keypress/Play', post=True)
        timings.append({'operation': 'toggle', 'round_trip_ms': round((time.monotonic() - sent) * 1000), 'received_at_ms': round(time.time() * 1000)})

    state, before = query()
    if state != 'pause':
        raise ValueError('Roku must report paused before sampling; no command sent.')
    toggle()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        time.sleep(.2)
        state, _ = query()
        if state == 'play':
            break
    if state != 'play':
        raise ValueError('Could not confirm Roku started playing. Check the TV and pause it manually if needed; no second toggle sent.')
    toggle()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        time.sleep(.2)
        state, after = query()
        if state == 'pause':
            break
    if state != 'pause':
        raise ValueError('Could not confirm Roku paused again. Check the TV.')
    return {'before': before, 'after': after, 'state': state, 'duration_ms': round((time.monotonic() - started) * 1000), 'timings': timings, 'warning': 'Roku-reported values may be stale; verify against the TV.'}


def apply_sample_result(result, generation):
    """Store a completed sample on ``shared``.

    Shared by the dashboard path and :func:`sample_paused_direct` so both
    produce identical timing calibration and sample records. Returns an error
    string when playback changed while sampling.
    """
    after = result.get('after')
    timings = result.get('timings') or []
    toggle_rtts = [t['round_trip_ms'] for t in timings if isinstance(t, dict) and t.get('operation') == 'toggle' and isinstance(t.get('round_trip_ms'), (int, float))]
    toggles = [t for t in timings if isinstance(t, dict) and t.get('operation') == 'toggle' and isinstance(t.get('received_at_ms'), (int, float))]
    match = re.fullmatch(r'(\d+)\s*ms', after or '')
    if not match:
        return None
    with lock:
        if generation != shared['generation']:
            return 'Playback changed during sampling. Pause both and sample again.'
        if toggle_rtts:
            shared['roku_toggle_ms'] = round(sum(toggle_rtts) / len(toggle_rtts))
        if len(toggles) >= 2:
            shared['roku_state_transition_ms'] = max(20, min(1000, round(toggles[1]['received_at_ms'] - toggles[0]['received_at_ms'])))
        sample = {'position_ms': int(match.group(1)), 'at_ms': round(time.time() * 1000), 'id': secrets.token_urlsafe(12), 'generation': generation, 'title_id': shared['title_id']}
        shared['sample'] = sample
        shared.update(roku='pause', position_ms=sample['position_ms'], last_update=time.time())
        result['sample_id'] = sample['id']
    return None



# --- Room logic shared by the Roku room and browser rooms --------------------
CLIENT_ID_MAX = 64


def read_json_body(handler, limit):
    length=int(handler.headers.get('Content-Length','0'))
    if not 0 < length <= limit: raise ValueError('Invalid request size')
    body=json.loads(handler.rfile.read(length))
    if not isinstance(body,dict): raise ValueError('Expected a JSON object')
    return body


def _client_id(value, name='client id'):
    if value is not None and (not isinstance(value,str) or not value or len(value)>CLIENT_ID_MAX):
        raise ValueError('Invalid ' + name)
    return value


def apply_baton(state, room_lock, body, fixed_mode=None):
    """Claim, pass or change mode. Returns ``(status, reply)``.

    Anyone in the room may claim the baton; the master may pass it to a named
    client or to the most recently active other person.
    """
    action=body.get('action')
    if action not in ('claim','pass','mode'): raise ValueError('Invalid baton action')
    sync_mode=body.get('sync_mode')
    if sync_mode is not None and sync_mode not in SYNC_MODES: raise ValueError('Invalid sync mode')
    client_id=_client_id(body.get('client_id'))
    target_client_id=_client_id(body.get('target_client_id'), 'target client id')
    if action in ('claim','pass') and client_id is None: raise ValueError('Client id required')
    with room_lock:
        if sync_mode is not None and fixed_mode is None: state['sync_mode']=sync_mode
        if action == 'claim':
            state['master_client_id']=client_id
        elif action == 'pass':
            if target_client_id is not None:
                state['master_client_id']=target_client_id
            else:
                others=[cid for cid in state.get('clients',{}) if cid != client_id and not cid.startswith('ref-')]
                if others:
                    state['master_client_id']=max(others,key=lambda cid: state['clients'][cid].get('received_at_ms',0))
                else:
                    state['master_client_id']=None
        return 200, {'ok':True,'sync_mode':state['sync_mode'],'master_client_id':state['master_client_id']}


def apply_telemetry(state, room_lock, body, received_at_ms, fixed_mode=None):
    position=body.get('position_ms'); title=body.get('title_id'); paused=body.get('paused');ready=body.get('ready_state')
    client_id=body.get('client_id') or 'default'
    app=body.get('app','netflix')
    sync_mode=body.get('sync_mode')
    _client_id(client_id)
    if not isinstance(position,(int,float)) or isinstance(position,bool) or not 0 <= position <= 86400000: raise ValueError('Invalid position')
    if not isinstance(title,str) or not TITLE_ID_RE.fullmatch(title) or not isinstance(paused,bool):raise ValueError('Invalid playback metadata')
    if not isinstance(ready,int) or isinstance(ready,bool) or not 0 <= ready <= 4: raise ValueError('Invalid buffer state')
    if not isinstance(app,str) or not APP_NAME_RE.fullmatch(app): raise ValueError('Invalid app name')
    if sync_mode is not None and sync_mode not in SYNC_MODES: raise ValueError('Invalid sync mode')
    client={'title_id':title,'position_ms':round(position),'paused':paused,'ready_state':ready,'received_at_ms':received_at_ms,'client_ms':body.get('client_ms'),'app':app}
    with room_lock:
        if sync_mode is not None and fixed_mode is None: state['sync_mode']=sync_mode
        state['chrome']=dict(client)
        clients=state.setdefault('clients',{})
        clients[client_id]=dict(client)
        stale=[key for key,value in clients.items() if received_at_ms-value.get('received_at_ms',0)>60000]
        for key in stale: del clients[key]
        if state.get('master_client_id') and state['master_client_id'] not in clients:
            state['master_client_id']=None
            state['master_state']=None
        # First active human client owns the baton until someone passes it;
        # passive TV reference tabs (ref-*) never steal the baton.
        if not client_id.startswith('ref-') and state.get('master_client_id') is None:
            state['master_client_id']=client_id
        if client_id == state['master_client_id']:
            state['master_state']={'client_id':client_id,'title_id':title,'app':app,'position_ms':round(position),'paused':paused,'received_at_ms':received_at_ms,'client_ms':body.get('client_ms')}
        state['drift_ms']=client_drift_ms(title,received_at_ms,state=state)
        return 200, {'received_at_ms':received_at_ms,'drift_ms':state['drift_ms']}


def apply_peer_event(state, room_lock, body, received_at_ms):
    """Browser-to-browser title/play/pause/seek from the master. No Roku."""
    action=body.get('action')
    if action not in ('title','play','pause','seek','key'): raise ValueError('Invalid action')
    app=body.get('app','netflix')
    if not isinstance(app,str) or not APP_NAME_RE.fullmatch(app): raise ValueError('Invalid app name')
    client_id=_client_id(body.get('client_id'))
    with room_lock:
        master_client_id=state.get('master_client_id')
    if client_id is not None and master_client_id is not None and client_id != master_client_id:
        return 409, {'error':'Only the master client can control playback in peer mode. Claim the baton first.'}
    if action == 'title':
        title=body.get('title_id')
        if not isinstance(title,str) or not TITLE_ID_RE.fullmatch(title): raise ValueError('Invalid playback title ID')
        with room_lock:
            if state['title_id'] != title:
                invalidate_sync(state)
                state['title_id']=title
                state['launch_started']=time.time()
            state['launch_status']='peer'
            state['app_name']=STREAMING_APPS.get(APP_IDS_BY_NAME.get(app.lower(), '12'))
            publish('master','title',0,state)
        return 200, {'ok':True,'sent':False,'peer_mode':True}
    if action not in ('play','pause','seek'):
        return 409, {'error':'TV remote keys are unavailable in browser-to-browser mode.'}
    position=body.get('position')
    if not isinstance(position,(int,float)) or isinstance(position,bool) or not 0 <= position <= 86400000: raise ValueError('Invalid position')
    with room_lock:
        prior=(state.get('master_state') or {}).get('paused')
        paused = action == 'pause' if action in ('play','pause') else (bool(prior) if prior is not None else False)
        state['master_client_id']=client_id or state.get('master_client_id')
        owner=state['master_client_id']
        state['master_state']={'client_id':owner,'title_id':body.get('title_id') or state.get('title_id'),'app':app,'position_ms':round(position),'paused':paused,'received_at_ms':received_at_ms,'client_ms':body.get('client_ms')}
        publish('master',action,round(position),state)
    return 200, {'ok':True,'sent':False,'peer_mode':True}


# --- Browser rooms -------------------------------------------------------------
# ``POST /rooms`` needs no token, so creation is capped and rate limited and
# idle rooms expire. Rooms live in memory and vanish when the relay restarts.
ROOM_CREATION = os.environ.get('ROOM_CREATION', '1') not in ('0', 'false', 'no', '')
MAX_ROOMS = int(os.environ.get('ROOM_LIMIT', '200'))
ROOM_IDLE_S = float(os.environ.get('ROOM_IDLE_HOURS', '12')) * 3600
ROOMS_PER_IP_PER_HOUR = 10
ROOMS_PER_HOUR = 60


class PeerRoom:
    def __init__(self):
        self.lock = threading.RLock()
        self.state = copy.deepcopy(ROOM_DEFAULTS)
        self.state.update(sync_mode='peer', roku='none', room='browser')
        self.last_seen = time.monotonic()

    def touch(self):
        self.last_seen = time.monotonic()

    def view(self):
        with self.lock:
            return copy.deepcopy(self.state)


rooms = {}  # sha256(token) -> PeerRoom
rooms_lock = threading.Lock()
room_creations = []  # (monotonic time, client ip)


def _token_key(token):
    return hashlib.sha256(token.encode('utf-8', 'replace')).hexdigest()


def prune_rooms(now=None):
    """Call with ``rooms_lock`` held."""
    now = time.monotonic() if now is None else now
    for key in [k for k, room in rooms.items() if now - room.last_seen > ROOM_IDLE_S]:
        del rooms[key]
    room_creations[:] = [(at, ip) for at, ip in room_creations if now - at < 3600]


def create_room(client_ip):
    """Returns ``(status, reply)`` with a fresh room token on success."""
    if not ROOM_CREATION:
        return 403, {'error':'This relay does not create rooms.'}
    with rooms_lock:
        now = time.monotonic()
        prune_rooms(now)
        if len(rooms) >= MAX_ROOMS:
            return 503, {'error':'The relay is full. Try again later.'}
        if (len(room_creations) >= ROOMS_PER_HOUR
                or sum(1 for _, ip in room_creations if ip == client_ip) >= ROOMS_PER_IP_PER_HOUR):
            return 429, {'error':'Too many new rooms. Try again in an hour.'}
        token = secrets.token_urlsafe(24)
        rooms[_token_key(token)] = PeerRoom()
        room_creations.append((now, client_ip))
    return 201, {'token':token,'sync_mode':'peer','idle_hours':round(ROOM_IDLE_S / 3600, 1)}


def find_room(token):
    with rooms_lock:
        room = rooms.get(_token_key(token))
        if room is not None:
            if time.monotonic() - room.last_seen > ROOM_IDLE_S:
                del rooms[_token_key(token)]
                return None
            room.touch()
        return room


INVITE_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Roku Sync invite</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 1em;color:#2b2a28;background:#f6f4ef}</style>
<h1>Roku Sync invite</h1>
<p>Someone invited you to watch together.</p>
<ol><li>Install the Roku Sync extension in Chrome.</li>
<li>Copy this page's full address from the address bar.</li>
<li>Open Roku Sync, paste it under <b>Got an invite?</b>, tick the agreement and press Save.</li>
<li>Open the same Netflix or YouTube video.</li></ol>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass
    def reply(self, code, obj, cors=False):
        data=json.dumps(obj).encode(); self.send_response(code)
        self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store')
        if cors: self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+TOKEN)
    def browser_room(self):
        """The browser room for this request's token, or ``None``."""
        auth=self.headers.get('Authorization','')
        if not auth.startswith('Bearer ') or len(auth) > 200: return None
        return find_room(auth[7:])
    def client_ip(self):
        # The relay binds to loopback behind a proxy, which sets these headers.
        forwarded=self.headers.get('CF-Connecting-IP') or (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        return forwarded or self.client_address[0]
    def clock_reply(self, state, room_lock):
        received_ms=time.time_ns()//1000000
        with room_lock:
            poll_ms=state.get('roku_poll_ms',15)
            toggle_ms=state.get('roku_toggle_ms',40)
            transition_ms=state.get('roku_state_transition_ms',220)
        return self.reply(200, {'server_ms':time.time_ns()//1000000, 'received_ms':received_ms, 'roku_poll_ms':poll_ms, 'roku_toggle_ms':toggle_ms, 'roku_state_transition_ms':transition_ms})
    def browser_room_request(self, room, method, received_at_ms=None):
        if method == 'GET':
            if self.path == '/clock': return self.clock_reply(room.state, room.lock)
            if self.path == '/sync': return self.reply(200, room.view())
            return self.reply(404, {'error':'Not found'})
        handlers={'/telemetry': lambda body: apply_telemetry(room.state, room.lock, body, received_at_ms, fixed_mode='peer'),
                  '/baton': lambda body: apply_baton(room.state, room.lock, body, fixed_mode='peer'),
                  '/event': lambda body: apply_peer_event(room.state, room.lock, body, received_at_ms)}
        if self.path not in handlers:
            return self.reply(409, {'error':'Browser rooms have no Roku TV.'})
        try:
            return self.reply(*handlers[self.path](read_json_body(self, 1024)))
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            return self.reply(400,{'error':str(e)})
    def do_OPTIONS(self):
        if self.path != '/rooms': return self.reply(404, {'error':'Not found'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Methods','POST')
        self.send_header('Access-Control-Max-Age','600')
        self.send_header('Content-Length','0'); self.end_headers()
    def bridge_state(self):
        """``roku_client.py`` reports the TV's state and drains queued commands."""
        global bridge_last_seen
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 4096: raise ValueError('Invalid request')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('Expected a JSON object')
            state=body.get('roku')
            if not isinstance(state,str) or not state or len(state)>32: raise ValueError('Invalid Roku state')
            position=body.get('position_ms')
            if position is not None and (not isinstance(position,(int,float)) or isinstance(position,bool) or not 0 <= position <= 86400000):
                raise ValueError('Invalid position')
            poll_ms=body.get('roku_poll_ms')
            if poll_ms is not None and (not isinstance(poll_ms,(int,float)) or isinstance(poll_ms,bool) or not 0 <= poll_ms <= 60000):
                raise ValueError('Invalid poll timing')
            app_id=body.get('app_id'); app_name=body.get('app_name'); error=body.get('error')
            if app_id is not None and (not isinstance(app_id,str) or len(app_id)>32): raise ValueError('Invalid app id')
            if app_name is not None and (not isinstance(app_name,str) or len(app_name)>32): raise ValueError('Invalid app name')
            if error is not None and not isinstance(error,str): raise ValueError('Invalid error')
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            return self.reply(400,{'error':str(e)})
        active = bool(app_id) and app_id in STREAMING_APPS
        with bridge_cond:
            bridge_last_seen = time.monotonic()
            # Mirror poll_roku(): a non-streaming app is reported as "not Netflix"
            # while a transport error keeps its own value.
            reported = state if active or error else 'not Netflix'
            last = shared.get('roku')
            shared.update(roku=reported,
                          position_ms=round(position) if position is not None else None,
                          error=error, last_update=time.time(), bridge_active=True,
                          app_id=app_id if active else None,
                          app_name=app_name or (STREAMING_APPS.get(app_id) if active else None))
            if poll_ms is not None: shared['roku_poll_ms']=round(poll_ms)
            if active and state in ('play','pause') and last in ('play','pause') and state != last and time.monotonic() > suppress_until:
                invalidate_sync()
                publish('roku', state, shared['position_ms'])
            pending=list(bridge_commands)
            bridge_commands.clear()
        return self.reply(200,{'ok':True,'commands':pending})

    def bridge_result(self):
        """``roku_client.py`` returns the body (or error) for one command."""
        global bridge_last_seen
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 1024*1024: raise ValueError('Invalid request')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('Expected a JSON object')
            command_id=body.get('id')
            if not isinstance(command_id,str) or not command_id or len(command_id)>64: raise ValueError('Invalid command id')
            result_body=body.get('body') or ''
            if not isinstance(result_body,str): raise ValueError('Invalid command body')
            error=body.get('error')
            if error is not None and not isinstance(error,str): raise ValueError('Invalid error')
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            return self.reply(400,{'error':str(e)})
        with bridge_cond:
            bridge_last_seen = time.monotonic()
            bridge_results[command_id]={'body':result_body,'error':error or None,'at':time.monotonic()}
            # The command has been executed, so drop it in case the waiter timed out.
            bridge_commands[:]=[c for c in bridge_commands if c['id'] != command_id]
            # Drop results nobody collected: the waiter gave up or the client went away.
            stale=[key for key,value in bridge_results.items() if time.monotonic()-value['at']>120]
            for key in stale: del bridge_results[key]
            bridge_cond.notify_all()
        return self.reply(200,{'ok':True})

    def bridge_command(self):
        """Queue one ECP request and wait for the bridge client's reply.

        ``roku()`` already routes automatically, so this endpoint is for clients
        that want to drive the TV explicitly. Reply is ``{'ok': True, 'body': str}``.
        """
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 1024: raise ValueError('Invalid request')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('Expected a JSON object')
            path=body.get('path')
            if not isinstance(path,str) or not path.startswith('/') or len(path)>512: raise ValueError('Invalid path')
            post=bool(body.get('post'))
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            return self.reply(400,{'error':str(e)})
        if not bridge_is_live() or not bridge_enabled():
            return self.reply(409,{'error':'No Roku bridge client is connected.'})
        try:
            result=bridge_roku(path,post)
        except OSError as exc:
            return self.reply(502,{'error':str(exc)})
        return self.reply(200,{'ok':True,'body':result.decode('utf-8','replace')})

    def do_GET(self):
        if self.path == '/' or self.path.startswith('/?'):
            # Invite links point here; the room token stays in the URL fragment.
            page=INVITE_PAGE.encode()
            self.send_response(200)
            self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Cache-Control','no-store')
            self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'")
            self.send_header('Content-Length',str(len(page))); self.end_headers(); self.wfile.write(page)
            return
        if not self.authorized():
            room=self.browser_room()
            if room is None: return self.reply(401, {'error':'Unauthorized'})
            return self.browser_room_request(room, 'GET')
        if self.path == '/clock':
            return self.clock_reply(shared, lock)
        if self.path != '/sync': return self.reply(404, {'error':'Not found'})
        with lock: data=dict(shared)
        data.setdefault('room','roku')
        self.reply(200, data)
    def do_POST(self):
        received_at_ms = round(time.time() * 1000)
        global suppress_until, bridge_last_seen
        if self.path == '/rooms':
            return self.reply(*create_room(self.client_ip()), cors=True)
        if not self.authorized():
            room=self.browser_room()
            if room is None: return self.reply(401, {'error':'Unauthorized'})
            return self.browser_room_request(room, 'POST', received_at_ms)
        if self.path == '/roku-bridge/state':
            return self.bridge_state()
        if self.path == '/roku-bridge/result':
            return self.bridge_result()
        if self.path == '/roku-bridge/command':
            return self.bridge_command()
        if self.path == '/baton':
            try:
                body=read_json_body(self, 1024)
                return self.reply(*apply_baton(shared, lock, body))
            except (ValueError,TypeError,json.JSONDecodeError) as e:return self.reply(400,{'error':str(e)})
        if self.path == '/telemetry':
            try:
                body=read_json_body(self, 1024)
                return self.reply(*apply_telemetry(shared, lock, body, received_at_ms))
            except (ValueError,TypeError,json.JSONDecodeError) as e:return self.reply(400,{'error':str(e)})
        if self.path == '/sample':
            with lock:
                if shared['roku'] != 'pause' or time.time()-shared['last_update'] >= 2:
                    return self.reply(409, {'error':'Roku must report a fresh paused state.'})
                if shared['sampling']: return self.reply(409, {'error':'A position sample is already running.'})
                invalidate_sync()
                generation=shared['generation']
                shared['sampling']=True
                suppress_until=time.monotonic()+10
                use_bridge = bridge_enabled() or (bridge_is_live() and not direct_roku_reachable())
            reply_code = 200
            reply_payload = None
            try:
                if use_bridge:
                    # Cloud deployments have no local dashboard; sample directly.
                    try:
                        result=sample_paused_direct()
                    except ValueError as e:
                        reply_code, reply_payload = 409, {'error':str(e)}
                    except (OSError, urllib.error.URLError, ET.ParseError) as e:
                        reply_code, reply_payload = 502, {'error':str(e)+'. Check whether the Roku is paused.'}
                    else:
                        changed=apply_sample_result(result,generation)
                        if changed:
                            reply_code, reply_payload = 409, {'error':changed}
                        else:
                            reply_code, reply_payload = 200, result
                else:
                    try:
                        request=urllib.request.Request(DASHBOARD_SAMPLE_URL,data=b'',method='POST',headers={'Content-Type':'application/json'})
                        with urllib.request.urlopen(request,timeout=9) as response: result=json.load(response)
                    except (urllib.error.URLError, OSError) as exc:
                        # No dashboard on this host: fall back to the direct sampler.
                        if isinstance(exc, urllib.error.HTTPError):
                            raise
                        try:
                            result=sample_paused_direct()
                        except ValueError as e:
                            reply_code, reply_payload = 409, {'error':str(e)}
                        except (OSError, urllib.error.URLError, ET.ParseError) as e:
                            reply_code, reply_payload = 502, {'error':str(e)+'. Check whether the Roku is paused.'}
                    if reply_payload is None:
                        changed=apply_sample_result(result,generation)
                        if changed:
                            reply_code, reply_payload = 409, {'error':changed}
                        else:
                            reply_code, reply_payload = 200, result
            except urllib.error.HTTPError as e:
                try: result=json.load(e)
                except (ValueError, OSError): result={'error':'Roku sample failed; check the TV.'}
                reply_code, reply_payload = e.code, result
            except (OSError, urllib.error.URLError, ValueError) as e:
                reply_code, reply_payload = 502, {'error':str(e)+'. Check whether the Roku is paused.'}
            finally:
                with lock:
                    shared['sampling']=False
                    suppress_until=time.monotonic()+2
            return self.reply(reply_code, reply_payload)
        if self.path == '/cancel-start':
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0 < length <= 1024: raise ValueError('Invalid request')
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict): raise ValueError('Expected a JSON object')
                with lock:
                    scheduled=shared['scheduled']
                    if not scheduled or scheduled['id']!=body.get('id') or scheduled['state']!='pending': return self.reply(409,{'error':'Start already sent or unavailable.'})
                    scheduled['state']='cancelled'
                return self.reply(200,{'ok':True})
            except (ValueError,TypeError,json.JSONDecodeError) as e:return self.reply(400,{'error':str(e)})
        if self.path == '/schedule-start':
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0 < length <= 1024: raise ValueError('Invalid request')
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict): raise ValueError('Expected a JSON object')
                position=body.get('position_ms'); sample_id=body.get('sample_id')
                lead_ms=body.get('lead_ms',3000)
                roku_lead_ms=body.get('roku_lead_ms',0)
                if not isinstance(lead_ms,(int,float)) or not 3000 <= lead_ms <= 15000: raise ValueError('Start lead must be between 3000 and 15000 ms')
                if not isinstance(roku_lead_ms,(int,float)) or not -1000 <= roku_lead_ms <= 1000: raise ValueError('Roku calibration must be between -1000 and 1000 ms')
                if not isinstance(position,(int,float)) or isinstance(position,bool) or not 0 <= position <= 86400000: raise ValueError('Invalid position')
                with lock:
                    sample=shared['sample']
                    if not sample or sample['id']!=sample_id or time.time()*1000-sample['at_ms']>30000: return self.reply(409,{'error':'Position sample expired. Sample both players again.'})
                    if sample.get('generation',shared['generation']) != shared['generation']: return self.reply(409,{'error':'Playback changed after sample. Sample again.'})
                    if shared['roku']!='pause' or time.time()-shared['last_update']>=2: return self.reply(409,{'error':'Roku is not reporting paused.'})
                    if abs(position-sample['position_ms'])>500: return self.reply(409,{'error':f"Positions differ by {abs(round(position-sample['position_ms']))} ms. Align them manually and sample again."})
                    if shared['scheduled'] and shared['scheduled']['state']=='pending': return self.reply(409,{'error':'A start is already scheduled.'})
                    roku_one_way_ms=round(shared.get('roku_poll_ms',15)/2 + shared.get('roku_toggle_ms',40)/2)
                    effective_lead_ms=round(roku_lead_ms + roku_one_way_ms)
                    start_ms=round(time.time()*1000)+round(lead_ms)
                    deadline=time.monotonic()+(lead_ms-effective_lead_ms)/1000
                    scheduled={'id':secrets.token_urlsafe(12),'at_ms':start_ms,'roku_position_ms':sample['position_ms'],'state':'pending','generation':shared['generation'],'roku_lead_ms':roku_lead_ms,'roku_one_way_ms':roku_one_way_ms,'effective_lead_ms':effective_lead_ms,'verify':True}
                    shared['scheduled']=scheduled
                    shared['sample']=None
                threading.Thread(target=perform_scheduled_start,args=(scheduled,deadline),daemon=True).start()
                return self.reply(200,{'start_ms':start_ms,'id':scheduled['id'],'roku_position_ms':sample['position_ms'],'roku_one_way_ms':roku_one_way_ms,'effective_lead_ms':effective_lead_ms})
            except (ValueError,TypeError,json.JSONDecodeError) as e:return self.reply(400,{'error':str(e)})
        if self.path != '/event': return self.reply(404, {'error':'Not found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 1024: raise ValueError('Invalid request size')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('Expected a JSON object')
            action=body.get('action')
            if action not in ('title','play','pause','seek','key'): raise ValueError('Invalid action')
            app=body.get('app','netflix')
            if not isinstance(app,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}',app): raise ValueError('Invalid app name')
            client_id=body.get('client_id')
            if client_id is not None and (not isinstance(client_id,str) or not client_id or len(client_id)>64):
                raise ValueError('Invalid client id')
            requested_mode=body.get('sync_mode')
            if requested_mode is not None and requested_mode not in SYNC_MODES: raise ValueError('Invalid sync mode')
            with lock:
                peer_mode = requested_mode == 'peer' or shared.get('sync_mode') == 'peer'
                if requested_mode is not None: shared['sync_mode'] = requested_mode
            if action == 'title':
                title = body.get('title_id')
                if not isinstance(title, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', title): raise ValueError('Invalid playback title ID')
                target_app_id = APP_IDS_BY_NAME.get(str(app).lower(), '12')
                if peer_mode:
                    return self.reply(*apply_peer_event(shared, lock, body, received_at_ms))
                with lock:
                    if shared['title_id'] == title and shared['launch_status'] in ('sending', 'sent'):
                        return self.reply(200, {'ok':True, 'message':'Title already requested'})
                    invalidate_sync()
                    shared['title_id'] = title
                    shared['app_name'] = STREAMING_APPS.get(target_app_id)
                    shared['launch_status'] = 'sending'
                    shared['launch_started'] = time.time()
                def launch_title():
                    with launch_lock:
                        with lock:
                            if shared['title_id'] != title:
                                return
                        try:
                            if target_app_id == '12':
                                active = ET.fromstring(roku('/query/active-app'))
                                current = active.find('app')
                                endpoint = '/input' if current is not None and current.get('id') == '12' else '/launch/12'
                                params = urllib.parse.urlencode({'contentID':title, 'mediaType':'episode'})
                                roku(endpoint + '?' + params, post=True)
                            elif target_app_id == '837':
                                params = urllib.parse.urlencode({'contentId':title, 'mediaType':'live'})
                                roku('/launch/837?' + params, post=True)
                            else:
                                active = ET.fromstring(roku('/query/active-app'))
                                current = active.find('app')
                                if current is None or current.get('id') != target_app_id:
                                    roku('/launch/' + target_app_id, post=True)
                            result = 'sent'
                        except (OSError, urllib.error.URLError, ET.ParseError) as exc:
                            result = 'unconfirmed: ' + str(exc)
                        with lock:
                            if shared['title_id'] == title: shared['launch_status'] = result
                        if result == 'sent':
                            auto_select_after_launch(title, target_app_id)
                            schedule_launch_recovery(title, target_app_id)
                threading.Thread(target=launch_title, daemon=True).start()
                return self.reply(202, {'ok':True, 'message':'Title launch requested; check TV'})
            if peer_mode:
                return self.reply(*apply_peer_event(shared, lock, body, received_at_ms))
            if action == 'key':
                key=body.get('key')
                if key not in {'Rev','Fwd','Play','Left','Right','Select','InstantReplay','Back','Up','Down','Info'}:
                    raise ValueError('Unknown playback key')
                with lock:
                    if shared['roku'] not in {'play','pause','buffer','stop'} or time.time()-shared['last_update']>=2:
                        return self.reply(409,{'error':'Netflix playback state unavailable. No key sent.'})
                    invalidate_sync()
                    suppress_until=time.monotonic()+3
                    try:
                        roku('/keypress/'+key,post=True)
                    except (OSError,urllib.error.URLError) as exc:
                        return self.reply(502,{'error':str(exc)})
                return self.reply(200,{'ok':True,'sent':True,'warning':f'TV remote key ({key}) sent.'})
            position=body.get('position')
            if not isinstance(position,(int,float)) or isinstance(position,bool) or not 0 <= position <= 86400000: raise ValueError('Invalid position')
            if action == 'seek':
                with lock:
                    if shared['roku'] not in {'play','pause','buffer'} or time.time()-shared['last_update']>=2:
                        return self.reply(409, {'error':'Roku playback state unavailable; cannot seek.'})
                    invalidate_sync()
                try:
                    result = perform_roku_seek(round(position))
                    return self.reply(200, result)
                except (OSError, urllib.error.URLError, ET.ParseError, RuntimeError) as exc:
                    return self.reply(502, {'error': str(exc)})
            with lock:
                invalidate_sync()
                current=shared['roku']; fresh=time.time()-shared['last_update'] < 2
                if not fresh or current not in ('play','pause'):
                    return self.reply(409, {'error':'Roku playback state unavailable; no command sent.'})
                if current == action:
                    return self.reply(200, {'ok':True, 'sent':False})
                suppress_until=time.monotonic()+3
                try:
                    command_start=time.monotonic()
                    command_sent_at_ms=round(time.time()*1000)
                    roku('/keypress/Play', post=True)
                    shared['timing']={'received_at_ms':received_at_ms,'command_sent_at_ms':command_sent_at_ms,'roku_response_at_ms':round(time.time()*1000),'roku_request_ms':round((time.monotonic()-command_start)*1000)}
                except (OSError, urllib.error.URLError) as exc:
                    suppress_until=0
                    return self.reply(502, {'error':str(exc)})
            self.reply(200, {'ok':True, 'sent':True, 'warning':'Toggle sent; verify Roku playback state.'})
        except (ValueError, TypeError, json.JSONDecodeError) as exc: self.reply(400, {'error':str(exc)})

if __name__ == '__main__':
    SYNC_HOST = os.environ.get('SYNC_HOST', '127.0.0.1')
    SYNC_PORT = int(os.environ.get('SYNC_PORT', '8766'))
    threading.Thread(target=poll_roku, daemon=True).start()
    print('Sync relay: http://%s:%d (room token configured; never logged)' % (SYNC_HOST, SYNC_PORT), flush=True)
    if bridge_enabled():
        print('Roku mode: bridge (commands are queued for roku_client.py)', flush=True)
    server = ThreadingHTTPServer((SYNC_HOST, SYNC_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
