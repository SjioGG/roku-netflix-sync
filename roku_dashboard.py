#!/usr/bin/env python3
import json
import re
import urllib.parse
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROKU = 'http://192.168.1.100:8060'
KEYS = {'Home', 'Back', 'Up', 'Down', 'Left', 'Right', 'Select', 'Play', 'Rev', 'Fwd', 'InstantReplay', 'Info'}
# Roku ECP plugin IDs for the streaming apps the sampler accepts as a live player.
STREAMING_APPS = {'12': 'Netflix', '837': 'YouTube', '13535': 'Plex', '13': 'Prime Video', '291097': 'Disney Plus', '61322': 'HBO Max', '551012': 'Apple TV', '2285': 'Hulu', '624064': 'Nebula', '817397': 'Twitch'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def reply(self, status, data, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data if isinstance(data, bytes) else json.dumps(data).encode())

    def do_GET(self):
        if self.path == '/':
            return self.reply(200, Path(__file__).with_name('dashboard.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path != '/state':
            return self.reply(404, {'error': 'Not found'})
        try:
            start = time.monotonic()
            with urllib.request.urlopen(ROKU + '/query/media-player', timeout=3) as response:
                raw = response.read().decode('utf-8')
            root = ET.fromstring(raw)
            self.reply(200, {'state': root.attrib, 'children': [{ 'tag': c.tag, 'attributes': c.attrib, 'text': c.text } for c in root], 'raw': raw, 'latency_ms': round((time.monotonic() - start) * 1000)})
        except (urllib.error.URLError, TimeoutError, ET.ParseError, OSError) as e:
            self.reply(502, {'error': str(e)})

    def do_POST(self):
        if self.path == '/sample-paused':
            started = time.monotonic()
            timings = []
            def query():
                sent = time.monotonic()
                with urllib.request.urlopen(ROKU + '/query/media-player', timeout=3) as response:
                    raw = response.read().decode('utf-8')
                timings.append({'operation':'query','round_trip_ms':round((time.monotonic()-sent)*1000),'received_at_ms':round(time.time()*1000)})
                root = ET.fromstring(raw)
                plugin = root.find('plugin')
                if plugin is None or plugin.get('id') not in STREAMING_APPS:
                    raise ValueError('A supported streaming app is not the active player')
                return root.get('state'), root.findtext('position')
            def toggle():
                sent = time.monotonic()
                req = urllib.request.Request(ROKU + '/keypress/Play', data=b'', method='POST')
                with urllib.request.urlopen(req, timeout=3): pass
                timings.append({'operation':'toggle','round_trip_ms':round((time.monotonic()-sent)*1000),'received_at_ms':round(time.time()*1000)})
            try:
                state, before = query()
                if state != 'pause': return self.reply(409, {'error':'Roku must report paused before sampling; no command sent.'})
                toggle()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    time.sleep(.2)
                    state, _ = query()
                    if state == 'play': break
                if state != 'play': return self.reply(409, {'error':'Could not confirm Roku started playing. Check the TV and pause it manually if needed; no second toggle sent.'})
                toggle()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    time.sleep(.2)
                    state, after = query()
                    if state == 'pause': break
                if state != 'pause': return self.reply(409, {'error':'Could not confirm Roku paused again. Check the TV.'})
                return self.reply(200, {'before':before, 'after':after, 'state':state, 'duration_ms':round((time.monotonic()-started)*1000), 'timings':timings, 'warning':'Roku-reported values may be stale; verify against the TV.'})
            except (urllib.error.URLError, TimeoutError, ET.ParseError, OSError, ValueError) as e:
                return self.reply(502, {'error':str(e) + '. Check whether the TV is paused.'})
        if self.path == '/seek':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 512: raise ValueError('Input too long')
                body = json.loads(self.rfile.read(length))
                seconds = int(body.get('seconds', 0))
                if not -3600 <= seconds <= 3600 or seconds == 0: raise ValueError('Choose a nonzero seek within one hour')
                steps = max(-180, min(180, round(seconds / 10)))
                if steps == 0:
                    steps = 1 if seconds > 0 else -1
                with urllib.request.urlopen(ROKU + '/query/media-player', timeout=3) as response:
                    root = ET.fromstring(response.read().decode('utf-8'))
                was_playing = root.get('state') == 'play'
                key = 'Right' if steps > 0 else 'Left'
                urllib.request.urlopen(urllib.request.Request(ROKU + '/keypress/' + key, data=b'', method='POST'), timeout=3).close()
                time.sleep(0.65)
                for _ in range(abs(steps)):
                    urllib.request.urlopen(urllib.request.Request(ROKU + '/keypress/' + key, data=b'', method='POST'), timeout=3).close()
                    time.sleep(0.14)
                time.sleep(0.15)
                urllib.request.urlopen(urllib.request.Request(ROKU + '/keypress/Play', data=b'', method='POST'), timeout=3).close()
                deadline = time.monotonic() + 6.0
                saw_buf = False
                landed = None
                while time.monotonic() < deadline:
                    time.sleep(0.12)
                    with urllib.request.urlopen(ROKU + '/query/media-player', timeout=3) as response:
                        r2 = ET.fromstring(response.read().decode('utf-8'))
                    st = r2.get('state')
                    if st in ('stop', 'buffer'): saw_buf = True
                    elif st == 'play' and saw_buf:
                        landed = r2.findtext('position')
                        break
                if not was_playing:
                    time.sleep(0.15)
                    urllib.request.urlopen(urllib.request.Request(ROKU + '/keypress/Play', data=b'', method='POST'), timeout=3).close()
                return self.reply(200, {'ok': True, 'steps': steps, 'after': landed})
            except (ValueError, TypeError, json.JSONDecodeError) as e:
                return self.reply(400, {'error': str(e)})
            except (urllib.error.URLError, TimeoutError, ET.ParseError, OSError) as e:
                return self.reply(502, {'error': str(e)})
        if self.path == '/launch':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 2048: raise ValueError('Input too long')
                body = json.loads(self.rfile.read(length))
                value = body.get('link', '').strip()
                match = re.fullmatch(r'(?:https?://(?:www\.)?netflix\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:title|watch)/)?(\d+)(?:[/?#].*)?', value, re.I)
                media_type = body.get('type')
                if not match or media_type not in {'movie', 'episode', 'series'}:
                    raise ValueError('Enter a Netflix title/watch link or numeric ID and choose its type')
                query = urllib.parse.urlencode({'contentID': match.group(1), 'mediaType': media_type})
                req = urllib.request.Request(ROKU + '/launch/12?' + query, data=b'', method='POST')
                with urllib.request.urlopen(req, timeout=5): pass
                return self.reply(200, {'ok': True, 'id': match.group(1)})
            except (ValueError, TypeError, json.JSONDecodeError) as e:
                return self.reply(400, {'error': str(e)})
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                return self.reply(502, {'error': str(e)})
        key = self.path.removeprefix('/key/')
        if not self.path.startswith('/key/') or key not in KEYS:
            return self.reply(404, {'error': 'Unknown key'})
        try:
            req = urllib.request.Request(ROKU + '/keypress/' + key, data=b'', method='POST')
            with urllib.request.urlopen(req, timeout=3): pass
            self.reply(200, {'ok': True})
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.reply(502, {'error': str(e)})

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
    print('Open http://127.0.0.1:8765', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
