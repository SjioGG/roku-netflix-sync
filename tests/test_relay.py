import json
import io
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch, call
import sys
sys.path.insert(0, '.')
import sync_server as relay

# Real transport captured before any test patches ``urllib``. The bridge client
# must reach the live relay while its Roku calls are mocked.
REAL_URLOPEN = urllib.request.urlopen
PLAYER_PAUSED = b'<player state="pause"><plugin id="12" name="Netflix"/><position>42000 ms</position></player>'
PLAYER_PLAYING = b'<player state="play"><plugin id="12" name="Netflix"/><position>42200 ms</position></player>'
PLAYER_PAUSED_AFTER = b'<player state="pause"><plugin id="12" name="Netflix"/><position>43500 ms</position></player>'


def route_client_http(server_url, roku_fake):
    """Client transport that sends relay calls over real HTTP and Roku calls to a fake."""
    def client_http(url, data=None, method=None, timeout=5, token=None, content_type=None):
        if url.startswith(server_url):
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            if content_type:
                headers['Content-Type'] = content_type
            request = urllib.request.Request(url, data=data, method=method, headers=headers)
            with REAL_URLOPEN(request, timeout=timeout) as response:
                return response.read()
        return roku_fake(url, data=data, method=method, timeout=timeout)
    return client_http


def post_json(url, path, body):
    """POST over the captured real transport, unaffected by ``urlopen`` patches."""
    request = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer test-only'})
    with REAL_URLOPEN(request, timeout=2) as response:
        return json.loads(response.read() or b'{}')


class FakeRoku:
    """Minimal ECP device: state, position and a Play keypress that toggles.

    Position only advances when playback resumes and pauses again, matching the
    Roku's habit of freezing the reported position while paused.
    """
    def __init__(self, state='pause', position=42000, plugin='12'):
        self.state = state
        self.position = position
        self.plugin = plugin
        self.paths = []

    def __call__(self, url, data=None, method=None, timeout=5):
        from urllib.parse import urlsplit
        path = urlsplit(url).path
        self.paths.append((path, method or 'GET'))
        if path == '/query/media-player':
            return ('<player state="%s"><plugin id="%s" name="Netflix"/><position>%d ms</position></player>'
                    % (self.state, self.plugin, self.position)).encode()
        if path == '/keypress/Play' and (method or 'GET') == 'POST':
            if self.state == 'pause':
                self.state = 'play'
            else:
                self.state = 'pause'
                self.position += 1300
            return b''
        if path.startswith('/launch/') or path.startswith('/keypress/'):
            return b''
        raise AssertionError('unexpected Roku path ' + path)


