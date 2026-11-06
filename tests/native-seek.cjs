const assert=require('assert'),harness=require('./native-harness.cjs');const h=harness();
setImmediate(async()=>{h.messages.length=0;h.video.currentTime=30;h.handlers.seeked({type:'seeked'});h.video.currentTime=45;h.handlers.seeked({type:'seeked'});
  const timers=h.timers.filter(t=>t.delay===300);timers.forEach(t=>t.f());await new Promise(setImmediate);
  const seeks=h.messages.filter(m=>m.action==='seek');assert.equal(seeks.length,1);assert.equal(seeks[0].position,45000);assert.equal(h.video.currentTime,45);
  console.log('Native seek sends only the final target without changing Chrome position');
});
