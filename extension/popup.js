const server=document.querySelector('#server'), token=document.querySelector('#token'), status=document.querySelector('#status'), rokuLeadMs=document.querySelector('#rokuLeadMs'), enabled=document.querySelector('#enabled'), syncMode=document.querySelector('#syncMode'), baton=document.querySelector('#baton');
chrome.storage.local.get(['server','token','rokuLeadMs','enabled','syncMode']).then(x=>{server.value=x.server||'http://127.0.0.1:8766';token.value=x.token||'';rokuLeadMs.value=String(x.rokuLeadMs ?? 0);enabled.checked=x.enabled!==false;syncMode.value=x.syncMode==='peer'?'peer':'roku'});
enabled.onchange=async()=>{await chrome.storage.local.set({enabled:enabled.checked});status.textContent=enabled.checked?'Sync enabled.':'Sync disabled. Playback will continue normally.'};
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
    await chrome.tabs.sendMessage(tab.id,{type:'baton-toggle'});
    status.textContent='Baton updated. Check the page badge.';
  } catch(e) {
    status.textContent='Baton needs a supported streaming tab (reload it first).';
  }
};
document.querySelector('#save').onclick=async()=>{try{let u=new URL(server.value);if(u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Use HTTPS or localhost.');if(!token.value)throw Error('Enter the room token.');const lead=Number(rokuLeadMs.value);if(rokuLeadMs.value.trim()==='' || !Number.isInteger(lead) || lead<-1000 || lead>1000)throw Error('Enter a Roku start offset from -1000 to 1000 ms.');await chrome.storage.local.set({server:u.origin,token:token.value,rokuLeadMs:lead,enabled:enabled.checked,syncMode:syncMode.value==='peer'?'peer':'roku'});status.textContent='Saved. Reload your streaming watch tab.'}catch(e){status.textContent=e.message}};
