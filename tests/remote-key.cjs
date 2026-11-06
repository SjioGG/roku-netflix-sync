const fs=require('fs'),vm=require('vm'),assert=require('assert');
let listener,request;
const context={chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{local:{get:async()=>({server:'http://127.0.0.1:8766',token:'fixture'})}}},URL,AbortSignal,performance,fetch:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({ok:true})}}};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),context);
new Promise(resolve=>listener({type:'event',action:'key',key:'Fwd'},{tab:{},url:'https://www.netflix.com/watch/123'},resolve)).then(result=>{
  assert.equal(result.data.ok,true);assert.equal(JSON.parse(request.options.body).key,'Fwd');assert.equal(JSON.parse(request.options.body).action,'key');
  console.log('TV remote key reaches relay request');
});
