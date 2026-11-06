const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-219: a second Chrome client on the same title shows passive drift on the badge.
function run(peerPosition) {
  const listeners={},timers=[];
  const video={paused:false,currentTime:21,readyState:2,ended:false,
    addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
    async play(){this.paused=false;listeners.play?.({type:'play'})},
    pause(){this.paused=true;listeners.pause?.({type:'pause'})}};
  const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener(){}};
  const ctx={
    document:{createElement:()=>badge,documentElement:{appendChild(){}},querySelector:()=>video,querySelectorAll:()=>[]},
    chrome:{runtime:{sendMessage(m,cb){
      if(m.type==='read')cb({data:{seq:1,roku:'play',last_update:Date.now()/1000,launch_status:'sent',title_id:'123',
        clients:peerPosition===null?{}:{peer:{title_id:'123',position_ms:peerPosition,received_at_ms:Date.now()}}}});
      else cb({data:{ok:true}});
    }}},
    location:{pathname:'/watch/123'},performance:{now:()=>10000},
    setTimeout:(f,delay)=>{timers.push({f,delay});return timers.length},Date,Promise,console
  };
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),ctx);
  return {badge,timers};
}
(async()=>{
  const ahead=run(31000);await new Promise(setImmediate);
  assert.match(ahead.badge.textContent,/behind peer/,'this client is behind a peer at 31s');
  assert.match(ahead.badge.textContent,/click to re-sync/,'drift advertises the click action');

  const behind=run(11000);await new Promise(setImmediate);
  assert.match(behind.badge.textContent,/ahead of peer/,'this client is ahead of a peer at 11s');

  const solo=run(null);await new Promise(setImmediate);
  assert.doesNotMatch(solo.badge.textContent,/peer/,'a single client shows no drift');
  console.log('Drift badge reports peer offset and advertises click-to-resync');
})().catch(error=>{console.error(error);process.exit(1)});
