const $=id=>document.querySelector('#'+id);
const server=$('server'), token=$('token'), status=$('status'), rokuLeadMs=$('rokuLeadMs'), enabled=$('enabled'), syncMode=$('syncMode'), baton=$('baton'), consent=$('consent');
const statePill=$('statePill'), consentCard=$('consentCard'), roomInfo=$('roomInfo'), roomState=$('roomState'), people=$('people'), createRoom=$('createRoom'), copyInvite=$('copyInvite'), invite=$('invite');
const DEFAULT_RELAY='http://127.0.0.1:8766';
let saved={}, settingsTab=false, roomOwner=null, tabStatus=null;
function hasConsent(value) {
  return value.privacyConsent?.version===1 && !!value.server && value.privacyConsent.server===value.server;
}
function relayUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw Error('Use HTTPS or localhost.');
  if(url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('Enter only the relay origin, without credentials, a path or a query.');
  return url;
}
function inviteFor(origin, room) {return origin+'/#room='+encodeURIComponent(room);}
/** ``https://relay/#room=TOKEN`` -> {server, token}; a bare token keeps the current relay. */
function parseInvite(text) {
  const value=String(text||'').trim();
  if(!value) return null;
  const match=value.match(/https?:\/\/[^\s#]+#room=([A-Za-z0-9_%-]+)/);
  if(match) {
    const url=new URL(match[0]);
    return {server:url.origin, token:decodeURIComponent(match[1])};
  }
  if(/^[A-Za-z0-9_-]{8,200}$/.test(value)) return {server:null, token:value};
  throw Error('That does not look like a Roku Sync invite.');
}
function setText(el, text) {if(el) el.textContent=text;}
function show(el, visible) {el?.classList?.toggle?.('hidden', !visible);}
function render() {
  const ready=hasConsent(saved) && !!saved.token;
  const on=ready && saved.enabled===true;
  if(statePill) {
    statePill.textContent=on ? (tabStatus?.people>1 ? tabStatus.people+' watching' : 'On') : ready ? 'Paused' : 'Not set up';
    statePill.className='pill'+(on?' on':ready?'':' warn');
  }
  consentCard?.classList?.toggle?.('compact', hasConsent(saved) && consent.checked);
  if(copyInvite) copyInvite.disabled=!(saved.server && saved.token);
  const peer=tabStatus?.peer;
  show(roomInfo, on);
  show(baton, on && !!peer && !!tabStatus?.connected);
  if(!on) return;
  if(!tabStatus) {
    setText(roomState, saved.syncMode==='peer' ? 'Room ready' : 'Following the Roku TV');
    setText(people, 'Open Netflix or YouTube in this window to start.');
    return;
  }
  if(!peer) {
    setText(roomState, 'Following the Roku TV');
    setText(people, tabStatus.connected ? 'Connected.' : 'Connecting…');
    return;
  }
  const others=Math.max(0,(tabStatus.people||0)-1);
  setText(roomState, tabStatus.master ? 'You are in control' : 'Following the person in control');
  setText(people, others ? `${others} other ${others===1?'person':'people'} in the room.` : 'Nobody else here yet. Send them the invite.');
  baton.textContent=tabStatus.master ? 'Hand over control' : 'Take control';
}
async function activeTab() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  return tab?.id ? tab : null;
}
async function refreshTabStatus() {
  try {
    const tab=await activeTab();
    const result=tab ? await chrome.tabs.sendMessage(tab.id,{type:'room-status'}) : null;
    tabStatus=result?.ok ? result : null;
  } catch {tabStatus=null;}
  render();
}
Promise.all([chrome.storage.local.get(['server','token','rokuLeadMs','enabled','syncMode','privacyConsent','roomOwner']),chrome.tabs.getCurrent()]).then(async ([value,tab])=>{
  saved=value;settingsTab=!!tab;
  if(settingsTab) {
    const {relaySetupDraft}=await chrome.storage.session.get('relaySetupDraft');
    if(relaySetupDraft) {value=relaySetupDraft;roomOwner=relaySetupDraft.roomOwner||null;await chrome.storage.session.remove('relaySetupDraft');}
  }
  server.value=value.server||DEFAULT_RELAY;
  token.value=value.token||'';
  rokuLeadMs.value=String(value.rokuLeadMs ?? 0);
  consent.checked=hasConsent(value);
  enabled.checked=value.enabled===true && hasConsent(value);
  syncMode.value=value.syncMode==='peer'?'peer':'roku';
  if(settingsTab) status.textContent='Check these settings and press Save to finish connecting.';
  else if(!hasConsent(value)) status.textContent='Tick the agreement, then create a room or paste an invite.';
  render();
  if(!settingsTab) refreshTabStatus();
});
enabled.onchange=async()=>{
  if(!enabled.checked) {
    await chrome.storage.local.set({enabled:false});saved.enabled=false;
    status.textContent='Sync off. Playback continues normally.';
  } else if(hasConsent(saved) && consent.checked && server.value.trim()===saved.server) {
    await chrome.storage.local.set({enabled:true});saved.enabled=true;
    status.textContent='Sync on.';
  } else status.textContent='Tick the agreement and press Save to turn sync on.';
  render();
};
consent.onchange=async()=>{
  if(!consent.checked) {
    enabled.checked=false;
    await chrome.storage.local.set({enabled:false,privacyConsent:null});
    saved.enabled=false;saved.privacyConsent=null;
    status.textContent='Consent withdrawn. No new relay requests will be sent. Existing room data is held by the relay.';
  }
  render();
};
server.oninput=async()=>{
  // Permission and data-sharing consent are specific to the chosen relay.
  try {consent.checked=hasConsent(saved) && relayUrl(server.value).origin===saved.server;}
  catch {consent.checked=false;}
  if(!consent.checked && hasConsent(saved)) await consent.onchange();
};
syncMode.onchange=async()=>{
  const mode=syncMode.value==='peer'?'peer':'roku';
  await chrome.storage.local.set({syncMode:mode});saved.syncMode=mode;
  const tab=await activeTab();
  if(tab) chrome.tabs.sendMessage(tab.id,{type:'sync-mode',sync_mode:mode}).catch(()=>{});
  status.textContent=mode==='peer'?'Browser to browser. One person is in control at a time.':'Roku TV + browser.';
  render();
};
baton.onclick=async()=>{
  const tab=await activeTab();
  if(!tab) {status.textContent='Open a Netflix or YouTube tab first.';return;}
  const type=tabStatus ? (tabStatus.master?'baton-pass':'baton-claim') : 'baton-toggle';
  try {
    const result=await chrome.tabs.sendMessage(tab.id,{type});
    if(result?.disabled) status.textContent='Turn sync on first.';
    else if(result?.error) status.textContent=result.error;
    else {
      status.textContent=type==='baton-pass'?'Control handed over.':type==='baton-claim'?'You are in control.':'Updated. Check the page badge.';
      if(result?.ok && 'master' in result) {tabStatus=result;render();}
      else refreshTabStatus();
    }
  } catch {
    status.textContent='Reload the Netflix or YouTube tab, then try again.';
  }
};
async function save(alreadyGranted=false) {
  try {
    const url=relayUrl(server.value);
    if(!token.value.trim()) throw Error('Create a room or paste an invite first.');
    if(!consent.checked) throw Error('Tick the agreement before connecting.');
    const lead=Number(rokuLeadMs.value);
    if(rokuLeadMs.value.trim()==='' || !Number.isInteger(lead) || lead<-1000 || lead>1000) throw Error('Enter a start offset from -1000 to 1000 ms.');
    const next={server:url.origin,token:token.value.trim(),rokuLeadMs:lead,enabled:enabled.checked,syncMode:syncMode.value==='peer'?'peer':'roku',privacyConsent:{version:1,server:url.origin},
      roomOwner:roomOwner && roomOwner===token.value.trim() ? roomOwner : null};
    const origins=[url.protocol+'//'+url.hostname+'/*'];
    if(!settingsTab) {
      const has=await chrome.permissions?.contains?.({origins}).catch(()=>false);
      if(has!==true) {
        // Chrome closes action popups for native permission prompts. Keep the draft
        // in extension-only session storage and finish Save in a persistent tab.
        await chrome.storage.session.set({relaySetupDraft:next});
        await chrome.tabs.create({url:chrome.runtime.getURL('popup.html')});
        return;
      }
    } else if(!alreadyGranted) {
      // Call directly from the click gesture in the settings tab.
      const granted=await chrome.permissions.request({origins});
      if(!granted) throw Error('Relay access was not granted. Settings were not changed.');
    }
    saved=next;
    await chrome.storage.local.set(saved);
    status.textContent=enabled.checked?'Saved. Reload the Netflix or YouTube tab to join.':'Saved. Tick Sync on when you are ready.';
    render();
  } catch(error) {status.textContent=error.message;}
}
$('save').onclick=()=>save();
if(createRoom) createRoom.onclick=async()=>{
  try {
    if(!consent.checked) throw Error('Tick the agreement first.');
    const url=relayUrl(server.value);
    // Ask for relay access while the click still counts as a user gesture.
    const granted=settingsTab ? await chrome.permissions.request({origins:[url.protocol+'//'+url.hostname+'/*']}) : false;
    if(settingsTab && !granted) throw Error('Relay access was not granted.');
    status.textContent='Creating a room…';
    // /rooms needs no token and answers extension pages with CORS.
    const response=await fetch(url.origin+'/rooms',{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok || !data.token) throw Error(data.error || `The relay could not create a room (HTTP ${response.status}).`);
    token.value=data.token;roomOwner=data.token;
    syncMode.value='peer';enabled.checked=true;
    await save(granted);
    if(saved.token===data.token) status.textContent='Room created. Copy the invite and send it. You start in control.';
  } catch(error) {status.textContent=error.message;}
};
if(copyInvite) copyInvite.onclick=async()=>{
  try {
    await navigator.clipboard.writeText(inviteFor(saved.server, saved.token));
    status.textContent='Invite copied. Send it to whoever you are watching with.';
  } catch {status.textContent='Could not copy. Open Settings and copy the relay and room token instead.';}
};
if(invite) invite.onchange=async()=>{
  try {
    const parsed=parseInvite(invite.value);
    if(!parsed) return;
    let sameRelay=true;
    try {sameRelay=!parsed.server || relayUrl(server.value).origin===parsed.server;} catch {sameRelay=false;}
    if(!sameRelay) {server.value=parsed.server;await server.oninput();}
    token.value=parsed.token;roomOwner=null;
    syncMode.value='peer';enabled.checked=true;
    invite.value='';
    if(!consent.checked) {status.textContent=sameRelay?'Invite added. Tick the agreement and press Save.':'Invite for a different relay. Tick the agreement again and press Save.';return;}
    await save();
  } catch(error) {status.textContent=error.message;}
};
const connectStatus=$('connectAppStatus');
const APP_ORIGINS=['http://127.0.0.1/*'];
chrome.permissions?.contains?.({origins:APP_ORIGINS})?.then?.(has=>{if(has) connectStatus.textContent='Connected: reference tabs reach Roku Sync.app on this Mac.';}).catch(()=>{});
$('connectApp').onclick=async()=>{
  try {
    if(!settingsTab) {
      // Chrome closes the action popup for the permission prompt.
      await chrome.tabs.create({url:chrome.runtime.getURL('popup.html')+'#connect-app'});
      return;
    }
    const granted=await chrome.permissions.request({origins:APP_ORIGINS});
    connectStatus.textContent=granted?'Connected: reload the TV reference tab.':'Not connected. Reference tabs will ask for local network access instead.';
  } catch(error) {connectStatus.textContent=error.message;}
};
$('forget').onclick=async()=>{
  await chrome.storage.session.remove('relaySetupDraft');
  await chrome.storage.local.set({enabled:false,privacyConsent:null,server:null,token:null,rokuLeadMs:0,syncMode:'roku',roomOwner:null});
  saved={};roomOwner=null;server.value=DEFAULT_RELAY;token.value='';rokuLeadMs.value='0';syncMode.value='roku';enabled.checked=false;consent.checked=false;
  status.textContent='Room and relay removed from this browser. Contact the relay operator about existing room data.';
  render();
};
