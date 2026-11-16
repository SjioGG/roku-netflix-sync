// Popup room flow: create a room, copy and paste invites, take or hand over control.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const IDS=['server','token','status','rokuLeadMs','enabled','syncMode','baton','consent','save','forget','connectApp','connectAppStatus','statePill','consentCard','roomInfo','roomState','people','createRoom','copyInvite','invite'];
function setup({initial={}, inTab=false, hasPermission=true, roomReply, tabStatus=null}={}) {
  const el=Object.fromEntries(IDS.map(id=>[id,{id,value:'',checked:false,textContent:'',disabled:false,className:'',classes:new Set(),
    classList:{toggle(name,on){on?this.owner.classes.add(name):this.owner.classes.delete(name)}}}]));
  for(const e of Object.values(el)) e.classList.owner=e;
  const storage={...initial},opened=[],fetches=[],requests=[],messages=[],clipboard=[];
  const ctx={document:{querySelector:s=>el[s.slice(1)]},URL,AbortSignal,
    navigator:{clipboard:{writeText:async text=>clipboard.push(text)}},
    fetch:async(url,options)=>{fetches.push({url,options});const r=roomReply||{status:201,body:{token:'fresh-room-token-123'}};return {ok:r.status<300,status:r.status,json:async()=>r.body};},
    chrome:{
      storage:{local:{get:async()=>({...storage}),set:async v=>Object.assign(storage,v)},session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
      permissions:{contains:async()=>hasPermission,request:async r=>{requests.push(r);return true}},
      runtime:{getURL:p=>'chrome-extension://fixture/'+p},
      tabs:{getCurrent:async()=>inTab?{id:1}:undefined,create:async v=>opened.push(v),query:async()=>[{id:7}],
        sendMessage:async(id,m)=>{messages.push(m);if(m.type==='room-status') return tabStatus; if(m.type==='baton-claim') return {...tabStatus,master:true}; if(m.type==='baton-pass') return {...tabStatus,master:false}; return {ok:true};}},
    }};
  vm.runInNewContext(fs.readFileSync('extension/popup.js','utf8'),ctx);
  return {el,storage,opened,fetches,requests,messages,clipboard};
}
const tick=()=>new Promise(setImmediate);
(async()=>{
  // Create a room on a relay she has already approved: no settings tab needed.
  const consented={server:'https://relay.example',token:'old',enabled:true,syncMode:'roku',privacyConsent:{version:1,server:'https://relay.example'}};
  const a=setup({initial:consented});await tick();
  await a.el.createRoom.onclick();
  assert.equal(a.fetches[0].url,'https://relay.example/rooms');
  assert.equal(a.fetches[0].options.method,'POST');
  assert.equal(a.fetches[0].options.headers,undefined,'no token or custom headers on the open endpoint');
  assert.equal(a.storage.token,'fresh-room-token-123');
  assert.equal(a.storage.syncMode,'peer','a created room is browser to browser');
  assert.equal(a.storage.roomOwner,'fresh-room-token-123','the creator starts in control');
  assert.equal(a.storage.enabled,true);
  assert.equal(a.opened.length,0,'approved relay saves straight from the popup');
  assert.match(a.el.status.textContent,/Room created/);

  await a.el.copyInvite.onclick();
  assert.equal(a.clipboard[0],'https://relay.example/#room=fresh-room-token-123');

  // Join with a pasted invite.
  const b=setup({initial:{...consented,token:null}});await tick();
  b.el.invite.value='Join me: https://relay.example/#room=fresh-room-token-123 ';
  await b.el.invite.onchange();
  assert.equal(b.storage.token,'fresh-room-token-123');
  assert.equal(b.storage.roomOwner,null,'joining never makes you the creator');
  assert.equal(b.storage.syncMode,'peer');

  // Ticking the agreement first, then pasting an invite for the same relay, keeps it ticked.
  const fresh=setup({hasPermission:true});await tick();
  fresh.el.consent.checked=true;
  fresh.el.invite.value='http://127.0.0.1:8766/#room=abcdefgh12345';
  await fresh.el.invite.onchange();
  assert.equal(fresh.el.consent.checked,true,'same relay keeps the fresh agreement');
  assert.equal(fresh.storage.token,'abcdefgh12345');

  // An invite for a different relay needs fresh consent first.
  const c=setup({initial:consented});await tick();
  c.el.invite.value='https://other.example/#room=abcdefgh12345';
  await c.el.invite.onchange();
  assert.equal(c.storage.token,'old','no consent for the new relay yet');
  assert.equal(c.el.server.value,'https://other.example');
  assert.equal(c.el.token.value,'abcdefgh12345');
  assert.match(c.el.status.textContent,/different relay/);

  // Creating a room is refused before consent and on relay errors.
  const d=setup();await tick();
  await d.el.createRoom.onclick();
  assert.equal(d.fetches.length,0);
  const e=setup({initial:consented,roomReply:{status:429,body:{error:'Too many new rooms. Try again in an hour.'}}});await tick();
  await e.el.createRoom.onclick();
  assert.equal(e.storage.token,'old');
  assert.match(e.el.status.textContent,/Too many new rooms/);

  // Without relay access yet, Save continues in a settings tab.
  const f=setup({initial:consented,hasPermission:false});await tick();
  await f.el.createRoom.onclick();
  assert.equal(f.opened.length,1);
  assert.equal(f.storage.token,'old','nothing is committed until access is approved');

  // Control button follows the tab's role.
  const g=setup({initial:{...consented,syncMode:'peer'},tabStatus:{ok:true,peer:true,master:false,people:2,connected:true}});await tick();await tick();
  assert.equal(g.el.baton.textContent,'Take control');
  assert.equal(g.el.baton.classes.has('hidden'),false);
  assert.match(g.el.people.textContent,/1 other person/);
  assert.equal(g.el.statePill.textContent,'2 watching');
  await g.el.baton.onclick();
  assert.equal(g.messages.at(-1).type,'baton-claim');
  assert.equal(g.el.baton.textContent,'Hand over control');
  await g.el.baton.onclick();
  assert.equal(g.messages.at(-1).type,'baton-pass');
  console.log('Popup creates rooms, shares and joins invites, and hands control over');
})().catch(error=>{console.error(error);process.exitCode=1});
