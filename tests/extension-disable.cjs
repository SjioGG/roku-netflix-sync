const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-227: disabling sync must leave Netflix's native controls completely untouched,
// and re-enabling must reconnect poll/telemetry without a page reload.
const listeners={},timers=[],messages=[];
const video={paused:true,currentTime:21,readyState:2,ended:false,
  addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
  async play(){this.paused=false;listeners.play?.({type:'play'})},
  pause(){this.paused=true;listeners.pause?.({type:'pause'})}};
const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener:(n,f)=>{if(n==='click')badge.click=f;}};
let onStorageChanged=null;
const ctx={
  document:{
    createElement:tag=>tag==='div'?badge:{style:{},setAttribute(){},addEventListener(){}},
    documentElement:{appendChild(){}},
    querySelector:()=>video,
    querySelectorAll:()=>[]
  },
  chrome:{
    storage:{
      local:{get:(keys,cb)=>{if(cb)cb({enabled:true});return Promise.resolve({enabled:true})}},
      onChanged:{addListener:f=>{onStorageChanged=f}}
    },
    runtime:{sendMessage(m,cb){
      messages.push(m);
      if(m.type==='read')cb({data:{seq:0,roku:'pause',last_update:Date.now()/1000,launch_status:'sent',title_id:'123'}});
      else if(m.type==='sample')cb({data:{sample_id:'fixture',after:'21000 ms'}});
      else if(m.type==='clock')cb({data:{server_ms:Date.now(),received_ms:Date.now()}});
      else if(m.type==='schedule')cb({data:{id:'fixture-start',start_ms:Date.now()+4000}});
      else cb({data:{ok:true}});
    }}
  },
  location:{pathname:'/watch/123'},
  performance:{now:()=>10000},
  setTimeout:(f,delay)=>{timers.push({f,delay});return timers.length},
  Date,Promise,console
};
vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
const drain=async()=>{for(let i=0;i<5;i++){await new Promise(setImmediate);timers.splice(0).forEach(t=>t.f());await new Promise(setImmediate);}};

(async()=>{
  await drain();
  assert(onStorageChanged,'content script listens for the enable toggle');
  assert(badge.style.display!=='none','badge starts visible while sync is enabled');
  assert(messages.some(m=>m.type==='read'),'polling works while enabled');

  // Disable through the popup's storage change.
  messages.length=0;
  onStorageChanged({enabled:{newValue:false}},'local');
  await new Promise(setImmediate);
  assert.equal(badge.style.display,'none','badge hides when sync is disabled');
  messages.length=0;
  video.currentTime=30;video.paused=false;listeners.play?.({type:'play'});
  video.currentTime=45;listeners.pause?.({type:'pause'});
  listeners.seeked?.({type:'seeked'});
  await drain();
  assert.equal(messages.length,0,'disabled sync must not send play/pause/seek events: '+JSON.stringify(messages));
  assert.equal(video.currentTime,45,'disabled sync must not move Chrome playback');

  // Re-enable: polling resumes without a reload.
  onStorageChanged({enabled:{newValue:true}},'local');
  await drain();
  assert.equal(badge.style.display,'','badge reappears when sync is re-enabled');
  assert(messages.some(m=>m.type==='read'),'polling resumes after re-enabling');
  assert(messages.some(m=>m.type==='telemetry' && m.data.client_id),'telemetry resumes with a client id');

  // Click-to-resync on the badge re-samples Roku and re-aligns Chrome.
  messages.length=0;
  badge.click?.();
  await drain();
  assert(messages.some(m=>m.type==='sample'),'badge click re-samples Roku');
  assert(messages.some(m=>m.type==='read') || messages.some(m=>m.type==='schedule'),'badge click re-aligns Chrome');
  console.log('Disable hides the badge and leaves native playback untouched; re-enable and click-to-resync recover');
})().catch(error=>{console.error(error);process.exit(1)});
