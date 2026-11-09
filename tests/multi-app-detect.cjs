const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-229: YouTube and Plex pages are detected, and alignment seeks the plain
// HTML5 <video> element directly instead of using Netflix's seek bridge.
function run({hostname,pathname,search='',hash='',currentTime=21}){
  const listeners={},timers=[],messages=[];
  let relayTitle=null;
  const video={paused:true,currentTime,readyState:2,
    addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
    async play(){this.paused=false;listeners.play?.({type:'play'})},
    pause(){this.paused=true;listeners.pause?.({type:'pause'})}};
  const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener(){}};
  const document={
    createElement:()=>badge,documentElement:{appendChild(){}},
    querySelector:()=>video,querySelectorAll:()=>[],
    addEventListener(){throw Error('Netflix seek bridge must not be used off Netflix')},
    dispatchEvent(){throw Error('Netflix seek bridge must not be used off Netflix')}
  };
  const ctx={
    document,
    chrome:{
      storage:{local:{get:(keys,cb)=>{const value={enabled:true,syncMode:'roku',server:'http://127.0.0.1:8766',privacyConsent:{version:1,server:'http://127.0.0.1:8766'}};if(cb)cb(value);return Promise.resolve(value)}}},
      runtime:{sendMessage(m,cb){
        messages.push(m);
        if(m.type==='event' && m.action==='title')relayTitle=m.title_id;
        if(m.type==='read')cb({data:{seq:0,roku:'pause',last_update:Date.now()/1000,launch_status:'sent',title_id:relayTitle}});
        else if(m.type==='sample')cb({data:{sample_id:'fixture',after:'10000 ms'}});
        else if(m.type==='clock')cb({data:{server_ms:Date.now(),received_ms:Date.now()}});
        else if(m.type==='schedule')cb({data:{id:'fixture-start',start_ms:Date.now()+4000,roku_one_way_ms:20}});
        else cb({data:{ok:true}});
      }}
    },
    location:{hostname,pathname,search,hash},
    performance:{now:()=>10000},
    setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length},
    Date,Promise,console
  };
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  const drain=async()=>{for(let i=0;i<4;i++){await new Promise(setImmediate);timers.splice(0).forEach(t=>t.fn());await new Promise(setImmediate);}};
  return {video,listeners,messages,badge,drain};
}

(async()=>{
  // YouTube watch page: telemetry and title launch carry the video ID and app.
  const youtube=run({hostname:'www.youtube.com',pathname:'/watch',search:'?v=dQw4w9WgXcQ'});
  await youtube.drain();
  const telemetry=youtube.messages.find(m=>m.type==='telemetry');
  assert(telemetry,'YouTube sends telemetry');
  assert.equal(telemetry.data.app,'youtube');
  assert.equal(telemetry.data.title_id,'dQw4w9WgXcQ');
  const title=youtube.messages.find(m=>m.type==='event' && m.action==='title');
  assert(title,'YouTube launches its title on the Roku');
  assert.equal(title.title_id,'dQw4w9WgXcQ');
  assert.equal(title.app,'youtube');
  assert.equal(title.client_id,telemetry.data.client_id,'events carry the client id');

  // Alignment on YouTube seeks the HTML5 element, never the Netflix bridge.
  youtube.messages.length=0;
  youtube.video.currentTime=21;
  await youtube.video.play();
  await youtube.drain();
  assert.equal(youtube.video.currentTime,10,'YouTube seeks its own <video> to the sampled position');
  const scheduled=youtube.messages.find(m=>m.type==='schedule');
  assert(scheduled,'YouTube still schedules a latency-compensated start');
  assert.equal(scheduled.position_ms,10000);
  assert(!youtube.messages.some(m=>m.type==='event' && m.action==='seek'),'internal alignment must not invalidate the sample');

  // Plex: hash-based sessions resolve to a stable slug, and the app is 'plex'.
  const plex=run({hostname:'app.plex.tv',pathname:'/desktop',search:'#!/server/localhost/details?key=%2Flibrary%2Fmetadata%2F42',hash:'#!/server/localhost/details?key=%2Flibrary%2Fmetadata%2F42'});
  await plex.drain();
  const plexTelemetry=plex.messages.find(m=>m.type==='telemetry');
  assert(plexTelemetry,'Plex sends telemetry');
  assert.equal(plexTelemetry.data.app,'plex');
  assert.match(plexTelemetry.data.title_id,/^[A-Za-z0-9_-]{1,64}$/,'Plex title id is a relay-safe slug');
  plex.messages.length=0;
  plex.video.currentTime=21;
  await plex.video.play();
  await plex.drain();
  assert.equal(plex.video.currentTime,10,'Plex seeks its own <video> to the sampled position');
  assert(plex.messages.some(m=>m.type==='schedule'),'Plex schedules a latency-compensated start');

  // YouTube shorts resolve to their own ID.
  const shorts=run({hostname:'youtube.com',pathname:'/shorts/abc123XYZ_',search:''});
  await shorts.drain();
  assert.equal(shorts.messages.find(m=>m.type==='telemetry').data.title_id,'abc123XYZ_','YouTube Shorts IDs are detected');

  // Non-media pages stay silent.
  const browse=run({hostname:'www.youtube.com',pathname:'/feed/subscriptions',search:''});
  await browse.drain();
  assert(!browse.messages.some(m=>m.type==='event' && m.action==='title'),'non-media pages do not launch anything');
  assert(!browse.messages.some(m=>m.type==='telemetry'),'non-media pages send no telemetry');
  assert.match(browse.badge.textContent,/Roku sync/,'badge still reports Roku status');

  console.log('YouTube and Plex detection launches the right app and seeks HTML5 directly');
})().catch(error=>{console.error(error);process.exit(1)});
