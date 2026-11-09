const fs=require('fs'),vm=require('vm'),assert=require('assert');
let callbacks={},timers=[],calls=0;
const video={currentTime:10,addEventListener:(n,cb)=>callbacks[n]=cb,removeEventListener:n=>delete callbacks[n]};
const badge={style:{},textContent:''};
const context={document:{createElement:tag=>tag==='button'?{style:{},addEventListener(){}}:badge,documentElement:{appendChild(){}},querySelector:()=>video},chrome:{runtime:{sendMessage(message,callback){calls++;if(calls>1)throw Error('Extension context invalidated.');callback({data:{roku:'pause',last_update:Date.now()/1000}})}}},location:{pathname:'/browse'},performance:{now:()=>10000},setTimeout:f=>timers.push(f),Date,Promise,console};
context.chrome.storage=require('./consented-storage.cjs')();
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),context);
setImmediate(async()=>{context.location.pathname='/watch/123';await callbacks.pause({type:'pause'});assert.match(badge.textContent,/reload/i);assert.equal(Object.keys(callbacks).length,0,'remove stale video listeners after context invalidation');console.log('Invalidated video listeners detached')});
