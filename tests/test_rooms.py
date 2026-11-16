"""Browser rooms: ``POST /rooms`` tokens, isolation and the baton."""
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, '.')
import sync_server as relay  # noqa: E402


class BrowserRoomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        relay.TOKEN = 'operator-token'
        cls.server = relay.ThreadingHTTPServer(('127.0.0.1', 0), relay.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = 'http://127.0.0.1:%d' % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        with relay.rooms_lock:
            relay.rooms.clear()
            relay.room_creations.clear()
        with relay.lock:
            relay.shared.update(sync_mode='roku', master_client_id=None, master_state=None, clients={}, title_id=None)

    def call(self, path, body=None, token=None, method=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=dict(headers or {}))
        if token:
            request.add_header('Authorization', 'Bearer ' + token)
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read() or b'{}'), dict(response.headers)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b'{}'), dict(error.headers)

    def new_room(self, ip='203.0.113.5'):
        status, data, headers = self.call('/rooms', method='POST', headers={'CF-Connecting-IP': ip})
        self.assertEqual(status, 201, data)
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')
        return data['token']

    def telemetry(self, token, client_id, position=1000, paused=False, title='80057281'):
        return self.call('/telemetry', {'client_id': client_id, 'title_id': title, 'position_ms': position,
                                        'paused': paused, 'ready_state': 4, 'app': 'netflix'}, token)

    def test_new_room_needs_no_token_and_works_browser_to_browser(self):
        token = self.new_room()
        self.assertGreaterEqual(len(token), 32)
        self.assertNotEqual(token, relay.TOKEN)
        status, room, _ = self.call('/sync', token=token)
        self.assertEqual(status, 200)
        self.assertEqual(room['sync_mode'], 'peer')
        self.assertEqual(room['room'], 'browser')
        status, clock, _ = self.call('/clock', token=token)
        self.assertEqual(status, 200)
        self.assertIn('server_ms', clock)

    def test_unknown_tokens_are_rejected(self):
        self.new_room()
        status, _, _ = self.call('/sync', token='made-up-token')
        self.assertEqual(status, 401)

    def test_rooms_do_not_see_each_other_or_the_roku_room(self):
        first, second = self.new_room(), self.new_room()
        self.telemetry(first, 'alice', position=5000)
        _, other, _ = self.call('/sync', token=second)
        self.assertEqual(other['clients'], {})
        _, roku_room, _ = self.call('/sync', token='operator-token')
        self.assertNotIn('alice', roku_room['clients'])
        self.assertEqual(roku_room['room'], 'roku')

    def test_first_person_in_is_master_and_others_follow(self):
        token = self.new_room()
        self.telemetry(token, 'creator')
        self.telemetry(token, 'gf')
        self.telemetry(token, 'friend')
        _, room, _ = self.call('/sync', token=token)
        self.assertEqual(room['master_client_id'], 'creator')
        status, data, _ = self.call('/event', {'action': 'pause', 'position': 2000, 'client_id': 'gf'}, token)
        self.assertEqual(status, 409, 'a follower cannot drive playback without the baton')
        status, data, _ = self.call('/event', {'action': 'pause', 'position': 2000, 'client_id': 'creator'}, token)
        self.assertEqual(status, 200, data)
        _, room, _ = self.call('/sync', token=token)
        self.assertTrue(room['master_state']['paused'])
        self.assertEqual(room['event']['action'], 'pause')

    def test_anyone_can_take_the_baton_and_the_master_can_hand_it_over(self):
        token = self.new_room()
        for client in ('creator', 'gf', 'friend'):
            self.telemetry(token, client)
        _, data, _ = self.call('/baton', {'action': 'claim', 'client_id': 'friend'}, token)
        self.assertEqual(data['master_client_id'], 'friend')
        _, data, _ = self.call('/baton', {'action': 'pass', 'client_id': 'friend', 'target_client_id': 'gf'}, token)
        self.assertEqual(data['master_client_id'], 'gf')

    def test_browser_rooms_stay_browser_to_browser(self):
        token = self.new_room()
        _, data, _ = self.call('/baton', {'action': 'mode', 'client_id': 'a', 'sync_mode': 'roku'}, token)
        self.assertEqual(data['sync_mode'], 'peer')
        for path in ('/sample', '/schedule-start', '/roku-bridge/state'):
            status, _, _ = self.call(path, {'x': 1}, token)
            self.assertEqual(status, 409, path)
        status, _, _ = self.call('/event', {'action': 'key', 'key': 'Play', 'client_id': 'a'}, token)
        self.assertEqual(status, 409)

    def test_creation_is_rate_limited_per_address(self):
        for _ in range(relay.ROOMS_PER_IP_PER_HOUR):
            self.new_room(ip='198.51.100.7')
        status, data, _ = self.call('/rooms', method='POST', headers={'CF-Connecting-IP': '198.51.100.7'})
        self.assertEqual(status, 429, data)
        self.new_room(ip='198.51.100.8')

    def test_relay_refuses_new_rooms_when_full(self):
        saved = relay.MAX_ROOMS
        relay.MAX_ROOMS = 1
        self.addCleanup(setattr, relay, 'MAX_ROOMS', saved)
        self.new_room()
        status, _, _ = self.call('/rooms', method='POST', headers={'CF-Connecting-IP': '192.0.2.9'})
        self.assertEqual(status, 503)

    def test_idle_rooms_expire(self):
        token = self.new_room()
        with relay.rooms_lock:
            for room in relay.rooms.values():
                room.last_seen = time.monotonic() - relay.ROOM_IDLE_S - 1
        status, _, _ = self.call('/sync', token=token)
        self.assertEqual(status, 401)

    def test_operator_can_turn_room_creation_off(self):
        saved = relay.ROOM_CREATION
        relay.ROOM_CREATION = False
        self.addCleanup(setattr, relay, 'ROOM_CREATION', saved)
        status, _, _ = self.call('/rooms', method='POST')
        self.assertEqual(status, 403)

    def test_invite_links_open_a_help_page_without_the_token(self):
        with urllib.request.urlopen(self.url + '/', timeout=2) as response:
            body = response.read().decode()
            self.assertEqual(response.status, 200)
            self.assertIn('text/html', response.headers['Content-Type'])
        self.assertIn('Got an invite?', body)

    def test_preflight_allows_extension_pages(self):
        status, _, headers = self.call('/rooms', method='OPTIONS')
        self.assertEqual(status, 204)
        self.assertEqual(headers.get('Access-Control-Allow-Methods'), 'POST')


if __name__ == '__main__':
    unittest.main()
