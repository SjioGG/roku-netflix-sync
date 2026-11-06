const fs=require('fs'),vm=require('vm'),assert=require('assert');
function run(fail) {
  const listeners={},dom={},messages=[],timers=[];
  const emit=(table,name,event)=>[...(table[name]||[])].forEach(fn=>fn(event));
  const add=(table,name,fn)=>(table[name]??=[]).push(fn);
  const remove=(table,name,fn)=>{table[name]=(table[name]||[]).filter(f=>f!==fn)};
  const v={paused:true,currentTime:21,readyState:2,addEventListener:(n,f)=>add(listeners,n,f),removeEventListener:(n,f)=>remove(listeners,n,f),async play(){this.paused=false;emit(listeners,'play',{type:'play'})},pause(){this.paused=true;emit(listeners,'pause',{type:'pause'})}};
  const document={createElement:()=>({style:{},setAttribute(){}}),documentElement:{appendChild(){}},querySelector:()=>v,addEventListener:(n,f)=>add(dom,n,f),removeEventListener:(n,f)=>remove(dom,n,f),dispatchEvent(event){
    if(event.type==='roku-sync-seek'){
      const {id,position}=event.detail;
      emit(dom,'roku-sync-seek-result',{detail:{id,error:fail?'Bridge failed':null}});
      if(!fail){v.currentTime=position/1000;emit(listeners,'seeked',{type:'seeked'})}
    }
  }};
  class CustomEvent {constructor(type,options){this.type=type;this.detail=options.detail}}
  const ctx={document,CustomEvent,chrome:{runtime:{sendMessage(m,cb){messages.push(m);if(m.type==='read')cb({data:{seq:0,roku:'pause',last_update:Date.now()/1000,launch_status:'sent',title_id:'123'}});else if(m.type==='sample')cb({data:{sample_id:'fixture',after:'10000 ms'}});else if(m.type==='clock')cb({data:{server_ms:Date.now(),received_ms:Date.now()}});else if(m.type==='schedule')cb({data:{id:'scheduled',start_ms:Date.now()+4000}});else cb({data:{ok:true}})}}},location:{pathname:'/watch/123'},performance:{now:()=>10000},setTimeout:(f,delay)=>timers.push({f,delay}),Date,Promise,console};
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  return {v,messages,timers};
}
(async()=>{
  const good=run(false);await new Promise(setImmediate);good.messages.length=0;await good.v.play();await new Promise(setImmediate);
  assert.equal(good.v.currentTime,10);assert.equal(good.messages.find(m=>m.type==='schedule').position_ms,10000);
  assert(!good.messages.some(m=>m.action==='seek'),'internal alignment must not invalidate sample');
  const bad=run(true);await new Promise(setImmediate);bad.messages.length=0;await bad.v.play();await new Promise(setImmediate);
  assert(!bad.messages.some(m=>m.type==='schedule'));assert(bad.messages.some(m=>m.action==='play'));assert(!bad.v.paused);
  console.log('Sampled mismatch aligns Chrome before scheduling; bridge failure resumes normally');
})();
