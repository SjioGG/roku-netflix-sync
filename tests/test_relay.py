import json
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
            relay.shared.update(title_id=None, launch_status=None, launch_started=None, roku='pause',last_update=time.time(), sample=None, scheduled=None, generation=0, sync_mode='roku', master_client_id=None, master_state=None, app_id=None, app_name=None, clients={})
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