class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        relay.TOKEN='test-only'
        cls.server=relay.ThreadingHTTPServer(('127.0.0.1',0),relay.Handler)
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url='http://127.0.0.1:%d' % cls.server.server_port
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        with relay.lock:
            relay.shared.update(title_id=None, launch_status=None, launch_started=None, roku='pause',last_update=time.time(), sample=None, scheduled=None, generation=0, sync_mode='roku', master_client_id=None, master_state=None, app_id=None, app_name=None, clients={}, bridge_active=False, bridge_only=False)
        relay.reset_bridge()
        relay.suppress_until = 0
    def request(self,path,body=None,auth=True):
        data=None if body is None else json.dumps(body).encode()
        req=urllib.request.Request(self.url+path,data=data,headers={'Authorization':'Bearer test-only'} if auth else {})
        return urllib.request.urlopen(req,timeout=2)
    def test_rejects_unauthorized(self):
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/sync',auth=False)
        self.assertEqual(e.exception.code,401); e.exception.close()
    def test_title_input_when_netflix_is_active(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'<active-app><app id="12"/></active-app>' if not post else b''
        with patch.object(relay,'roku',side_effect=fake):
            self.assertEqual(self.request('/event',{'action':'title','title_id':'12345'}).status,202)
            for _ in range(100):
                if any(post for _,post in calls):break
                time.sleep(.01)
            self.assertTrue(any(p.startswith('/input?') and 'contentID=12345' in p for p,post in calls if post),calls)
    def test_pause_cancels_pending_start_and_sample(self):
        with relay.lock:
            relay.shared['sample']={'id':'old','position_ms':10000,'at_ms':round(time.time()*1000)}
            relay.shared['scheduled']={'id':'start','state':'pending'}
        with self.request('/event',{'action':'pause','position':10000}) as response:self.assertEqual(response.status,200)
        with relay.lock:
            self.assertIsNone(relay.shared['sample'])
            self.assertEqual(relay.shared['scheduled']['state'],'cancelled')
    def test_scheduled_worker_sends_one_play_at_deadline(self):
        pending={'state':'pending','generation':relay.shared['generation']}
        with patch.object(relay,'roku',return_value=b'') as mocked:
            relay.perform_scheduled_start(pending,time.monotonic())
        mocked.assert_called_once_with('/keypress/Play',post=True)
        self.assertEqual(pending['state'],'sent')
        self.assertGreaterEqual(pending['ack_at_ms'],pending['sent_at_ms'])
    def test_scheduled_worker_never_plays_after_cancel(self):
        pending={'state':'cancelled','generation':relay.shared['generation']}
        with patch.object(relay,'roku',return_value=b'') as mocked:
            relay.perform_scheduled_start(pending,time.monotonic())
        mocked.assert_not_called()
    def test_remote_seek_keys_reach_roku(self):
        with patch.object(relay,'roku',return_value=b'') as mocked:
            with self.request('/event',{'action':'key','key':'Fwd'}) as response:self.assertEqual(response.status,200)
        mocked.assert_called_once_with('/keypress/Fwd',post=True)
    def test_unknown_remote_key_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/event',{'action':'key','key':'Home'})
        self.assertEqual(e.exception.code,400);e.exception.close()
    def test_seek_steps_roku_thumbnail_scrubber(self):
        calls=[]
        states=iter([
            b'<player state="pause"><plugin id="12"/><position>10000 ms</position></player>',
            b'<player state="play"><plugin id="12"/><position>10200 ms</position></player>',
            b'<player state="pause"><plugin id="12"/><position>10300 ms</position></player>',
            b'<player state="stop"><plugin id="12"/><position>10300 ms</position></player>',
            b'<player state="play"><plugin id="12"/><position>30100 ms</position></player>',
            b'<player state="pause"><plugin id="12"/><position>30100 ms</position></player>',
        ])
        def fake(path,post=False):
            calls.append((path,post))
            return next(states) if not post else b''
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            with self.request('/event',{'action':'seek','position':30000}) as response:
                data=json.load(response)
        self.assertEqual(data['steps'],2)
        self.assertEqual(data['after_ms'],30100)
        self.assertEqual([p for p,post in calls if post],['/keypress/Play','/keypress/Play','/keypress/Right','/keypress/Right','/keypress/Right','/keypress/Play','/keypress/Play'])
    def test_browser_telemetry_does_not_change_playback_intent(self):
        with relay.lock: old_generation=relay.shared['generation']
        with patch.object(relay,'roku') as mocked:
            with self.request('/telemetry',{'title_id':'123','position_ms':819234,'paused':True,'ready_state':4,'client_ms':123}) as response:self.assertEqual(response.status,200)
        mocked.assert_not_called()
        with relay.lock:
            self.assertEqual(relay.shared['chrome']['position_ms'],819234)
            self.assertEqual(relay.shared['generation'],old_generation)
    def test_clock_returns_server_time(self):
        with self.request('/clock') as response: data=json.load(response)
        self.assertLess(abs(data['server_ms']-time.time()*1000),2000)
    def test_start_rejects_large_position_difference(self):
        with relay.lock: relay.shared['sample']={'id':'sample','position_ms':10000,'at_ms':round(time.time()*1000)}
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/schedule-start',{'sample_id':'sample','position_ms':11000})
        self.assertEqual(e.exception.code,409); e.exception.close()
    def test_scheduled_start_can_be_cancelled(self):
        with relay.lock:
            relay.shared['sample']={'id':'sample','position_ms':10000,'at_ms':round(time.time()*1000)}
            relay.shared['scheduled']=None
        with self.request('/schedule-start',{'sample_id':'sample','position_ms':10100,'roku_lead_ms':-300}) as response: data=json.load(response)
        self.assertGreater(data['start_ms'],time.time()*1000+2000)
        with self.request('/cancel-start',{'id':data['id']}) as response: self.assertEqual(response.status,200)
        with relay.lock: self.assertEqual(relay.shared['scheduled']['state'],'cancelled')
    def test_seek_fails_when_player_unavailable(self):
        with relay.lock: relay.shared.update(roku='close', last_update=time.time())
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/event',{'action':'seek','position':10000})
        self.assertEqual(e.exception.code,409); e.exception.close()
    def test_auto_select_advances_episode_menu(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'<player state="close"></player>' if not post else b''
        with relay.lock: relay.shared['title_id']='777'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertTrue(relay.auto_select_after_launch('777'))
        self.assertEqual([p for p,post in calls if post],['/keypress/Select'])
    def test_auto_select_skips_stalled_zero_position_and_normal_playback(self):
        for state,position,expected in (('play',500,['/keypress/Select']),('play',90000,[]),('pause',90000,[])):
            calls=[]
            body=('<player state="%s"><plugin id="12"/><position>%d ms</position></player>' % (state,position)).encode()
            def fake(path,post=False,body=body):
                calls.append((path,post))
                return body if not post else b''
            with relay.lock: relay.shared['title_id']='777'
            with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
                relay.auto_select_after_launch('777')
            self.assertEqual([p for p,post in calls if post],expected,(state,position))
    def test_auto_select_ignores_a_superseded_title(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'<player state="close"></player>' if not post else b''
        with relay.lock: relay.shared['title_id']='888'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertFalse(relay.auto_select_after_launch('777'))
        self.assertEqual([p for p,post in calls if post],[])
    def test_telemetry_tracks_multiple_clients(self):
        with relay.lock: relay.shared['clients']={}
        for client_id,position in (('japan',100000),('local',105000)):
            with self.request('/telemetry',{'title_id':'123','position_ms':position,'paused':False,'ready_state':4,'client_ms':1,'client_id':client_id}) as response:
                self.assertEqual(response.status,200)
        with relay.lock:
            self.assertEqual(set(relay.shared['clients']),{'japan','local'})
            self.assertEqual(relay.shared['chrome']['position_ms'],105000)
            self.assertEqual(relay.shared['drift_ms'],5000)
    def test_telemetry_prunes_stale_clients_and_defaults_client_id(self):
        with relay.lock:
            relay.shared['clients']={'gone':{'title_id':'123','position_ms':1,'received_at_ms':1}}
        with self.request('/telemetry',{'title_id':'123','position_ms':2000,'paused':True,'ready_state':4}) as response:
            self.assertEqual(response.status,200)
        with relay.lock:
            self.assertEqual(set(relay.shared['clients']),{'default'})
            self.assertIsNone(relay.shared['drift_ms'])
    def test_telemetry_rejects_oversized_client_id(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request('/telemetry',{'title_id':'123','position_ms':10,'paused':True,'ready_state':4,'client_id':'x'*65})
        self.assertEqual(e.exception.code,400); e.exception.close()
    # --- BEE-228: browser-to-browser master/slave baton ----------------------
    def test_baton_claim_and_mode_switch(self):
        with self.request('/baton',{'action':'claim','client_id':'alice','sync_mode':'peer'}) as response:
            data=json.load(response)
        self.assertEqual(data['sync_mode'],'peer'); self.assertEqual(data['master_client_id'],'alice')
        with relay.lock:
            self.assertEqual(relay.shared['sync_mode'],'peer')
            self.assertEqual(relay.shared['master_client_id'],'alice')
    def test_baton_mode_action_keeps_current_master(self):
        with self.request('/baton',{'action':'claim','client_id':'alice'}) as response: json.load(response)
        with self.request('/baton',{'action':'mode','client_id':'alice','sync_mode':'peer'}) as response:
            data=json.load(response)
        self.assertEqual(data['sync_mode'],'peer'); self.assertEqual(data['master_client_id'],'alice')
        with self.request('/baton',{'action':'mode','client_id':'alice','sync_mode':'roku'}) as response:
            data=json.load(response)
        self.assertEqual(data['sync_mode'],'roku')
    def test_baton_pass_to_freshest_peer(self):
        with relay.lock:
            relay.shared['clients']={'alice':{'received_at_ms':1000},'bob':{'received_at_ms':5000}}
            relay.shared['master_client_id']='alice'
        with self.request('/baton',{'action':'pass','client_id':'alice'}) as response:
            data=json.load(response)
        self.assertEqual(data['master_client_id'],'bob')
    def test_baton_pass_to_explicit_target(self):
        with relay.lock:
            relay.shared['clients']={'alice':{'received_at_ms':1000},'bob':{'received_at_ms':5000}}
            relay.shared['master_client_id']='alice'
        with self.request('/baton',{'action':'pass','client_id':'alice','target_client_id':'carol'}) as response:
            data=json.load(response)
        self.assertEqual(data['master_client_id'],'carol')
    def test_baton_pass_alone_clears_master(self):
        with relay.lock:
            relay.shared['clients']={'alice':{'received_at_ms':1000}}
            relay.shared['master_client_id']='alice'
        with self.request('/baton',{'action':'pass','client_id':'alice'}) as response:
            data=json.load(response)
        self.assertIsNone(data['master_client_id'])
    def test_baton_rejects_unknown_mode_and_action(self):
        for body in ({'action':'mode','client_id':'a','sync_mode':'carrier-pigeon'},{'action':'dance','client_id':'a'}):
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/baton',body)
            self.assertEqual(e.exception.code,400); e.exception.close()
    def test_telemetry_promotes_first_client_to_master(self):
        with self.request('/telemetry',{'title_id':'123','position_ms':2000,'paused':True,'ready_state':4,'client_id':'alice','client_ms':77}) as response:
            self.assertEqual(response.status,200)
        with relay.lock:
            self.assertEqual(relay.shared['master_client_id'],'alice')
            self.assertEqual(relay.shared['master_state']['client_id'],'alice')
            self.assertEqual(relay.shared['master_state']['position_ms'],2000)
            self.assertEqual(relay.shared['master_state']['client_ms'],77)
    def test_telemetry_from_slave_does_not_overwrite_master_state(self):
        with relay.lock:
            relay.shared['master_client_id']='alice'
            relay.shared['clients']={'alice':{'title_id':'123','position_ms':1,'received_at_ms':round(time.time()*1000)}}
        with self.request('/telemetry',{'title_id':'123','position_ms':5000,'paused':False,'ready_state':4,'client_id':'bob'}) as response:
            self.assertEqual(response.status,200)
        with relay.lock:
            self.assertEqual(relay.shared['master_client_id'],'alice')
            self.assertIsNone(relay.shared['master_state'])
    def test_peer_mode_slave_event_is_rejected(self):
        with relay.lock:
            relay.shared['sync_mode']='peer'; relay.shared['master_client_id']='alice'
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request('/event',{'action':'pause','position':1000,'client_id':'bob'})
        self.assertEqual(e.exception.code,409); e.exception.close()
    def test_peer_mode_master_event_needs_no_roku(self):
        with relay.lock:
            relay.shared.update(sync_mode='peer', master_client_id='alice', roku='unavailable', last_update=0, seq=0)
        with patch.object(relay,'roku') as mocked:
            with self.request('/event',{'action':'pause','position':42000,'client_id':'alice','app':'youtube','title_id':'dQw4w9WgXcQ'}) as response:
                data=json.load(response)
        mocked.assert_not_called()
        self.assertTrue(data['peer_mode']); self.assertFalse(data['sent'])
        with relay.lock:
            state=relay.shared['master_state']
            self.assertEqual(state['client_id'],'alice')
            self.assertEqual(state['position_ms'],42000)
            self.assertTrue(state['paused'])
            self.assertEqual(state['app'],'youtube')
            self.assertEqual(relay.shared['event']['source'],'master')
    def test_peer_mode_rejects_tv_remote_keys(self):
        with relay.lock:
            relay.shared.update(sync_mode='peer', master_client_id='alice', roku='pause', last_update=time.time())
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request('/event',{'action':'key','key':'Fwd','client_id':'alice'})
        self.assertEqual(e.exception.code,409); e.exception.close()
    def test_peer_mode_slave_title_is_rejected(self):
        with relay.lock:
            relay.shared.update(sync_mode='peer', master_client_id='alice', title_id=None)
        with patch.object(relay,'roku') as mocked:
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.request('/event',{'action':'title','title_id':'123','app':'netflix','client_id':'bob'})
        self.assertEqual(e.exception.code,409); e.exception.close()
        mocked.assert_not_called()
        with relay.lock: self.assertIsNone(relay.shared['title_id'])
    def test_peer_mode_master_title_skips_roku_launch(self):
        with relay.lock:
            relay.shared.update(sync_mode='peer', master_client_id='alice', title_id=None, seq=0)
        with patch.object(relay,'roku') as mocked:
            with self.request('/event',{'action':'title','title_id':'dQw4w9WgXcQ','app':'youtube','client_id':'alice'}) as response:
                data=json.load(response)
        mocked.assert_not_called()
        self.assertTrue(data['peer_mode'])
        with relay.lock:
            self.assertEqual(relay.shared['title_id'],'dQw4w9WgXcQ')
            self.assertEqual(relay.shared['launch_status'],'peer')
            self.assertEqual(relay.shared['event']['action'],'title')

    # --- BEE-229: multi-app launch and polling -------------------------------
    def test_title_launches_youtube_with_content_id(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'' if post else b'<active-app><app id="12"/></active-app>'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay,'auto_select_after_launch'),patch.object(relay,'schedule_launch_recovery'):
            self.assertEqual(self.request('/event',{'action':'title','title_id':'dQw4w9WgXcQ','app':'youtube'}).status,202)
            for _ in range(100):
                if any(post for _,post in calls):break
                time.sleep(.01)
        launched=[p for p,post in calls if post]
        self.assertTrue(any(p.startswith('/launch/837?') and 'contentId=dQw4w9WgXcQ' in p and 'mediaType=live' in p for p in launched),calls)
        with relay.lock: self.assertEqual(relay.shared['app_name'],'YouTube')
    def test_title_launches_plex_only_when_inactive(self):
        for active,expected in (('12',1),('13535',0)):
            calls=[]
            def fake(path,post=False,active=active):
                calls.append((path,post))
                return ('<active-app><app id="%s"/></active-app>' % active).encode() if not post else b''
            with relay.lock: relay.shared.update(title_id=None, launch_status=None)
            with patch.object(relay,'roku',side_effect=fake),patch.object(relay,'auto_select_after_launch'),patch.object(relay,'schedule_launch_recovery'):
                self.assertEqual(self.request('/event',{'action':'title','title_id':'meta-77','app':'plex'}).status,202)
                for _ in range(300):
                    with relay.lock:
                        if relay.shared['launch_status'] not in (None,'sending'): break
                    time.sleep(.01)
            launched=[p for p,post in calls if post]
            self.assertEqual(len(launched),expected,(active,launched))
            if expected: self.assertEqual(launched[0],'/launch/13535')
    def test_title_accepts_youTube_ids_and_rejects_unsafe(self):
        with patch.object(relay,'roku',return_value=b'<active-app><app id="837"/></active-app>'),patch.object(relay,'auto_select_after_launch'),patch.object(relay,'schedule_launch_recovery'):
            self.assertEqual(self.request('/event',{'action':'title','title_id':'dQw4w9WgXcQ','app':'youtube'}).status,202)
            for _ in range(200):
                with relay.lock:
                    if relay.shared['launch_status'] not in (None,'sending'): break
                time.sleep(.01)
        for bad in ('a b','../etc/passwd','x'*65,''):
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/event',{'action':'title','title_id':bad})
            self.assertEqual(e.exception.code,400); e.exception.close()
    def test_query_roku_player_recognises_youtube_and_plex(self):
        for plugin_id,name in (('837','YouTube'),('13535','Plex')):
            body=('<player state="play"><plugin id="%s"/><position>12345 ms</position></player>' % plugin_id).encode()
            with patch.object(relay,'roku',return_value=body):
                state,active,position=relay.query_roku_player()
            self.assertEqual((state,active,position),('play',True,12345),plugin_id)
            with relay.lock:
                self.assertEqual(relay.shared['app_id'],plugin_id)
                self.assertEqual(relay.shared['app_name'],name)
    def test_query_roku_player_ignores_unknown_plugins(self):
        with patch.object(relay,'roku',return_value=b'<player state="play"><plugin id="999"/></player>'):
            state,active,position=relay.query_roku_player()
        self.assertFalse(active)
        with relay.lock: self.assertIsNone(relay.shared['app_name'])
    def test_telemetry_accepts_non_numeric_app_titles(self):
        with self.request('/telemetry',{'title_id':'dQw4w9WgXcQ','position_ms':1000,'paused':True,'ready_state':4,'client_id':'alice','app':'youtube'}) as response:
            self.assertEqual(response.status,200)
        with relay.lock:
            self.assertEqual(relay.shared['chrome']['app'],'youtube')
            self.assertEqual(relay.shared['master_state']['app'],'youtube')
    def test_telemetry_defaults_app_to_netflix(self):
        with self.request('/telemetry',{'title_id':'123','position_ms':1000,'paused':True,'ready_state':4}) as response:
            self.assertEqual(response.status,200)
        with relay.lock: self.assertEqual(relay.shared['chrome']['app'],'netflix')

    # --- BEE-230: hardened Roku load readiness -------------------------------
    def test_verify_scheduled_start_retries_a_missed_play(self):
        scheduled={'state':'sent','generation':relay.shared['generation']}
        body=b'<player state="pause"><plugin id="12"/><position>1000 ms</position></player>'
        with patch.object(relay,'roku',return_value=body) as mocked,patch.object(relay.time,'sleep'):
            self.assertTrue(relay.verify_scheduled_start(scheduled))
        self.assertEqual([c for c in mocked.call_args_list if c[1].get('post')],[call('/keypress/Play',post=True)])
        self.assertTrue(scheduled['retried_play'])
    def test_verify_scheduled_start_skips_when_roku_is_playing(self):
        scheduled={'state':'sent','generation':relay.shared['generation']}
        body=b'<player state="play"><plugin id="12"/><position>1000 ms</position></player>'
        with patch.object(relay,'roku',return_value=body) as mocked,patch.object(relay.time,'sleep'):
            self.assertFalse(relay.verify_scheduled_start(scheduled))
        self.assertEqual([c for c in mocked.call_args_list if c[1].get('post')],[])
        self.assertNotIn('retried_play',scheduled)
    def test_verify_scheduled_start_ignores_superseded_generation(self):
        scheduled={'state':'sent','generation':relay.shared['generation']-1}
        with patch.object(relay,'roku') as mocked,patch.object(relay.time,'sleep'):
            self.assertFalse(relay.verify_scheduled_start(scheduled))
        mocked.assert_not_called()
    def test_scheduled_worker_does_not_verify_for_direct_calls(self):
        pending={'state':'pending','generation':relay.shared['generation']}
        with patch.object(relay,'roku',return_value=b'') as mocked,patch.object(relay.threading,'Thread') as thread:
            relay.perform_scheduled_start(pending,time.monotonic())
        mocked.assert_called_once_with('/keypress/Play',post=True)
        thread.assert_not_called()
    def test_schedule_start_requests_post_start_verification(self):
        with relay.lock: relay.shared['sample']={'id':'sample','position_ms':10000,'at_ms':round(time.time()*1000)}
        with self.request('/schedule-start',{'sample_id':'sample','position_ms':10100,'roku_lead_ms':-300}) as response:
            json.load(response)
        with relay.lock:
            scheduled=relay.shared['scheduled']
            self.assertTrue(scheduled.get('verify'))
            scheduled['state']='cancelled'
    def test_recover_stalled_launch_selects_and_relaunches(self):
        calls=[]
        states=iter([b'<player state="buffer"><plugin id="12"/><position>0 ms</position></player>',
                     b'<player state="buffer"><plugin id="12"/><position>0 ms</position></player>'])
        def fake(path,post=False):
            calls.append((path,post))
            return next(states) if not post else b''
        with relay.lock: relay.shared['title_id']='dQw4w9WgXcQ'; relay.shared['app_id']='837'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertEqual(relay.recover_stalled_launch('dQw4w9WgXcQ','837'),'recovered')
        self.assertEqual([p for p,post in calls if post],['/keypress/Select','/launch/837?contentId=dQw4w9WgXcQ&mediaType=live'])
        with relay.lock: self.assertEqual(relay.shared['launch_status'],'recovered')
    def test_recover_stalled_launch_leaves_playing_roku_alone(self):
        body=b'<player state="play"><plugin id="12"/><position>90000 ms</position></player>'
        with relay.lock: relay.shared['title_id']='777'
        with patch.object(relay,'roku',return_value=body) as mocked,patch.object(relay.time,'sleep'):
            self.assertIsNone(relay.recover_stalled_launch('777'))
        self.assertEqual([c for c in mocked.call_args_list if c[1].get('post')],[])
    def test_recover_stalled_launch_ignores_a_superseded_title(self):
        with relay.lock: relay.shared['title_id']='888'
        with patch.object(relay,'roku') as mocked,patch.object(relay.time,'sleep'):
            self.assertIsNone(relay.recover_stalled_launch('777'))
        mocked.assert_not_called()
    def test_recover_stalled_launch_skips_second_launch_when_select_worked(self):
        calls=[]
        states=iter([b'<player state="buffer"><plugin id="12"/><position>0 ms</position></player>',
                     b'<player state="play"><plugin id="12"/><position>1200 ms</position></player>'])
        def fake(path,post=False):
            calls.append((path,post))
            return next(states) if not post else b''
        with relay.lock: relay.shared['title_id']='777'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertEqual(relay.recover_stalled_launch('777'),'recovered')
        self.assertEqual([p for p,post in calls if post],['/keypress/Select'])

    # --- BEE-231: remote Roku bridge and cloud deployment --------------------
    def test_bridge_state_updates_room_and_returns_queued_commands(self):
        with relay.lock:
            relay.bridge_commands.append({'id':'cmd-1','path':'/keypress/Play','post':True})
        body={'roku':'play','app_id':'837','app_name':'YouTube','position_ms':12345,'roku_poll_ms':9}
        with self.request('/roku-bridge/state',body) as response:
            data=json.load(response)
        self.assertTrue(data['ok'])
        self.assertEqual([c['id'] for c in data['commands']],['cmd-1'])
        with relay.lock:
            self.assertTrue(relay.shared['bridge_active'])
            self.assertEqual(relay.shared['roku'],'play')
            self.assertEqual(relay.shared['app_id'],'837')
            self.assertEqual(relay.shared['app_name'],'YouTube')
            self.assertEqual(relay.shared['position_ms'],12345)
            self.assertEqual(relay.shared['roku_poll_ms'],9)
            self.assertEqual(relay.bridge_commands,[])
        self.assertTrue(relay.bridge_is_live())

    def test_bridge_state_rejects_malformed_payloads(self):
        for body in ({'roku':''},{'roku':'play','position_ms':-1},{'roku':'play','app_id':'x'*33},{'nope':True}):
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/roku-bridge/state',body)
            self.assertEqual(e.exception.code,400,body); e.exception.close()

    def test_bridge_state_publishes_roku_play_pause_change(self):
        with relay.lock:
            relay.shared.update(roku='pause', last_update=time.time(), event=None, seq=0)
            relay.shared.pop('bridge_roku_last',None)
        self.request('/roku-bridge/state',{'roku':'pause','app_id':'12','position_ms':1000}).close()
        with relay.lock: relay.shared['generation']=0
        with self.request('/roku-bridge/state',{'roku':'play','app_id':'12','position_ms':2500}) as response:
            self.assertEqual(response.status,200)
        with relay.lock:
            event=relay.shared['event']
            self.assertEqual(event['source'],'roku')
            self.assertEqual(event['action'],'play')
            self.assertEqual(event['position'],2500)

    def test_bridge_requires_the_room_token(self):
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/roku-bridge/state',{'roku':'play'},auth=False)
        self.assertEqual(e.exception.code,401); e.exception.close()

    def test_bridge_result_releases_a_waiting_command(self):
        relay.shared['bridge_only']=True
        outcome={}
        def waiting():
            try: outcome['body']=relay.roku('/keypress/Play',post=True)
            except OSError as exc: outcome['error']=str(exc)
        thread=threading.Thread(target=waiting,daemon=True); thread.start()
        with relay.lock:
            for _ in range(100):
                if relay.bridge_commands: break
                relay.lock.release(); time.sleep(.01); relay.lock.acquire()
            command=relay.bridge_commands[0]
        with self.request('/roku-bridge/result',{'id':command['id'],'body':'ok'}) as response:
            self.assertEqual(response.status,200)
        thread.join(2)
        self.assertEqual(outcome,{'body':b'ok'})
        with relay.lock: self.assertEqual(relay.bridge_results,{})

    def test_bridge_roku_raises_on_client_error_and_timeout(self):
        relay.shared['bridge_only']=True
        with patch.object(relay,'BRIDGE_TIMEOUT_S',0.2):
            def answering():
                with relay.lock:
                    for _ in range(200):
                        if relay.bridge_commands: break
                        relay.lock.release(); time.sleep(.01); relay.lock.acquire()
                    command=relay.bridge_commands[0]
                self.request('/roku-bridge/result',{'id':command['id'],'error':'Roku unreachable'}).close()
            threading.Thread(target=answering,daemon=True).start()
            with self.assertRaises(OSError) as e:relay.roku('/query/media-player')
        self.assertIn('unreachable',str(e.exception))
        with patch.object(relay,'BRIDGE_TIMEOUT_S',0.2):
            with self.assertRaises(OSError) as e:relay.roku('/query/media-player')
        self.assertIn('timed out',str(e.exception))
        with relay.lock: self.assertEqual(relay.bridge_commands,[])

    def test_roku_routes_through_bridge_when_only_mode_is_on(self):
        relay.shared['bridge_only']=True
        def answering():
            with relay.lock:
                for _ in range(200):
                    if relay.bridge_commands: break
                    relay.lock.release(); time.sleep(.01); relay.lock.acquire()
                command=relay.bridge_commands[0]
            post_json(self.url,'/roku-bridge/result',{'id':command['id'],'body':'<player state="pause"/>'})
        threading.Thread(target=answering,daemon=True).start()
        with patch.object(relay.urllib.request,'urlopen') as direct:
            self.assertEqual(relay.roku('/query/media-player'),b'<player state="pause"/>')
        direct.assert_not_called()

    def test_roku_client_run_once_bridges_state(self):
        import roku_client
        calls=[]
        def roku_fake(url,data=None,method=None,timeout=5):
            calls.append((url,method or 'GET'))
            return PLAYER_PAUSED
        with patch.object(roku_client,'http',side_effect=route_client_http(self.url,roku_fake)):
            summary=roku_client.run_once(self.url,'test-only','http://192.168.1.100:8060')
        self.assertEqual(calls,[('http://192.168.1.100:8060/query/media-player','GET')])
        self.assertEqual(summary['state']['roku'],'pause')
        self.assertEqual(summary['state']['app_id'],'12')
        self.assertEqual(summary['state']['position_ms'],42000)
        self.assertEqual(summary['commands'],0)
        # The relay stored the reported state, which no browser client sent.
        with relay.lock:
            self.assertTrue(relay.shared['bridge_active'])
            self.assertEqual(relay.shared['roku'],'pause')
            self.assertEqual(relay.shared['app_id'],'12')
            self.assertEqual(relay.shared['app_name'],'Netflix')
            self.assertEqual(relay.shared['position_ms'],42000)
            self.assertIsNotNone(relay.shared['last_update'])
        self.assertTrue(relay.bridge_is_live())

    def test_roku_client_executes_a_queued_play_command_end_to_end(self):
        import roku_client
        relay.shared['bridge_only']=True
        rokus=[]
        def roku_fake(url,data=None,method=None,timeout=5):
            rokus.append((url,method or 'GET'))
            # A real Roku answers a POST keypress with an empty body.
            return b'' if method=='POST' else PLAYER_PAUSED
        outcome={}
        def waiting():
            try: outcome['body']=relay.roku('/keypress/Play',post=True)
            except OSError as exc: outcome['error']=str(exc)
        with patch.object(roku_client,'http',side_effect=route_client_http(self.url,roku_fake)):
            thread=threading.Thread(target=waiting,daemon=True); thread.start()
            with relay.lock:
                for _ in range(300):
                    if relay.bridge_commands: break
                    relay.lock.release(); time.sleep(.01); relay.lock.acquire()
            summary=roku_client.run_once(self.url,'test-only','http://192.168.1.100:8060')
            thread.join(3)
        self.assertEqual(outcome.get('error'),None,outcome)
        self.assertEqual(outcome.get('body'),b'')
        self.assertTrue(any(url.endswith('/keypress/Play') and method=='POST' for url,method in rokus),rokus)
        self.assertEqual(summary['commands'],1)
        self.assertEqual(summary['executed'][0]['path'],'/keypress/Play')
        self.assertIsNone(summary['executed'][0]['error'])
        with relay.lock: self.assertEqual(relay.bridge_commands,[])

    def test_remote_key_event_travels_through_the_bridge(self):
        import roku_client
        relay.shared['bridge_only']=True
        roku=FakeRoku(state='pause')
        with relay.lock: relay.shared.update(roku='pause',last_update=time.time())
        outcome={}
        def send_key():
            try:
                outcome['data']=post_json(self.url,'/event',{'action':'key','key':'Play'})
            except urllib.error.HTTPError as exc:
                outcome['error']=exc.read().decode(); exc.close()
        thread=threading.Thread(target=send_key,daemon=True); thread.start()
        with patch.object(roku_client,'http',side_effect=route_client_http(self.url,roku)):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline and thread.is_alive():
                if relay.bridge_commands:
                    roku_client.run_once(self.url,'test-only','http://192.168.1.100:8060')
                else:
                    time.sleep(.02)
        thread.join(10)
        self.assertNotIn('error',outcome,outcome)
        self.assertTrue(outcome['data']['sent'])
        self.assertIn(('/keypress/Play','POST'),roku.paths)
        self.assertEqual(roku.state,'play')

    def test_roku_routes_through_a_live_bridge_when_the_device_is_unreachable(self):
        # No ROKU_BRIDGE_ONLY: the relay is at home but the TV address is wrong,
        # and a bridge client is still reporting, so ECP must follow the bridge.
        with relay.lock:
            relay.shared['bridge_only']=False
            relay.bridge_last_seen=time.monotonic()
        def answering():
            with relay.lock:
                for _ in range(200):
                    if relay.bridge_commands: break
                    relay.lock.release(); time.sleep(.01); relay.lock.acquire()
                command=relay.bridge_commands[0]
            post_json(self.url,'/roku-bridge/result',{'id':command['id'],'body':'<player state="play"/>'})
        threading.Thread(target=answering,daemon=True).start()
        with patch.object(relay,'direct_roku_reachable',return_value=False),patch.object(relay.urllib.request,'urlopen') as direct:
            self.assertEqual(relay.roku('/query/media-player'),b'<player state="play"/>')
        direct.assert_not_called()

    def test_roku_stays_direct_when_the_device_answers(self):
        with relay.lock:
            relay.bridge_last_seen=time.monotonic()
        with patch.object(relay,'direct_roku_reachable',return_value=True),patch.object(relay,'bridge_roku') as bridged:
            with patch.object(relay.urllib.request,'urlopen') as direct:
                direct.return_value.__enter__.return_value.read.return_value=b'<player state="play"/>'
                self.assertEqual(relay.roku('/query/media-player'),b'<player state="play"/>')
        bridged.assert_not_called()

    def test_bridge_liveness_expires_after_ten_seconds(self):
        relay.shared['bridge_only']=True
        with relay.lock: relay.bridge_last_seen=time.monotonic()
        self.assertTrue(relay.bridge_is_live())
        self.assertFalse(relay.bridge_is_live(now=relay.bridge_last_seen+relay.BRIDGE_FRESH_S+1))

    def test_sync_reports_bridge_state(self):
        self.request('/roku-bridge/state',{'roku':'play','app_id':'12','position_ms':5000}).close()
        with self.request('/sync') as response: data=json.load(response)
        self.assertTrue(data['bridge_active'])
        self.assertEqual(data['roku'],'play')
        self.assertEqual(data['position_ms'],5000)

    def test_bridge_command_endpoint_requires_a_connected_client(self):
        relay.shared['bridge_only']=True
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request('/roku-bridge/command',{'path':'/keypress/Play','post':True})
        self.assertEqual(e.exception.code,409); e.exception.close()
        for body in ({'path':'keypress/Play'},{'path':'/'+'x'*600},{}):
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/roku-bridge/command',body)
            self.assertEqual(e.exception.code,400,body); e.exception.close()

    def test_sample_paused_direct_works_through_the_bridge_end_to_end(self):
        import roku_client
        relay.shared['bridge_only']=True
        roku=FakeRoku()
        with relay.lock: relay.shared.update(roku='pause',last_update=time.time(),sample=None)
        # The relay's sample request is served by a bridge client cycle that
        # talks to a fake Roku. No roku_dashboard.py is involved.
        outcome={}
        def relay_call():
            try:
                outcome['data']=post_json(self.url,'/sample',{})
            except urllib.error.HTTPError as exc:
                outcome['error']=exc.read().decode(); exc.close()
        thread=threading.Thread(target=relay_call,daemon=True); thread.start()
        with patch.object(roku_client,'http',side_effect=route_client_http(self.url,roku)):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline and thread.is_alive():
                if relay.bridge_commands:
                    roku_client.run_once(self.url,'test-only','http://192.168.1.100:8060')
                else:
                    time.sleep(.02)
        thread.join(10)
        self.assertNotIn('error',outcome,outcome)
        self.assertEqual(outcome['data']['after'],'43300 ms')
        self.assertTrue(outcome['data']['sample_id'])
        toggles=[p for p,m in roku.paths if p=='/keypress/Play']
        self.assertEqual(len(toggles),2)
        with relay.lock:
            self.assertEqual(relay.shared['sample']['position_ms'],43300)
            self.assertEqual(relay.shared['roku'],'pause')

    def test_sample_paused_direct_samples_through_the_bridge(self):
        relay.shared['bridge_only']=True
        states=iter([PLAYER_PAUSED,PLAYER_PLAYING,PLAYER_PAUSED_AFTER])
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            if post: return b''
            return next(states,PLAYER_PAUSED_AFTER)
        with relay.lock:
            relay.shared.update(roku='pause',last_update=time.time(),sample=None)
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            with self.request('/sample',{}) as response:
                data=json.load(response)
        self.assertEqual(data['after'],'43500 ms')
        self.assertTrue(data['sample_id'])
        self.assertEqual([p for p,post in calls if post],['/keypress/Play','/keypress/Play'])
        with relay.lock:
            self.assertEqual(relay.shared['sample']['position_ms'],43500)
            self.assertEqual(relay.shared['roku'],'pause')

    def test_sample_still_uses_the_local_dashboard_first(self):
        with relay.lock: relay.shared.update(roku='pause',last_update=time.time(),sample=None)
        dashboard={'after':'12345 ms','timings':[{'operation':'toggle','round_trip_ms':30,'received_at_ms':1000},{'operation':'toggle','round_trip_ms':40,'received_at_ms':1240}]}
        def fake(request,timeout=9):
            if not request.full_url.endswith('/sample-paused'):
                return REAL_URLOPEN(request,timeout=timeout)
            return io.BytesIO(json.dumps(dashboard).encode())
        with patch.object(relay.urllib.request,'urlopen',side_effect=fake),patch.object(relay,'sample_paused_direct') as direct:
            with self.request('/sample',{}) as response: data=json.load(response)
        direct.assert_not_called()
        self.assertEqual(data['after'],'12345 ms')
        with relay.lock:
            self.assertEqual(relay.shared['sample']['position_ms'],12345)
            self.assertEqual(relay.shared['roku_toggle_ms'],35)
            self.assertEqual(relay.shared['roku_state_transition_ms'],240)

    def test_sample_falls_back_to_direct_when_dashboard_is_absent(self):
        with relay.lock: relay.shared.update(roku='pause',last_update=time.time(),sample=None)
        direct={'before':'1 ms','after':'99999 ms','timings':[]}
        def fake(request,timeout=9):
            if not request.full_url.endswith('/sample-paused'):
                return REAL_URLOPEN(request,timeout=timeout)
            raise urllib.error.URLError('connection refused')
        with patch.object(relay.urllib.request,'urlopen',side_effect=fake),patch.object(relay,'sample_paused_direct',return_value=direct) as mocked:
            with self.request('/sample',{}) as response: data=json.load(response)
        mocked.assert_called_once_with()
        self.assertEqual(data['after'],'99999 ms')

    def test_sample_direct_reports_a_roku_that_is_not_paused(self):
        relay.shared['bridge_only']=True
        with relay.lock: relay.shared.update(roku='pause',last_update=time.time(),sample=None)
        with patch.object(relay,'roku',return_value=PLAYER_PLAYING),patch.object(relay.time,'sleep'):
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/sample',{})
        self.assertEqual(e.exception.code,409); e.exception.close()

    def test_auto_select_presses_select_for_youtube(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'<player state="close"><plugin id="837" name="YouTube"/></player>' if not post else b''
        with relay.lock: relay.shared['title_id']='dQw4w9WgXcQ'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertTrue(relay.auto_select_after_launch('dQw4w9WgXcQ','837'))
        self.assertEqual([p for p,post in calls if post],['/keypress/Select'])

    def test_auto_select_presses_select_for_youtube_stop_state(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return b'<player state="stop"><plugin id="837"/><position>0 ms</position></player>' if not post else b''
        with relay.lock: relay.shared['title_id']='dQw4w9WgXcQ'
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay.time,'sleep'):
            self.assertTrue(relay.auto_select_after_launch('dQw4w9WgXcQ','837'))
        self.assertEqual([p for p,post in calls if post],['/keypress/Select'])

    def test_launch_passes_app_id_to_auto_select(self):
        calls=[]
        def fake(path,post=False):
            calls.append((path,post))
            return (b'<player state="close"><plugin id="837" name="YouTube"/></player>' if post else b'<active-app><app id="12"/></active-app>')
        with patch.object(relay,'roku',side_effect=fake),patch.object(relay,'auto_select_after_launch') as auto,patch.object(relay,'schedule_launch_recovery'):
            self.assertEqual(self.request('/event',{'action':'title','title_id':'dQw4w9WgXcQ','app':'youtube'}).status,202)
            for _ in range(200):
                with relay.lock:
                    if relay.shared['launch_status'] not in (None,'sending'): break
                time.sleep(.01)
        self.assertEqual(auto.call_args_list,[call('dQw4w9WgXcQ','837')])

    def test_package_script_builds_expected_zip(self):
        import subprocess, zipfile
        script=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','bin','package-extension.sh')
        result=subprocess.run([script],capture_output=True,text=True,timeout=120)
        self.assertEqual(result.returncode,0,result.stderr)
        archive=os.path.join(os.path.dirname(script),'..','dist','roku-netflix-sync-extension.zip')
        self.assertTrue(os.path.isfile(archive))
        with zipfile.ZipFile(archive) as bundle:
            names=bundle.namelist()
        for expected in ('manifest.json','background.js','content.js','player-bridge.js','popup.html','popup.js'):
            self.assertIn(expected,names)
        with open(os.path.join(os.path.dirname(script),'..','extension','manifest.json')) as handle:
            self.assertEqual(json.load(handle)['manifest_version'],3)

if __name__=='__main__': unittest.main()
