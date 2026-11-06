const fs=require('fs'),vm=require('vm'),assert=require('assert');
let callbacks={},timers=[],posts=[],seq=0;
const video={paused:false,currentTime:8,addEventListener:(n,f)=>callbacks[n]=f,removeEventListener:n=>delete callbacks[n],pause(){this.paused=true;callbacks.pause({type:'pause'})}};
const badge={style:{},textContent:''};
const context={document:{createElement:tag=>tag==='button'?{style:{},addEventListener(){}}:badge,documentElement:{appendChild(){}},querySelector:()=>video},chrome:{runtime:{sendMessage(m,cb){if(m.type==='event'){posts.push(m);cb({data:{ok:true}})}else cb({data:{seq,roku:seq?'pause':'play',last_update:Date.now()/1000,event:seq?{source:'roku',action:'pause'}:null}})}}},location:{pathname:'/browse'},performance:{now:()=>10000},setTimeout:f=>timers.push(f),Date,Promise,console};
vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),context);
setImmediate(()=>{context.location.pathname='/watch/123';seq=1;timers.shift()();setImmediate(()=>{assert(video.paused,'Roku pause pauses Chrome');assert(!posts.some(p=>p.action==='pause'),'remote pause must not echo back');console.log('Roku pause reflected without feedback loop')})});
