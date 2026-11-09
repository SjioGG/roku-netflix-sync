const server=document.querySelector('#server'), token=document.querySelector('#token'), status=document.querySelector('#status'), rokuLeadMs=document.querySelector('#rokuLeadMs'), enabled=document.querySelector('#enabled'), syncMode=document.querySelector('#syncMode'), baton=document.querySelector('#baton'), consent=document.querySelector('#consent');
let saved={}, settingsTab=false;
function hasConsent(value) {
  return value.privacyConsent?.version===1 && !!value.server && value.privacyConsent.server===value.server;
}
function relayUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw Error('Use HTTPS or localhost.');
  if(url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('Enter only the relay origin, without credentials, a path or a query.');
  return url;
}
Promise.all([chrome.storage.local.get(['server','token','rokuLeadMs','enabled','syncMode','privacyConsent']),chrome.tabs.getCurrent()]).then(async ([value,tab])=>{
  saved=value;settingsTab=!!tab;
  if(settingsTab) {
    const {relaySetupDraft}=await chrome.storage.session.get('relaySetupDraft');
    if(relaySetupDraft) {value=relaySetupDraft;await chrome.storage.session.remove('relaySetupDraft');}
  }
  server.value=value.server||'http://127.0.0.1:8766';
  token.value=value.token||'';
  rokuLeadMs.value=String(value.rokuLeadMs ?? 0);
  consent.checked=hasConsent(value);
  enabled.checked=value.enabled===true && hasConsent(value);
  syncMode.value=value.syncMode==='peer'?'peer':'roku';
  if(settingsTab) status.textContent='Review these settings and Save to approve relay access and finish connecting.';
  else if(!hasConsent(value)) status.textContent='Sync is off. Review data sharing, choose your settings, and Save to start.';
});
enabled.onchange=async()=>{
  if(!enabled.checked) {
    await chrome.storage.local.set({enabled:false});saved.enabled=false;
    status.textContent='Sync disabled. Playback will continue normally.';
  } else if(hasConsent(saved) && consent.checked && server.value.trim()===saved.server) {
    await chrome.storage.local.set({enabled:true});saved.enabled=true;
    status.textContent='Sync enabled.';
  } else status.textContent='Review data sharing and Save to enable sync.';
};
consent.onchange=async()=>{
  if(!consent.checked) {
    enabled.checked=false;
    await chrome.storage.local.set({enabled:false,privacyConsent:null});
    saved.enabled=false;saved.privacyConsent=null;
    status.textContent='Consent withdrawn. No new relay requests will be sent. Existing room data is held by the relay.';
  }
};
server.oninput=async()=>{
  // Permission and data-sharing consent are specific to the chosen relay.
  try {consent.checked=hasConsent(saved) && relayUrl(server.value).origin===saved.server;}
  catch {consent.checked=false;}
  if(!consent.checked && hasConsent(saved)) await consent.onchange();
};
syncMode.onchange=async()=>{
  const mode=syncMode.value==='peer'?'peer':'roku';
  await chrome.storage.local.set({syncMode:mode});
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(tab?.id) chrome.tabs.sendMessage(tab.id,{type:'sync-mode',sync_mode:mode}).catch(()=>{});
  status.textContent=mode==='peer'?'Browser-to-browser mode. One tab holds the baton.':'Roku + browser mode.';
};
baton.onclick=async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id) {status.textContent='Open a streaming tab first.';return;}
  try {
    const result=await chrome.tabs.sendMessage(tab.id,{type:'baton-toggle'});
    status.textContent=result?.disabled?'Enable sync after reviewing data sharing and saving settings.':'Baton updated. Check the page badge.';
  } catch {
    status.textContent='Baton needs a supported streaming tab (reload it first).';
  }
};
document.querySelector('#save').onclick=async()=>{
  try {
    const url=relayUrl(server.value);
    if(!token.value.trim()) throw Error('Enter the room token.');
    if(!consent.checked) throw Error('Review and accept data sharing before connecting.');
    const lead=Number(rokuLeadMs.value);
    if(rokuLeadMs.value.trim()==='' || !Number.isInteger(lead) || lead<-1000 || lead>1000) throw Error('Enter a Roku start offset from -1000 to 1000 ms.');
    const next={server:url.origin,token:token.value.trim(),rokuLeadMs:lead,enabled:enabled.checked,syncMode:syncMode.value==='peer'?'peer':'roku',privacyConsent:{version:1,server:url.origin}};
    if(!settingsTab) {
      // Chrome closes action popups for native permission prompts. Keep the draft
      // in extension-only session storage and finish Save in a persistent tab.
      await chrome.storage.session.set({relaySetupDraft:next});
      await chrome.tabs.create({url:chrome.runtime.getURL('popup.html')});
      return;
    }
    // Call directly from the click gesture in the settings tab.
    const granted=await chrome.permissions.request({origins:[url.protocol+'//'+url.hostname+'/*']});
    if(!granted) throw Error('Relay access was not granted. Settings were not changed.');
    saved=next;
    await chrome.storage.local.set(saved);
    status.textContent=enabled.checked?'Saved. Reload streaming tabs if you changed the relay or room token.':'Saved. Tick Enable Roku sync when ready.';
  } catch(error) {status.textContent=error.message;}
};
document.querySelector('#forget').onclick=async()=>{
  await chrome.storage.session.remove('relaySetupDraft');
  await chrome.storage.local.set({enabled:false,privacyConsent:null,server:null,token:null,rokuLeadMs:0,syncMode:'roku'});
  saved={};server.value='http://127.0.0.1:8766';token.value='';rokuLeadMs.value='0';syncMode.value='roku';enabled.checked=false;consent.checked=false;
  status.textContent='Local relay settings removed. Contact the relay operator about existing room data.';
};
