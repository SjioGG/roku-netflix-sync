const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-230: a play pressed while Roku is still loading waits up to 60s for the
// player instead of failing after the regular 10s alignment timeout.
function run(){
  let now=Date.now();
  const listeners={},timers=[],messages=[];
  const video={paused:true,currentTime:21,readyState:2,
    addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
    async play(){this.paused=false;listeners.play?.({type:'play'})},
    pause(){this.paused=true;listeners.pause?.({type:'pause'})}};
  const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener(){}};
  const relay={roku:'buffer',launch_status:'sending'};
  const ctx={
    document:{createElement:()=>badge,documentElement:{appendChild(){}},querySelector:()=>video,querySelectorAll:()=>[]},
    chrome:{runtime:{sendMessage(m,cb){
      messages.push(m);
        if(m.type==='read')cb({data:{seq:0,roku:relay.roku,last_update:now/1000,
        launch_status:relay.launch_status,launch_started:now/1000-3,title_id:'123'}});
      else if(m.type==='sample')cb({data:{sample_id:'fixture',after:'21000 ms'}});
      else if(m.type==='clock')cb({data:{server_ms:Date.now(),received_ms:Date.now()}});
      else if(m.type==='schedule')cb({data:{id:'fixture-start',start_ms:Date.now()+4000,roku_one_way_ms:20}});
      else cb({data:{ok:true}});
    }}},
    location:{hostname:'www.netflix.com',pathname:'/watch/123',search:''},
    performance:{now:()=>10000},
    setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length},
    Date:{now:()=>now},Promise,console
  };
  ctx.chrome.storage=require('./consented-storage.cjs')();
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate)};
  // Fire one round of pending timers (the 750ms readiness poll or the 10s guard).
  const tick=async()=>{timers.splice(0).forEach(t=>t.fn());await settle()};
  return {video,listeners,messages,badge,relay,settle,tick,advance:ms=>{now+=ms}};
}

(async()=>{
  // Roku buffers for a few polls, then becomes pausable.
  const h=run();
  await h.settle();
  h.messages.length=0;
  await h.video.play();
  assert(h.video.paused,'Chrome stays paused while Roku loads');
  assert.equal(h.messages.filter(m=>m.type==='sample').length,0,'no sample while Roku is still buffering');
  const seen=[];
  for(let i=0;i<3;i++){
    await h.tick();
    seen.push(h.badge.textContent);
  }
  assert(seen.some(text=>/Waiting for Roku to finish loading/.test(text)),'badge shows a loading countdown: '+JSON.stringify(seen));
  assert(seen.some(text=>/s left\)/.test(text)),'countdown shows remaining seconds: '+JSON.stringify(seen));
  assert.equal(h.messages.filter(m=>m.type==='sample').length,0,'still no sample while buffering');
  assert(!h.messages.some(m=>m.type==='event' && m.action==='play'),'loading wait does not echo a play event');
  h.relay.roku='pause';h.relay.launch_status='sent';
  await h.tick();
  assert(h.messages.some(m=>m.type==='sample'),'sampling resumes once Roku reports paused');
  for(let i=0;i<4;i++) await h.tick();
  assert(h.messages.some(m=>m.type==='schedule'),'the start is scheduled after Roku finishes loading');

  // A play that already started on Roku is paused before sampling.
  const playing=run();
  await playing.settle();
  playing.relay.roku='play';
  playing.messages.length=0;
  await playing.video.play();
  assert(playing.video.paused,'Chrome stays paused while a loading Roku plays');
  await playing.tick();
  assert(playing.messages.some(m=>m.type==='event' && m.action==='pause'),'a loading-but-playing Roku is paused first');
  assert(/Waiting for Roku to finish loading/.test(playing.badge.textContent),'badge keeps the loading countdown');
  playing.relay.roku='pause';
  await playing.tick();
  assert(playing.messages.some(m=>m.type==='sample'),'sampling still runs after the safety pause');

  const timeout=run();
  await timeout.settle();
  await timeout.video.play();
  assert(timeout.video.paused,'play waits for the loading Roku');
  timeout.advance(61000);
  await timeout.tick();
  assert.equal(timeout.video.paused,false,'failed readiness resumes native playback');
  assert(timeout.messages.some(m=>m.type==='event' && m.action==='play'),'normal playback resumes through the usual play path');

  console.log('Roku readiness waits for loading, then schedules or resumes native playback on timeout');
})().catch(error=>{console.error(error);process.exit(1)});
