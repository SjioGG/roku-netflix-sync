const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-228: browser-to-browser peers follow the baton holder without any Roku.
function run({masterClientId, clientId, masterState, syncMode='peer', videoPaused=true, currentTime=21}){
  const listeners={},timers=[],messages=[];
  const video={paused:videoPaused,currentTime,readyState:2,
    addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
    async play(){this.paused=false;listeners.play?.({type:'play'})},
    pause(){this.paused=true;listeners.pause?.({type:'pause'})}};
  const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener:(n,f)=>{if(n==='click')badge.click=f;}};
  let stored={enabled:true,syncMode};
  const ctx={
    document:{createElement:()=>badge,documentElement:{appendChild(){}},querySelector:()=>video,querySelectorAll:()=>[]},
    chrome:{
      storage:{local:{get:(keys,cb)=>{if(cb)cb(stored);return Promise.resolve(stored)}}},
      runtime:{sendMessage(m,cb){
        messages.push(m);
        if(m.type==='read')cb({data:{seq:1,roku:'unavailable',last_update:Date.now()/1000,launch_status:null,title_id:'123',
          sync_mode:syncMode==='peer'?'peer':'roku',master_client_id:masterClientId,master_state:masterState,clients:{}}});
        else if(m.type==='baton')cb({data:{ok:true,sync_mode:'peer',master_client_id:masterClientId}});
        else cb({data:{ok:true}});
      }}
    },
    crypto:{randomUUID:()=>clientId},
    location:{hostname:'www.netflix.com',pathname:'/watch/123',search:''},
    performance:{now:()=>10000},
    setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length},
    Date,Promise,console
  };
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  const drain=async()=>{for(let i=0;i<4;i++){await new Promise(setImmediate);timers.splice(0).forEach(t=>t.fn());await new Promise(setImmediate);}};
  return {video,listeners,messages,badge,timers,drain,ctx};
}

(async()=>{
  const now=Date.now();

  // --- Master: publishes its own playback and can pass the baton. -------------
  const master=run({masterClientId:'alice',clientId:'alice',masterState:{client_id:'alice',title_id:'123',app:'netflix',position_ms:21000,paused:false,received_at_ms:now,client_ms:now}});
  await master.drain();
  assert.match(master.badge.textContent,/Peer sync \(Master\)/,'master sees the master badge');
  assert.match(master.badge.textContent,/click to pass baton/,'master badge advertises passing the baton');
  const telemetry=master.messages.find(m=>m.type==='telemetry');
  assert(telemetry,'master still reports telemetry');
  assert.equal(telemetry.data.sync_mode,'peer','telemetry advertises peer mode');

  master.messages.length=0;
  master.video.currentTime=42;master.video.paused=false;
  master.listeners.pause?.({type:'pause'});
  await new Promise(setImmediate);
  const publish=master.messages.find(m=>m.type==='event' && m.action==='pause');
  assert(publish,'master forwards native pause without a Roku');
  assert.equal(publish.position,42000);
  assert(publish.client_id,'peer events carry the client id');

  master.messages.length=0;
  master.badge.click?.();
  await new Promise(setImmediate);
  const passed=master.messages.find(m=>m.type==='baton');
  assert(passed,'badge click passes the baton');
  assert.equal(passed.data.action,'pass');
  assert.equal(passed.data.sync_mode,'peer');
  assert.equal(passed.data.client_id,publish.client_id,'baton uses the same client id');

  // --- Slave paused: follows a paused master and stays quiet. ------------------
  const slave=run({masterClientId:'alice',clientId:'bob',videoPaused:false,currentTime:60,
    masterState:{client_id:'alice',title_id:'123',app:'netflix',position_ms:30000,paused:true,received_at_ms:now,client_ms:now}});
  await slave.drain();
  assert.match(slave.badge.textContent,/Peer sync \(Slave\)/,'slave sees the slave badge');
  assert.match(slave.badge.textContent,/click to take baton/,'slave badge advertises claiming the baton');
  assert(slave.video.paused,'slave pauses to match a paused master');
  assert.equal(slave.video.currentTime,30,'slave jumps to the master position');
  assert(!slave.messages.some(m=>m.type==='event' && ['play','pause'].includes(m.action)),'slave must not publish playback');

  // Slave clicking the badge claims the baton.
  slave.messages.length=0;
  slave.badge.click?.();
  await new Promise(setImmediate);
  const claimed=slave.messages.find(m=>m.type==='baton');
  assert(claimed,'slave badge click claims the baton');
  assert.equal(claimed.data.action,'claim');
  assert.equal(claimed.data.sync_mode,'peer');

  // --- Slave playing: follows a playing master with a position offset. --------
  const playing=run({masterClientId:'alice',clientId:'bob',videoPaused:true,currentTime:5,
    masterState:{client_id:'alice',title_id:'123',app:'netflix',position_ms:30000,paused:false,received_at_ms:now-1000,client_ms:now-1000}});
  await playing.drain();
  assert(!playing.video.paused,'slave starts playing when the master plays');
  assert(playing.video.currentTime>=30,'slave aligns to the master timeline plus elapsed time');
  assert(playing.video.currentTime<34,'slave does not overshoot by more than elapsed time');

  // --- Local slave edits are ignored while it holds no baton. ------------------
  playing.messages.length=0;
  playing.video.currentTime=90;playing.video.paused=false;
  playing.listeners.pause?.({type:'pause'});
  playing.listeners.seeked?.({type:'seeked'});
  await new Promise(setImmediate);
  assert(!playing.messages.some(m=>m.type==='event' && ['play','pause','seek'].includes(m.action)),'slave local edits are not published');

  // --- Roku mode is unchanged: no baton traffic. -------------------------------
  const roku=run({masterClientId:null,clientId:'carol',syncMode:'roku',masterState:null});
  await roku.drain();
  assert(!roku.messages.some(m=>m.type==='baton'),'roku mode sends no baton traffic');
  assert.match(roku.badge.textContent,/Roku sync/,'roku mode keeps the Roku badge');

  console.log('Peer mode follows the master, publishes only from the baton holder, and claims/passes the baton');
})().catch(error=>{console.error(error);process.exit(1)});
