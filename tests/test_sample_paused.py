import io,json,threading,unittest,urllib.request,urllib.error,sys
from unittest.mock import patch
sys.path.insert(0,'.')
import roku_dashboard as dashboard

def player(state,pos):
    return ('<player state="%s"><plugin id="12"/><position>%s ms</position></player>'%(state,pos)).encode()
class SampleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=dashboard.ThreadingHTTPServer(('127.0.0.1',0),dashboard.Handler)
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url='http://127.0.0.1:%d/sample-paused'%cls.server.server_port
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close()
    def test_paused_play_paused(self):
        states=iter([player('pause',1000),player('play',1100),player('pause',1300)])
        calls=[]
        def fake(req,timeout=0):
            calls.append(req)
            return io.BytesIO(next(states) if isinstance(req,str) else b'')
        with patch.object(dashboard.urllib.request,'urlopen',side_effect=fake),patch.object(dashboard.time,'sleep'):
            handler=dashboard.Handler.__new__(dashboard.Handler);handler.headers={'Host':'127.0.0.1:8765','Content-Type':'application/json'};out=[];handler.path='/sample-paused';handler.reply=lambda code,data:out.append((code,data));handler.do_POST()
        self.assertEqual(out[0][0],200);self.assertEqual(out[0][1]['after'],'1300 ms');self.assertEqual(sum(not isinstance(x,str) for x in calls),2)
    def test_never_toggle_if_not_paused(self):
        with patch.object(dashboard.urllib.request,'urlopen',return_value=io.BytesIO(player('play',1000))) as mocked:
            handler=dashboard.Handler.__new__(dashboard.Handler);handler.headers={'Host':'127.0.0.1:8765','Content-Type':'application/json'};out=[];handler.path='/sample-paused';handler.reply=lambda code,data:out.append((code,data));handler.do_POST()
        self.assertEqual(out[0][0],409);self.assertEqual(mocked.call_count,1)
if __name__=='__main__':unittest.main()
