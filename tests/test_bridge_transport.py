from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
import urllib.error
from unittest.mock import patch

import roku_client


class BridgeTransportTest(unittest.TestCase):
    def test_remote_http_and_embedded_credentials_are_rejected(self):
        for url in ['http://relay.example/state', 'https://user:synthetic-password@relay.example/state']:
            with patch.object(roku_client.urllib.request, 'urlopen') as transport:
                with self.assertRaises(ValueError) as error:
                    roku_client.http(url, token='synthetic-test-token')
            self.assertNotIn('synthetic-password', str(error.exception))
            transport.assert_not_called()

    def test_authenticated_requests_do_not_follow_redirects(self):
        reached = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/sink')
                else:
                    reached.append(self.headers.get('Authorization'))
                    self.send_response(200)
                self.end_headers()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                roku_client.http('http://127.0.0.1:%d/redirect' % server.server_port, token='synthetic-test-token')
            error.exception.close()
            self.assertEqual(reached, [], 'the token must stay at its original endpoint')
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
