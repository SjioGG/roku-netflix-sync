const assert=require('assert'),harness=require('./native-harness.cjs');
const h=harness();
setImmediate(()=>{assert.equal(h.video.paused,true);assert.equal(h.elements.length,1);assert.equal(h.elements[0].tag,'div');assert(h.messages.some(m=>m.action==='title'));console.log('Title launch leaves playback alone and creates only status');});
