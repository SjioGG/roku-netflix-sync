const fs=require('fs'),vm=require('vm'),assert=require('assert');
let listener,request;
const context={chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{local:{get:async()=>({server:'http://127.0.0.1:8766',token:'fixture',rokuLeadMs:125})}}},URL,AbortSignal,performance,fetch:async(url,options)=>{request=options;return {ok:true,json:async()=>({ok:true})}}};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),context);
new Promise(resolve=>listener({type:'schedule',sample_id:'sample',position_ms:1000,lead_ms:5000},{tab:{},url:'https://www.netflix.com/watch/123'},resolve)).then(()=>{
  const body=JSON.parse(request.body);assert.equal(body.lead_ms,5000);assert.equal(body.roku_lead_ms,125);
  console.log('Scheduled start sends adaptive lead and saved calibration');
});
