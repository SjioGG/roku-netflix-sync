import io
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import roku_dashboard as dashboard

REAL_URLOPEN = urllib.request.urlopen


class DashboardSecurityTest(unittest.TestCase):
    def setUp(self):
        self.server = dashboard.ThreadingHTTPServer(('127.0.0.1', 0), dashboard.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%d' % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_cross_site_simple_request_cannot_control_roku(self):
        request = urllib.request.Request(self.base + '/key/Play', data=b'{}', headers={
            'Origin': 'https://attacker.example', 'Content-Type': 'text/plain',
            'Sec-Fetch-Site': 'cross-site',
        })
        with patch.object(dashboard.urllib.request, 'urlopen') as roku:
            with self.assertRaises(urllib.error.HTTPError) as error:
                REAL_URLOPEN(request, timeout=2)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
        roku.assert_not_called()

    def test_rebinding_host_cannot_read_device_state(self):
        request = urllib.request.Request(self.base + '/state', headers={'Host': 'attacker.example'})
        with patch.object(dashboard.urllib.request, 'urlopen') as roku:
            with self.assertRaises(urllib.error.HTTPError) as error:
                REAL_URLOPEN(request, timeout=2)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
        roku.assert_not_called()

    def test_same_origin_json_controls_still_work(self):
        request = urllib.request.Request(self.base + '/key/Play', data=b'', headers={
            'Origin': self.base, 'Content-Type': 'application/json',
        })
        with patch.object(dashboard.urllib.request, 'urlopen', return_value=io.BytesIO(b'')) as roku:
            with REAL_URLOPEN(request, timeout=2) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(roku.call_count, 1)


if __name__ == '__main__':
    unittest.main()
