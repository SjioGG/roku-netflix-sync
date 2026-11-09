const fs=require('fs'), vm=require('vm'), assert=require('assert');
let timers=[],badge={style:{},textContent:''};
const context={document:{createElement:tag=>tag==='button'?{style:{},addEventListener(){}}:badge,documentElement:{appendChild(){}},querySelector:()=>null},chrome:{runtime:{sendMessage(){throw new Error('Extension context invalidated.')}}},location:{pathname:'/watch/123'},performance:{now:()=>0},setTimeout:fn=>timers.push(fn),Date,Promise,console};
context.chrome.storage=require('./consented-storage.cjs')();
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),context);
setImmediate(()=>{assert.match(badge.textContent,/reload/i,'tell viewer to reload');assert.equal(timers.length,0,'stop polling after invalidation');console.log('Extension invalidation handled')});
