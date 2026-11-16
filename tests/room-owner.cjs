const fs=require('fs'),vm=require('vm'),assert=require('assert');
// The room creator takes control once, and the popup can query and move the baton.
function run({masterClientId, clientId, roomOwner, token='room-1', clients={}}){
  const timers=[],messages=[],writes=[];let onMessage=null;
  const video={paused:false,currentTime:30,readyState:4,addEventListener(){},removeEventListener(){},async play(){},pause(){}};
  const badge={style:{},textContent:'',title:'',setAttribute(){},addEventListener(){}};
  const stored={enabled:true,syncMode:'peer',server:'http://127.0.0.1:8766',token,roomOwner,privacyConsent:{version:1,server:'http://127.0.0.1:8766'}};
  let master=masterClientId;
  const ctx={
    document:{createElement:()=>badge,documentElement:{appendChild(){}},querySelector:()=>video,querySelectorAll:()=>[]},
    chrome:{
      storage:{local:{get:(keys,cb)=>{cb?.(stored);return Promise.resolve(stored)},set:v=>{writes.push(v);return Promise.resolve()}}},
      runtime:{onMessage:{addListener:f=>onMessage=f},sendMessage(m,cb){
        messages.push(m);
        if(m.type==='read')cb({data:{seq:1,room:'browser',title_id:'123',sync_mode:'peer',master_client_id:master,master_state:null,clients}});
        else if(m.type==='baton'){if(m.data.action==='claim')master=m.data.client_id;cb({data:{ok:true,sync_mode:'peer',master_client_id:master}});}
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
  const ask=m=>new Promise(resolve=>{const sync=onMessage(m,{},resolve);if(sync!==true&&sync!==undefined)resolve(sync);});
  return {messages,writes,drain,ask};
}
(async()=>{
  const now=Date.now();
  const crowd={gf:{received_at_ms:now,title_id:'123',position_ms:1},creator:{received_at_ms:now,title_id:'123',position_ms:1},'ref-tv':{received_at_ms:now}};

  const creator=run({masterClientId:'gf',clientId:'creator',roomOwner:'room-1',clients:crowd});
  await creator.drain();
  const claims=creator.messages.filter(m=>m.type==='baton'&&m.data.action==='claim');
  assert.equal(claims.length,1,'the creator claims control exactly once');
  assert.deepEqual(creator.writes[0],{roomOwner:null},'the one-time claim is cleared in storage');
  const status=await creator.ask({type:'room-status'});
  assert.equal(status.master,true);
  assert.equal(status.peer,true);
  assert.equal(status.people,2,'TV reference tabs are not people');

  const guest=run({masterClientId:'creator',clientId:'gf',roomOwner:null,clients:crowd});
  await guest.drain();
  assert.equal(guest.messages.filter(m=>m.type==='baton').length,0,'joiners never auto-claim');
  const before=await guest.ask({type:'room-status'});
  assert.equal(before.master,false);
  const after=await guest.ask({type:'baton-claim'});
  assert.equal(after.master,true,'anyone can take control from the popup');
  const handed=await guest.ask({type:'baton-pass'});
  assert.equal(guest.messages.filter(m=>m.type==='baton').at(-1).data.action,'pass');
  assert.equal(handed.ok,true);

  const stale=run({masterClientId:'gf',clientId:'creator',roomOwner:'older-room',clients:crowd});
  await stale.drain();
  assert.equal(stale.messages.filter(m=>m.type==='baton').length,0,'an owner flag from another room is ignored');
  console.log('Room creator starts in control once; the popup reads and moves the baton');
})().catch(error=>{console.error(error);process.exitCode=1});
