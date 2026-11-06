const assert=require('assert'),harness=require('./native-harness.cjs');
const h=harness();
setImmediate(async()=>{h.messages.length=0;await h.video.play();await new Promise(setImmediate);
  const request=h.messages.find(m=>m.type==='schedule');assert(request.lead_ms>=3000 && request.lead_ms<=15000);
  await h.timers.find(t=>t.delay>2000 && t.delay<10000).f();
  assert(!h.video.paused);assert(!h.messages.some(m=>m.type==='event' && m.action==='play'));
  console.log('Scheduled Chrome start avoids echoing a play event');
});
