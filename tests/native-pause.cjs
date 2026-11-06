const assert=require('assert'),harness=require('./native-harness.cjs');const h=harness();
setImmediate(()=>{h.messages.length=0;h.video.paused=false;h.video.pause();
  const pauses=h.messages.filter(m=>m.action==='pause');assert.equal(pauses.length,1);assert.equal(pauses[0].position,21000);
  assert(!h.messages.some(m=>m.type==='sample'));console.log('Native pause sends one relay event without a sampling loop');
});
