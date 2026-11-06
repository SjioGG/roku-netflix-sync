const assert=require('assert'),harness=require('./native-harness.cjs');let reply;
const h=harness({handle(m,cb){if(m.type==='schedule'){reply=cb;return true}}});
setImmediate(async()=>{await h.video.play();await new Promise(setImmediate);assert(reply);
  await h.video.play();reply({data:{id:'fixture-start',start_ms:Date.now()+4000}});await new Promise(setImmediate);
  assert(h.messages.some(m=>m.type==='cancel' && m.id==='fixture-start'));
  assert(h.messages.some(m=>m.action==='play'));assert(!h.video.paused);
  console.log('Native play override cancels an accepted racing start');
});
