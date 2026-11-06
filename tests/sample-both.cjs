const assert=require('assert'),harness=require('./native-harness.cjs');
const h=harness();
setImmediate(async()=>{
  h.messages.length=0;await h.video.play();await new Promise(setImmediate);
  assert(h.messages.some(m=>m.type==='sample'));assert(h.messages.some(m=>m.type==='schedule'));
  assert(!h.messages.some(m=>m.type==='event' && ['play','pause'].includes(m.action)),'sample events must not invalidate relay sample');
  assert(h.video.paused);console.log('Native play samples both paused players without feedback');
});
