"""Discovery regressions with simulated transports, never the real LAN."""
import time
import unittest
from unittest.mock import patch, MagicMock
import roku_client as client


class DiscoveryRegressions(unittest.TestCase):
    def test_slow_device_info_and_active_app_do_not_hide_a_roku(self):
        def transport(url, **kwargs):
            time.sleep(0.45)
            if url.endswith('/device-info'):
                return b'<device-info><friendly-device-name>Test TV</friendly-device-name></device-info>'
            return b'<active-app><app id="12">Netflix</app></active-app>'

        with patch.dict(client.os.environ, {'ROKU_URL': 'http://192.168.1.20:8060'}), \
                patch.object(client, 'http', side_effect=transport):
            result = client.discover_roku_devices(timeout=0.5, include_arp=False, include_ssdp=False)
        self.assertEqual(len(result['devices']), 1, 'a reachable TV disappeared while active-app was loading')
        self.assertEqual(result['devices'][0]['active_app'], 'Netflix')

    def test_lan_requests_bypass_corporate_proxy(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'fixture'
        with patch.object(client.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = response
            with patch.object(client.urllib.request, 'urlopen', side_effect=AssertionError('global proxy transport used')):
                self.assertEqual(client.http('http://192.168.1.20:8060/query/device-info'), b'fixture')
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(h, client.urllib.request.ProxyHandler) and h.proxies == {} for h in handlers))

    def test_local_network_permission_denial_is_reported(self):
        denied = client.urllib.error.URLError(OSError(65, 'No route to host'))
        with patch.dict(client.os.environ, {'ROKU_URL': 'http://192.168.1.99:8060'}), \
                patch.object(client, 'http', side_effect=denied):
            result = client.discover_roku_devices(timeout=0.3, include_arp=False, include_ssdp=False)
        self.assertEqual(result['devices'], [])
        self.assertTrue(result.get('local_network_blocked'),
                        'macOS EHOSTUNREACH local-network denial must be surfaced to the UI')

    def test_ordinary_refused_or_timeout_probes_do_not_report_local_network_blocked(self):
        refused = client.urllib.error.URLError(ConnectionRefusedError(61, 'Connection refused'))
        with patch.dict(client.os.environ, {'ROKU_URL': 'http://192.168.1.99:8060'}), \
                patch.object(client, 'http', side_effect=refused):
            result = client.discover_roku_devices(timeout=0.3, include_arp=False, include_ssdp=False)
        self.assertEqual(result['devices'], [])
        self.assertFalse(result.get('local_network_blocked'))

    def test_arp_uses_numeric_flag_to_avoid_reverse_dns_stalls(self):
        calls = []

        def fake_runner(cmd, **kwargs):
            calls.append(cmd)
            res = MagicMock()
            res.stdout = '? (192.168.1.42) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n'
            return res

        found = client.arp_candidates(runner=fake_runner)
        self.assertEqual(found, ['http://192.168.1.42'])
        self.assertEqual(calls, [['arp', '-an']])

    def test_requests_set_explicit_user_agent_for_cloudflare_relays(self):
        captured = []
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{}'

        def fake_open(req, timeout=5):
            captured.append(req.get_header('User-agent'))
            return response

        opener = MagicMock()
        opener.open.side_effect = fake_open
        with patch.object(client.urllib.request, 'build_opener', return_value=opener):
            client.http('https://relay.example.test/clock', token='room-token')
        self.assertEqual(len(captured), 1)
        self.assertTrue(captured[0] and captured[0].startswith('RokuSync/'), captured[0])

