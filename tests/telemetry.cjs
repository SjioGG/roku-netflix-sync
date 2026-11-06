const fs=require('fs'),vm=require('vm'),assert=require('assert'),harness=require('./native-harness.cjs');
const h=harness();let listener,request;
const ctx={chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{local:{get:async()=>({server:'http://127.0.0.1:8766',token:'fixture'})}}},URL,AbortSignal,performance,fetch:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({received_at_ms:1})}}};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),ctx);
setImmediate(async()=>{
  const m=h.messages.find(x=>x.type==='telemetry');assert(m);assert.equal(m.data.title_id,'123');assert.equal(m.data.position_ms,21000);assert.equal(m.data.paused,true);assert.equal(m.data.ready_state,2);
  await new Promise(resolve=>listener(m,{tab:{},url:'https://www.netflix.com/watch/123'},resolve));
  assert(request.url.endsWith('/telemetry'));assert.equal(JSON.parse(request.options.body).position_ms,21000);
  console.log('Passive Chrome telemetry uses its dedicated relay endpoint');
});
