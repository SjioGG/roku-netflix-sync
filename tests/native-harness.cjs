const fs=require('fs'),vm=require('vm');
module.exports=function(options={}) {
  const handlers={},timers=[],messages=[],elements=[];
  const video={paused:true,currentTime:21,readyState:2,addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n],async play(){this.paused=false;handlers.play?.({type:'play'})},pause(){this.paused=true;handlers.pause?.({type:'pause'})}};
  const ctx={document:{createElement:t=>{const node={tag:t,style:{},textContent:'',setAttribute(){}};elements.push(node);return node},documentElement:{appendChild(){}},querySelector:()=>video},chrome:{runtime:{sendMessage(m,cb){messages.push(m);if(options.handle?.(m,cb))return;if(m.type==='sample')cb({data:{sample_id:'fixture',after:'21000 ms'}});else if(m.type==='clock')cb({data:{server_ms:Date.now(),received_ms:Date.now()}});else if(m.type==='schedule')cb({data:{id:'fixture-start',start_ms:Date.now()+4000}});else if(m.type==='read')cb({data:{seq:0,roku:'pause',last_update:Date.now()/1000,launch_status:'sent',title_id:'123'}});else cb({data:{ok:true}})}}},location:{pathname:'/watch/123'},performance:{now:()=>10000},setTimeout:(f,delay)=>timers.push({f,delay}),Date,Promise,console};
  ctx.chrome.storage=options.storage || require('./consented-storage.cjs')();
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  return {video,handlers,timers,messages,elements,ctx};
};
