(() => {
  let video=null, title=null, titleSending=false, invalidated=false, seq=null, state=null, attempt=null;
  let notice='', noticeUntil=0, seekGeneration=0, pendingSeek=null, seekInFlight=null, telemetryInFlight=false;
  let syncEnabled=false, syncMode='roku', pollLoop=0, pollStarted=false, driftMs=null;
  const settings={};
  const changedSettings=new Set();
  let roomUsed=false;
  function detectRefMode() {
    try {
      const h=String((typeof location!=='undefined' && location?.hash)||'');
      const s=String((typeof location!=='undefined' && location?.search)||'');
      const fromDoc=document.documentElement?.getAttribute?.('data-roku-sync-ref')==='1';
      if(/roku-sync-ref/i.test(h) || /roku_sync_ref=1/i.test(s) || fromDoc) {
        try {globalThis.sessionStorage?.setItem?.('rokuSyncRef','1');} catch(e) {}
        try {document.documentElement?.setAttribute?.('data-roku-sync-ref','1');} catch(e) {}
        return true;
      }
      return globalThis.sessionStorage?.getItem?.('rokuSyncRef')==='1';
    } catch(e) {return false;}
  }
  const isRefTab=detectRefMode();
  let localAppConnected=false, localMirrorState=null;
  const rawClientId=globalThis.crypto?.randomUUID?.() || 'client-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const clientId=((isRefTab?'ref-':'')+rawClientId).slice(0,64);
  const suppressed=new WeakMap();
  document.querySelectorAll?.('[data-roku-sync-overlay]').forEach(node=>node.remove());
  const badge=document.createElement('div');
  badge.setAttribute?.('data-roku-sync-overlay',''); badge.setAttribute?.('role','status');
  Object.assign(badge.style,{position:'fixed',top:'20px',right:'20px',zIndex:'2147483647',background:'#171923',color:'#fff',padding:'10px 12px',border:'1px solid #65728b',borderRadius:'8px',font:'12px/1.45 system-ui',maxWidth:'360px',boxShadow:'0 2px 10px #0008',cursor:'pointer'});
  badge.title='Click to re-sync with Roku';badge.setAttribute?.('title','Click to re-sync with Roku');
  badge.style.display='none';
  badge.textContent='Roku sync: connecting';document.documentElement.appendChild(badge);
  badge.addEventListener?.('click',()=>{
    if(invalidated) return;
    if(isRefTab) {
      if(video) {
        ensureRefAudio(video);
        const shouldPlay=localMirrorState ? !localMirrorState.paused : state?.roku==='play';
        if(video.paused && shouldPlay) playQuietly(video).catch(()=>{});
      }
      return;
    }
    if(!syncEnabled) return;
    if(peerMode()){batonToggle();return;}
    if(!video || video.ended) return;
    if(!detectMedia()) return;
    pauseQuietly(video);
    startTogether(video);
  });
  function setSyncEnabled(value) {
    const next=value!==false;
    if(next===syncEnabled) {
      if(!next && isRefTab && !invalidated) {
        badge.style.display='';
        if(!localAppConnected) badge.textContent='TV Reference: Connecting to Roku Sync app…';
      }
      return;
    }
    pollLoop++;
    if(next) {
      if(invalidated) return;
      syncEnabled=true;
      roomUsed=true;
      badge.style.display='';
      if(!invalidated) poll();
    } else {
      syncEnabled=false;
      const old=cancelAttempt();pendingSeek=null;++seekGeneration;
      if(old?.video===video && video?.paused) playQuietly(video).catch(()=>{});
      pollStarted=false;
      if(isRefTab && !invalidated) {
        badge.style.display='';
        if(!localAppConnected) badge.textContent='TV Reference: Connecting to Roku Sync app…';
      } else {
        badge.style.display='none';
      }
    }
  }
  function setSyncMode(value) {syncMode=value==='peer'?'peer':'roku';}
  function applySettings() {
    setSyncMode(settings.syncMode);
    setSyncEnabled(settings.enabled===true && settings.privacyConsent?.version===1 &&
      !!settings.server && settings.privacyConsent.server===settings.server);
  }
  chrome.storage?.onChanged?.addListener?.((changes,area)=>{
    if(area!=='local') return;
    const roomChanged=['server','token'].some(key=>changes[key] && changes[key].newValue!==settings[key]);
    for(const key of ['enabled','privacyConsent','server','token','syncMode']) {
      if(changes[key]) {settings[key]=changes[key].newValue;changedSettings.add(key);}
    }
    if(roomChanged && roomUsed) {
      // Keep old-room callbacks and scheduled work out of a new room.
      // As in the original setup flow, reload the tab after changing rooms.
      setSyncEnabled(false);invalidated=true;
      if(video) ['play','pause','seeked'].forEach(name=>video.removeEventListener(name,onEvent));
      video=null;
      if(settings.enabled===true && settings.privacyConsent?.server===settings.server) {
        badge.style.display='';say('Relay or room changed. Reload this tab to reconnect.');
      }
      return;
    }
    applySettings();
  });

  function say(message) {notice=message;noticeUntil=performance.now()+(message.startsWith('Sync failed')?30000:10000);badge.textContent=(peerMode()?'Peer sync: ':'Roku sync: ')+message;}
  function suppress(v,action) {let counts=suppressed.get(v);if(!counts){counts={};suppressed.set(v,counts);}counts[action]=(counts[action]||0)+1;}
  function consume(v,action) {const counts=suppressed.get(v);if(!counts?.[action]) return false;counts[action]--;return true;}
  function pauseQuietly(v) {if(!v.paused){suppress(v,'pause');v.pause();}}
  async function playQuietly(v) {if(!v.paused)return;suppress(v,'play');try{await v.play();}catch(e){consume(v,'play');throw e;}}
  const send=message=>new Promise(resolve=>{
    function fail(error){
      const text=error?.message||String(error||'Extension disconnected');
      if(/extension context invalidated/i.test(text)) {
        if(attempt && video?.paused) playQuietly(video).catch(()=>{});
        attempt=null; invalidated=true; if(video) ['play','pause','seeked'].forEach(name=>video.removeEventListener(name,onEvent));
        video=null;say('Extension reloaded. Reload this Netflix page.');
      }
      resolve({error:text});
    }
    if(!syncEnabled) return resolve({data:{disabled:true}});
    try{chrome.runtime.sendMessage(message,response=>{try{const error=chrome.runtime.lastError;if(error)return fail(error);if(response?.data?.disabled)setSyncEnabled(false);resolve(response||{error:'Extension disconnected'});}catch(error){fail(error);}});}catch(error){fail(error);}
  });

  // ---- Streaming-app detection -------------------------------------------------
  const FALLBACK_HOSTS=[['primevideo.com','primevideo'],['disneyplus.com','disneyplus'],['max.com','max'],['apple.com','appletv'],['hulu.com','hulu'],['twitch.tv','twitch']];
  function locationInfo() {
    try { return (typeof location!=='undefined' && location) || {}; } catch(e) { return {}; }
  }
  function slugValue(value) {
    const cleaned=String(value==null?'':value).replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
    return cleaned || null;
  }
  function decodeValue(value) {
    try { return decodeURIComponent(value); } catch(e) { return value; }
  }
  function hasVideoElement() {
    try { return !!document.querySelector?.('video'); } catch(e) { return false; }
  }
  /** Best-effort streaming-title identity for the current page. */
  function detectMedia() {
    const loc=locationInfo();
    const host=String(loc.hostname||'').toLowerCase();
    const path=String(loc.pathname||'');
    const search=String(loc.search||'');
    const hash=String(loc.hash||'');
    // Unit tests and older harnesses omit hostname; treat that as Netflix.
    if(!host || /(^|\.)netflix\.com$/.test(host)) {
      const match=/^\/watch\/([A-Za-z0-9_-]+)/.exec(path);
      return match ? {app:'netflix', titleId:match[1]} : null;
    }
    if(/(^|\.)youtube\.com$/.test(host)) {
      const watch=/(?:^|[?&])v=([A-Za-z0-9_-]{6,20})/.exec(search);
      const shorts=/^\/shorts\/([A-Za-z0-9_-]{6,20})/.exec(path);
      if(shorts) return {app:'youtube', titleId:shorts[1]};
      if(watch) return {app:'youtube', titleId:watch[1]};
      if(/^\/watch/.test(path)) return {app:'youtube', titleId:'youtube-session'};
      if(/^\/shorts/.test(path)) return {app:'youtube', titleId:'youtube-shorts'};
      return null;
    }
    if(/(^|\.)plex\.tv$/.test(host) || /(^|\.)plex\.direct$/.test(host)) {
      if(!hasVideoElement() && !/key=|\/server\/|#!/.test(path+search+hash)) return null;
      const key=/(?:^|[?&#])key=([^&]+)/.exec(search) || /(?:^|[?&#])key=([^&]+)/.exec(hash);
      const titleId=slugValue(decodeValue(key?key[1]:null)) || slugValue(hash) || slugValue(path) || 'plex-session';
      return {app:'plex', titleId};
    }
    for(const [domain,app] of FALLBACK_HOSTS) {
      if(host===domain || host.endsWith('.'+domain)) {
        if(!hasVideoElement()) return null;
        return {app, titleId:slugValue(path) || app+'-session'};
      }
    }
    return null;
  }

  // ---- Peer (browser-to-browser) & Silent TV Reference follower -----------------
  let clockOffsetMs=null, clockInFlight=false;
  function ensureClockOffset() {
    if(clockOffsetMs!==null || clockInFlight || !syncEnabled || invalidated) return;
    clockInFlight=true;
    const wall=Date.now(), started=performance.now();
    send({type:'clock'}).then(res=>{
      const rtt=performance.now()-started;
      const srv=res?.data?.server_ms;
      const rcv=res?.data?.received_ms ?? srv;
      if(Number.isFinite(srv) && Number.isFinite(rcv)) {
        clockOffsetMs=Math.round((rcv+srv)/2-(wall+rtt/2));
      }
    }).finally(()=>{clockInFlight=false;});
  }
  function ensureRefAudio(v) {
    if(!isRefTab || !v) return;
    try {
      if(v.muted) v.muted=false;
      if(typeof v.volume==='number' && v.volume<0.5) v.volume=1;
    } catch(e) {}
  }
  function appFromState(st) {
    if(!st) return null;
    if(st.app_id==='12' || st.app_name==='Netflix') return 'netflix';
    if(st.app_id==='837' || st.app_name==='YouTube') return 'youtube';
    return st.chrome?.app || null;
  }
  function buildWatchUrl(app, titleId, keepRef) {
    if(!app || !titleId) return null;
    const suffix=keepRef?'#roku-sync-ref':'';
    if(app==='netflix' && /^[A-Za-z0-9_-]{1,64}$/.test(titleId)) {
      return 'https://www.netflix.com/watch/'+titleId+suffix;
    }
    if(app==='youtube' && /^[A-Za-z0-9_-]{6,20}$/.test(titleId) && titleId!=='youtube-session' && titleId!=='youtube-shorts') {
      return 'https://www.youtube.com/watch?v='+titleId+suffix;
    }
    return null;
  }
  function maybeNavigateFollower(targetApp, targetTitle, media) {
    if(!targetApp || !targetTitle) return false;
    if(media && media.app===targetApp && String(media.titleId)===String(targetTitle)) return false;
    const url=buildWatchUrl(targetApp, targetTitle, isRefTab);
    if(!url) return false;
    try {location.href=url;return true;} catch(e) {return false;}
  }
  function peerMode() {return syncMode==='peer' || state?.sync_mode==='peer';}
  function isMasterClient() {
    if(isRefTab) return false;
    return !state?.master_client_id || state.master_client_id===clientId;
  }
  function batonToggle() {
    const master=isMasterClient();
    send({type:'baton',data:{action:master?'pass':'claim',client_id:clientId,sync_mode:'peer'}}).then(result=>{
      if(invalidated) return;
      if(result.error) {say('Baton failed · '+result.error);return;}
      if(!master && video) {
        // Announce our own position so slaves follow the new master immediately.
        send({type:'event',action:video.paused?'pause':'play',position:Math.round(video.currentTime*1000),client_id:clientId,app:detectMedia()?.app||'netflix'});
      }
      say(master?'Baton passed to another browser':'Master baton claimed');
    });
  }
  function masterTarget(master) {
    const base=Number.isFinite(master.position_ms)?master.position_ms:null;
    if(base===null) return null;
    if(master.paused) return base;
    const useServer=clockOffsetMs!==null && Number.isFinite(master.received_at_ms);
    const nowMs=useServer ? Date.now()+clockOffsetMs : Date.now();
    const stamp=useServer
      ? master.received_at_ms
      : (Number.isFinite(master.client_ms) ? master.client_ms : (Number.isFinite(master.received_at_ms) ? master.received_at_ms : nowMs));
    const elapsed=Math.max(0,nowMs-stamp);
    if(elapsed>15000) return null;
    return base+elapsed;
  }
  let lastPeerSeekAt=-10000;
  function seekPeerVideo(v,target,force=false) {
    const now=performance.now();
    if(!force && now-lastPeerSeekAt<1200) return;
    lastPeerSeekAt=now;
    suppress(v,'seek');
    const media=detectMedia();
    let cadmiumHandled=false;
    if((!media || media.app==='netflix') && document.dispatchEvent && typeof CustomEvent==='function') {
      const id='peer-'+String(++bridgeRequest)+'-'+Date.now();
      const onAck=ev=>{if(ev?.detail?.id===id && !ev.detail.error) cadmiumHandled=true;};
      try {
        document.addEventListener?.('roku-sync-seek-result',onAck);
        document.dispatchEvent(new CustomEvent('roku-sync-seek',{detail:{id,position:Math.round(target)}}));
      } catch(e) {}
      finally {
        try {document.removeEventListener?.('roku-sync-seek-result',onAck);} catch(e) {}
      }
    }
    if(!cadmiumHandled) {
      try {v.currentTime=target/1000;} catch(e) {}
    }
  }
  function followMaster(master,v) {
    if(!master || master.client_id===clientId) return;
    ensureRefAudio(v);
    const media=detectMedia();
    if(media?.titleId && master.title_id && String(master.title_id)!==String(media.titleId)) return;
    const target=masterTarget(master);
    if(target===null) return;
    const current=Math.round(v.currentTime*1000);
    if(master.paused===true) {
      if(!v.paused) pauseQuietly(v);
      if(Math.abs(current-target)>600) seekPeerVideo(v,target);
      return;
    }
    if(master.paused===false) {
      if(Math.abs(current-target)>600) seekPeerVideo(v,target);
      if(v.paused) playQuietly(v).catch(()=>{});
    }
  }
  let rokuAnchor=null, lastRawRokuPosMs=null, lastRawRokuState=null, lastSampleId=null, joinedScheduledId=null, refDriftMs=null;
  function updateRokuAnchor(st) {
    if(!st) return;
    const nowServerMs=Date.now()+(clockOffsetMs||0);
    const ageMs=typeof st.last_update==='number' && st.last_update>0
      ? Math.max(0,Math.min(3000,nowServerMs-st.last_update*1000))
      : 0;
    const anchorAt=Date.now()-ageMs;
    if(st.sample && st.sample.id && st.sample.id!==lastSampleId && Number.isFinite(st.sample.position_ms)) {
      lastSampleId=st.sample.id;
      rokuAnchor={posMs:st.sample.position_ms, atLocalMs:anchorAt, posFresh:true, titleId:st.title_id};
      lastRawRokuPosMs=st.position_ms;
      lastRawRokuState=st.roku;
      return;
    }
    if(rokuAnchor && st.title_id && rokuAnchor.titleId && st.title_id!==rokuAnchor.titleId) {
      rokuAnchor=null;lastRawRokuPosMs=null;lastRawRokuState=null;
    }
    if(Number.isFinite(st.position_ms)) {
      const posChanged=st.position_ms!==lastRawRokuPosMs;
      const enteredPlay=lastRawRokuState!=='play' && st.roku==='play';
      const enteredPause=lastRawRokuState==='play' && st.roku==='pause';
      if(posChanged || enteredPlay || !rokuAnchor) {
        rokuAnchor={posMs:st.position_ms, atLocalMs:anchorAt, posFresh:true, titleId:st.title_id};
      } else if(enteredPause && rokuAnchor) {
        // Netflix freezes position_ms on pause; freeze the extrapolated timestamp in-place.
        const progressed=rokuAnchor.posMs+Math.max(0,anchorAt-rokuAnchor.atLocalMs);
        rokuAnchor={posMs:progressed, atLocalMs:anchorAt, posFresh:false, titleId:st.title_id};
      }
      lastRawRokuPosMs=st.position_ms;
    }
    lastRawRokuState=st.roku;
  }
  function followRokuReference(st,v) {
    if(!st || !v) return;
    ensureRefAudio(v);
    ensureClockOffset();
    updateRokuAnchor(st);
    const sched=st.scheduled;
    if(sched && sched.state==='pending' && sched.id && sched.id!==joinedScheduledId && Number.isFinite(sched.at_ms)) {
      joinedScheduledId=sched.id;
      const targetPos=Number.isFinite(sched.roku_position_ms) ? sched.roku_position_ms : (rokuAnchor ? rokuAnchor.posMs : null);
      pauseQuietly(v);
      if(targetPos!==null && Math.abs(v.currentTime*1000-targetPos)>150) {
        seekPeerVideo(v,targetPos,true);
      }
      const delay=Math.max(0,sched.at_ms-(Date.now()+(clockOffsetMs||0)));
      if(delay<=16000) {
        say('TV Reference: Starting with Roku in '+(delay/1000).toFixed(1)+'s');
        setTimeout(()=>{
          if(invalidated || !syncEnabled || joinedScheduledId!==sched.id || !video) return;
          if(targetPos!==null) rokuAnchor={posMs:targetPos, atLocalMs:Date.now(), posFresh:true, titleId:st.title_id};
          playQuietly(video).catch(err=>{
            if(/NotAllowed/i.test(String(err))) say('Click this reference tab once so Chrome allows background audio');
          });
        },delay);
        return;
      }
    }
    if(sched && sched.id===joinedScheduledId && sched.state==='pending') return;
    const loading=st.launch_status==='sending' || st.roku==='buffer' || st.roku==='close' || st.roku==='stop';
    if(loading || st.roku==='pause') {
      if(!v.paused) pauseQuietly(v);
      if(st.roku==='pause' && rokuAnchor?.posFresh && Math.abs(v.currentTime*1000-rokuAnchor.posMs)>400) {
        seekPeerVideo(v,rokuAnchor.posMs);
      }
      refDriftMs=0;
      return;
    }
    if(st.roku==='play') {
      const target=rokuAnchor ? rokuAnchor.posMs+Math.max(0,Date.now()-rokuAnchor.atLocalMs) : null;
      const current=Math.round(v.currentTime*1000);
      if(target!==null) {
        refDriftMs=current-Math.round(target);
        if(Math.abs(refDriftMs)>420) {
          seekPeerVideo(v,target,v.paused);
          refDriftMs=Math.round(v.currentTime*1000)-Math.round(target);
        }
      }
      if(v.paused) {
        playQuietly(v).catch(err=>{
          if(/NotAllowed/i.test(String(err))) say('Click this reference tab once so Chrome allows background audio');
        });
      }
    }
  }
  const sendLocalMirror=heartbeat=>new Promise(resolve=>{
    const tryDirectFetch=async()=>{
      if(typeof fetch!=='function') return resolve({error:'local mirror unavailable'});
      try {
        const endpoint=heartbeat ? 'http://127.0.0.1:8767/api/local-mirror/heartbeat' : 'http://127.0.0.1:8767/api/local-mirror';
        // Chrome holds this page-level request behind a "local network"
        // prompt until someone answers it; never let it stall the loop.
        const res=await fetch(endpoint,{
          signal:AbortSignal.timeout(1500),
          method:heartbeat?'POST':'GET',
          headers:heartbeat?{'Content-Type':'application/json'}:{'Accept':'application/json'},
          ...(heartbeat?{body:JSON.stringify(heartbeat)}:{}),
        });
        const body=await res.json();
        if(!res.ok) return resolve({error:body?.error||('HTTP '+res.status)});
        resolve({data:heartbeat && body.mirror ? body.mirror : body});
      } catch(err) {
        resolve({error:err?.message||'local fetch failed'});
      }
    };
    try {
      chrome.runtime.sendMessage({type:'local-mirror',...(heartbeat?{heartbeat}:{})},response=>{
        const err=chrome.runtime.lastError;
        if(err || !response || response.error || response?.data?.disabled) {
          tryDirectFetch();
          return;
        }
        resolve(response);
      });
    } catch(e) {
      tryDirectFetch();
    }
  });
  // -- Acoustic fine trim ---------------------------------------------------
  // Roku Sync.app measures, from the microphone, how far this silent tab plays
  // ahead of the TV. The echo canceller needs Chrome to lead, so the tab nudges
  // playbackRate until the lead is near the target. Each measurement covers the
  // last 3 s of audio, so after a correction the tab waits for a fresh window
  // before acting again instead of chasing stale numbers.
  const ACOUSTIC_TARGET_LEAD_MS=200, ACOUSTIC_DEADBAND_MS=35, ACOUSTIC_COARSE_LIMIT_MS=2500;
  const ACOUSTIC_MAX_RATE_DELTA=0.08, ACOUSTIC_SEEK_LIMIT_MS=1500, ACOUSTIC_SETTLE_MS=4000;
  let acousticSession=null, acousticSeqActed=0, acousticHoldUntil=0, rateTrim=null;
  function endRateTrim(v) {
    if(rateTrim?.timer) clearTimeout(rateTrim.timer);
    rateTrim=null;
    try {if(v && v.playbackRate!==1) v.playbackRate=1;} catch(e) {}
  }
  function trimToAcousticLead(v,ac) {
    if(!ac || !Number.isFinite(ac.leadMs) || !Number.isFinite(ac.seq)) return false;
    const now=performance.now();
    const target=Number.isFinite(ac.targetLeadMs) ? ac.targetLeadMs : ACOUSTIC_TARGET_LEAD_MS;
    // A restarted canceller numbers its measurements from 1 again.
    if(ac.session!==acousticSession) {acousticSession=ac.session;acousticSeqActed=0;}
    if(rateTrim || now<acousticHoldUntil || ac.seq<=acousticSeqActed) return true;
    acousticSeqActed=ac.seq;
    const error=ac.leadMs-target;
    if(Math.abs(error)<=ACOUSTIC_DEADBAND_MS) return true;
    if(Math.abs(error)>ACOUSTIC_SEEK_LIMIT_MS) {
      seekPeerVideo(v,v.currentTime*1000-error,true);
      acousticHoldUntil=now+ACOUSTIC_SETTLE_MS;
      return true;
    }
    // Ahead too far -> play slower; behind -> play faster.
    const delta=Math.min(ACOUSTIC_MAX_RATE_DELTA,Math.max(0.02,Math.abs(error)/3000));
    const rate=error>0 ? 1-delta : 1+delta;
    const durationMs=Math.abs(error)/delta;
    try {v.playbackRate=rate;} catch(e) {return true;}
    rateTrim={timer:setTimeout(()=>{
      endRateTrim(v);
      acousticHoldUntil=performance.now()+ACOUSTIC_SETTLE_MS;
    },durationMs)};
    return true;
  }
  function applyLocalMirror(lm,v,media) {
    if(!lm || typeof lm!=='object') return;
    if(lm.desiredApp && lm.desiredTitleId && maybeNavigateFollower(lm.desiredApp,lm.desiredTitleId,media)) return;
    if(!v) return;
    ensureRefAudio(v);
    if(!lm.active) return;
    if(lm.app && media?.app && lm.app!==media.app) {
      if(!v.paused) pauseQuietly(v);
      refDriftMs=null;
      return;
    }
    if(lm.paused || ['pause','buffer','close','stop'].includes(lm.roku)) {
      endRateTrim(v);
      if(!v.paused) pauseQuietly(v);
      if(lm.roku==='pause' && lm.posFresh && Number.isFinite(lm.positionMs) && Math.abs(v.currentTime*1000-lm.positionMs)>400) {
        seekPeerVideo(v,lm.positionMs);
      }
      refDriftMs=0;
      return;
    }
    if(!lm.paused && lm.roku==='play') {
      const elapsed=Number.isFinite(lm.local_ms) ? Math.max(0,Date.now()-lm.local_ms) : 0;
      const target=Number.isFinite(lm.positionMs) ? lm.positionMs+elapsed : null;
      const current=Math.round(v.currentTime*1000);
      const acousticLock=trimToAcousticLead(v,lm.acoustic);
      if(target!==null) {
        refDriftMs=current-Math.round(target);
        // Roku reports position in ~500 ms steps, so it only catches big jumps
        // (a seek on the TV) once the microphone has locked the fine offset.
        const coarseLimit=acousticLock ? ACOUSTIC_COARSE_LIMIT_MS : 420;
        if(Math.abs(refDriftMs)>coarseLimit) {
          endRateTrim(v);
          seekPeerVideo(v,target+(acousticLock?ACOUSTIC_TARGET_LEAD_MS:0),v.paused);
          refDriftMs=Math.round(v.currentTime*1000)-Math.round(target);
          acousticHoldUntil=performance.now()+ACOUSTIC_SETTLE_MS;
        }
      }
      if(v.paused) {
        playQuietly(v).catch(err=>{
          if(/NotAllowed/i.test(String(err))) say('Click this reference tab once so Chrome allows background audio');
        });
      }
    }
  }
  async function pollLocalReference() {
    if(!isRefTab || invalidated) return;
    try {
      const pathKey=location.pathname+(location.search||'');
      if(pathKey!==observedPath){observedPath=pathKey;cancelAttempt();pendingSeek=null;++seekGeneration;title=null;}
      install(document.querySelector('video'));
      const media=detectMedia();
      const hb=video && media?.titleId && Number.isFinite(video.currentTime) ? {
        client_id:clientId,
        app:media.app,
        title_id:media.titleId,
        position_ms:Math.round(video.currentTime*1000),
        paused:Boolean(video.paused),
        ready_state:video.readyState||0,
      } : null;
      const res=await sendLocalMirror(hb);
      if(invalidated) return;
      if(res?.data && typeof res.data==='object' && !res.data.disabled) {
        localAppConnected=true;
        localMirrorState=res.data;
        badge.style.display='';
        applyLocalMirror(res.data,video,media);
        if(performance.now()>=noticeUntil) {
          const lm=res.data;
          const label=lm.appName || lm.app || 'TV';
          const status=!lm.active
            ? 'Waiting for Roku TV playback…'
            : (lm.app && media?.app && lm.app!==media.app)
              ? ('Roku is playing '+label+' (paused here)')
              : lm.paused
                ? ('Paused with '+label)
                : lm.acoustic && Number.isFinite(lm.acoustic.leadMs)
                  ? ('Echo lock with '+label+' · '+Math.round(lm.acoustic.leadMs)+' ms ahead (target '+Math.round(lm.acoustic.targetLeadMs||ACOUSTIC_TARGET_LEAD_MS)+')'+(rateTrim?' · trimming':''))
                  : ('Synced with '+label+(refDriftMs!==null ? ' ('+(refDriftMs>=0?'+':'')+Math.round(refDriftMs)+' ms)' : '')+' · waiting for mic lock');
          badge.textContent='TV Reference (Silent · Roku Sync App): '+status;
        }
      } else {
        localAppConnected=false;
        localMirrorState=null;
        if(!syncEnabled && performance.now()>=noticeUntil) {
          badge.style.display='';
          badge.textContent='TV Reference: open the roku-sync popup and click "Connect Roku Sync app" (and make sure Roku Sync.app is running)';
        }
      }
    } catch(e) {
      localAppConnected=false;
    } finally {
      if(!invalidated) setTimeout(pollLocalReference,500);
    }
  }

  function cancelAttempt() {
    const old=attempt;attempt=null;
    old?.abortAlignment?.();
    if(old?.id) send({type:'cancel',id:old.id});
    return old;
  }
  async function forward(action,v) {
    const media=detectMedia();
    const result=await send({type:'event',action,position:Math.round(v.currentTime*1000),client_id:clientId,...(media?{app:media.app}:{})});
    if(!invalidated) {
      if(result.error) say('Sync failed · '+result.error);
      else if(peerMode()) say(action==='pause'?'Paused · master':'Playing · master');
      else say(action==='pause' ? 'Paused' : 'Connected · playback requested');
    }
  }
  async function fallback(current,reason) {
    if(attempt!==current)return;
    cancelAttempt();say('Sync failed · '+reason+' Resuming normally.');
    if(current.video!==video || !video.paused || invalidated)return;
    try {await playQuietly(video);await forward('play',video);}
    catch(e){say('Chrome could not resume: '+e.message);}
  }
  function flushSeek() {
    const seek=pendingSeek;pendingSeek=null;
    if(!seek)return seekInFlight || Promise.resolve();
    const generation=seekGeneration;
    const previous=seekInFlight || Promise.resolve();
    const task=previous.then(async()=>{
      if(!syncEnabled || invalidated || generation!==seekGeneration) return;
      const inPeerMode=peerMode();
      const wasPlaying=video && !video.paused;
      if(video && wasPlaying && !inPeerMode) pauseQuietly(video);
      say(inPeerMode ? 'Syncing seek to ' + Math.round(seek.position/1000) + 's…' : 'Seeking TV to ' + Math.round(seek.position/1000) + 's…');
      const media=detectMedia();
      const result=await send({type:'event',action:'seek',position:seek.position,client_id:clientId,...(media?{app:media.app}:{})});
      if(!invalidated && syncEnabled && generation===seekGeneration) {
        if(result.error) {
          say('Sync failed · '+result.error);
          if(video && wasPlaying && video.paused) playQuietly(video).catch(()=>{});
        } else if(result.data?.peer_mode || inPeerMode) {
          say('Master sought to '+(seek.position/1000).toFixed(1)+'s');
        } else if(wasPlaying && video && video.paused) {
          await startTogether(video, result.data);
        } else if(typeof result.data?.after_ms==='number') {
          say('TV sought to '+(result.data.after_ms/1000).toFixed(1)+'s · press Play to sync');
        } else {
          say(result.data?.warning || 'Connected · seek requested');
        }
      }
      return result;
    });
    seekInFlight=task;task.finally(()=>{if(seekInFlight===task)seekInFlight=null;});return task;
  }
  let bridgeRequest=0;
  function alignChrome(current,target) {
    const v=current.video;
    const media=detectMedia();
    if(media && media.app && media.app!=='netflix') {
      // YouTube, Plex and other HTML5 players expose a plain seekable element.
      return new Promise((resolve,reject)=>{
        let done=false,ack=false;
        const onReady=event=>{if(event.type==='seeked')ack=true;check();};
        const finish=error=>{
          if(done)return;done=true;current.abortAlignment=null;
          ['seeked','loadeddata','canplay'].forEach(name=>v.removeEventListener?.(name,onReady));
          if(!ack)consume(v,'seek');
          error?reject(Error(error)):resolve();
        };
        const check=()=>{
          if(Math.abs(v.currentTime*1000-target)<=250)return finish();
        };
        current.abortAlignment=()=>finish('Alignment cancelled.');
        ['seeked','loadeddata','canplay'].forEach(name=>v.addEventListener?.(name,onReady));
        suppress(v,'seek');
        setTimeout(()=>finish('Player did not finish aligning to the sync position.'),5000);
        try {v.currentTime=target/1000;} catch(e) {return finish(e.message);}
        check();
      });
    }
    return new Promise((resolve,reject)=>{
      if(!document.addEventListener || !document.dispatchEvent) return reject(Error('Netflix seek bridge unavailable.'));
      const id=String(++bridgeRequest)+'-'+Date.now();
      let done=false,ack=false,sawSeek=false;
      const finish=error=>{
        if(done)return;done=true;current.abortAlignment=null;
        document.removeEventListener('roku-sync-seek-result',onResult);
        ['seeked','loadeddata','canplay'].forEach(name=>v.removeEventListener(name,onReady));
        if(!sawSeek)consume(v,'seek');
        error?reject(Error(error)):resolve();
      };
      const check=()=>{
        if(!ack || !sawSeek)return;
        if(Math.abs(v.currentTime*1000-target)>200)return finish('Chrome did not reach the TV position.');
        if(v.readyState>=2)finish();
      };
      const onReady=event=>{if(event.type==='seeked')sawSeek=true;check();};
      const onResult=event=>{if(event.detail?.id!==id)return;if(event.detail.error)return finish(event.detail.error);ack=true;check();};
      current.abortAlignment=()=>finish('Alignment cancelled.');
      document.addEventListener('roku-sync-seek-result',onResult);
      ['seeked','loadeddata','canplay'].forEach(name=>v.addEventListener(name,onReady));
      suppress(v,'seek');
      setTimeout(()=>finish('Chrome did not finish aligning to TV.'),5000);
      try {document.dispatchEvent(new CustomEvent('roku-sync-seek',{detail:{id,position:target}}));}
      catch(e){finish(e.message);}
    });
  }
  async function waitForRokuReady(current,maxWaitMs=60000) {
    // BEE-230: a title launch can leave Roku buffering for a while. Wait up to
    // a minute for the player to report a usable state before giving up.
    const started=current.waitStarted || Date.now();
    let paused=false, failures=0;
    while(attempt===current && !invalidated && syncEnabled) {
      const remaining=maxWaitMs-(Date.now()-started);
      if(remaining<=0) return false;
      const rokuState=state?.roku;
      if(rokuState==='pause') return true;
      if(rokuState==='play' && !paused) {
        // Playing already: pause it so the position sample stays honest.
        paused=true;
        send({type:'event',action:'pause',position:Math.round((current.video?current.video.currentTime:0)*1000),client_id:clientId});
      }
      say('Waiting for Roku to finish loading… ('+Math.ceil(remaining/1000)+'s left)');
      await new Promise(resolve=>setTimeout(resolve,750));
      if(attempt!==current) return false;
      const result=await send({type:'read'});
      if(invalidated) return false;
      if(result.error) {if(++failures>3) return false;continue;}
      failures=0;
      state=result.data;
    }
    return false;
  }
  async function startTogether(v, preSample=null) {
    const current={video:v,path:location.pathname,id:null};attempt=current;
    pauseQuietly(v);
    const valid=()=>attempt===current && !invalidated && v===video && v.paused && current.path===location.pathname;
    setTimeout(()=>{if(!current.id)fallback(current,'Sync took too long.');},10000);
    try {
      let position=Math.round(v.currentTime*1000);
      let sampleId=preSample?.sample_id || null;
      let rokuPosition=typeof preSample?.after_ms==='number' ? preSample.after_ms : null;
      if(!sampleId || rokuPosition===null) {
        const sample=await send({type:'sample'});
        if(!valid())return;
        if(sample.error || !sample.data.sample_id) throw Error(sample.error || 'Roku position unavailable.');
        const match=/^(\d+)\s*ms$/.exec(sample.data.after || '');
        if(!match)throw Error('Roku sampled position unavailable.');
        sampleId=sample.data.sample_id;
        rokuPosition=Number(match[1]);
      }
      if(Math.abs(position-rokuPosition)>150) {
        say('Aligning Chrome to TV');
        await alignChrome(current,rokuPosition);
        if(!valid())return;
        position=Math.round(v.currentTime*1000);
      }
      let best=null;
      for(let i=0;i<5;i++) {
        const start=performance.now(),wall=Date.now(),result=await send({type:'clock'});
        if(!valid())return;
        if(result.error)throw Error(result.error);
        const rtt=performance.now()-start, received=result.data.received_ms ?? result.data.server_ms;
        const offset=(received+result.data.server_ms)/2-(wall+rtt/2);
        const networkRtt=Math.max(0,rtt-Math.max(0,result.data.server_ms-received));
        const rokuMs=result.data.roku_toggle_ms ?? result.data.roku_poll_ms;
        if(!best || networkRtt<best.networkRtt)best={rtt,networkRtt,offset,rokuMs};
      }
      if(Math.abs(v.currentTime*1000-position)>300)throw Error('Chrome position changed.');
      const scheduled=await send({type:'schedule',sample_id:sampleId,position_ms:Math.round(v.currentTime*1000),lead_ms:Math.min(15000,Math.max(3000,Math.ceil(2000+best.rtt*4)))});
      if(scheduled.error)throw Error(scheduled.error);
      const {id,start_ms,roku_one_way_ms}=scheduled.data;
      if(!valid()) {await send({type:'cancel',id});return;}
      current.id=id;
      const delay=start_ms-(Date.now()+best.offset);
      if(delay<500 || delay>15500)throw Error('Start time was invalid or arrived too late.');
      const rttSummary=`Chrome RTT ${Math.round(best.networkRtt)}ms · Roku ${roku_one_way_ms ?? best.rokuMs ?? '?'}ms`;
      say('Waiting for Roku · starting in '+(delay/1000).toFixed(1)+'s ('+rttSummary+')');
      setTimeout(async()=>{
        if(!valid())return;
        attempt=null;
        try {await playQuietly(v);say('Connected · synced ('+rttSummary+')');}
        catch(e){await send({type:'cancel',id});say('Chrome could not start: '+e.message+'. Check Roku.');}
      },delay);
    } catch(e) {await fallback(current,e.message);}
  }
  function install(next) {
    if(next===video)return;
    if(video)['play','pause','seeked'].forEach(name=>video.removeEventListener(name,onEvent));
    cancelAttempt();video=next;
    if(video)['play','pause','seeked'].forEach(name=>video.addEventListener(name,onEvent));
  }
  function isRokuLoading() {
    if(!state) return false;
    if(state.launch_status==='sending') return true;
    if(state.roku!=='buffer' && state.roku!=='close') return false;
    // Only treat buffer/close as "still loading" right after a title launch.
    return typeof state.launch_started==='number' && Date.now()/1000-state.launch_started<120;
  }
  function onEvent(event) {
    const v=video;if(invalidated || !v || !syncEnabled)return;
    const action=event.type==='seeked'?'seek':event.type;
    if(consume(v,action))return;
    if(isRefTab)return;
    const media=detectMedia();
    if(!media)return;
    const wasAttempting=!!attempt;
    if(attempt)cancelAttempt();
    if(peerMode()) {
      // Master publishes; slave stays quiet until it claims the baton.
      if(!isMasterClient()) return;
      if(action==='seek') {
        pendingSeek={position:Math.round(v.currentTime*1000)};const generation=++seekGeneration;
        setTimeout(()=>{if(generation===seekGeneration)flushSeek();},300);return;
      }
      forward(action,v);return;
    }
    if(action==='seek') {
      pendingSeek={position:Math.round(v.currentTime*1000)};const generation=++seekGeneration;
      setTimeout(()=>{if(generation===seekGeneration)flushSeek();},300);return;
    }
    if(wasAttempting && action==='play'){forward('play',v);return;}
    if(action==='play' && (pendingSeek || seekInFlight)) {
      ++seekGeneration;pauseQuietly(v);
      flushSeek().then(()=>{if(v===video && !invalidated)startTogether(v);});return;
    }
    const fresh=state && Date.now()/1000-(state.last_update||0)<2;
    const currentTitle=media.titleId;
    if(action==='play' && fresh && isRokuLoading() && state.roku!=='pause') {
      // BEE-230: Roku may still be buffering a fresh launch; wait it out.
      const current={video:v,path:location.pathname,id:null,waitStarted:Date.now()};
      attempt=current;
      pauseQuietly(v);
      waitForRokuReady(current).then(ready=>{
        if(attempt!==current || invalidated) return;
        if(!ready) {
          fallback(current,'Roku did not finish loading.');
          return;
        }
        if(v!==video || !v.paused) {attempt=null;return;}
        startTogether(v);
      });
      return;
    }
    if(action==='play' && fresh && state.roku==='pause' && title===currentTitle && state.title_id===title && state.launch_status==='sent') {
      startTogether(v);return;
    }
    forward(action,v);
  }
  function peerDrift(watchTitle,v) {
    const clients=state?.clients;
    if(!clients || typeof clients!=='object') return null;
    const peers=Object.entries(clients).filter(([id,c])=>id!==clientId && c && c.title_id===watchTitle && Number.isFinite(c.position_ms) && c.received_at_ms && Date.now()-c.received_at_ms<6000);
    if(!peers.length) return null;
    const lead=peers.reduce((worst,[,c])=>Math.abs(c.position_ms-Math.round(v.currentTime*1000))>Math.abs(worst)?c.position_ms-Math.round(v.currentTime*1000):worst,0);
    return Math.abs(lead)>=1000 ? Math.round(lead) : null;
  }
  let observedPath=location.pathname+(location.search||'');
  async function poll() {
    if(invalidated || !syncEnabled) return;
    pollStarted=true;
    const loop=pollLoop;
    try {
      const pathKey=location.pathname+(location.search||'');
      if(pathKey!==observedPath){observedPath=pathKey;cancelAttempt();pendingSeek=null;++seekGeneration;title=null;}
      install(document.querySelector('video'));
      const result=await send({type:'read'});
      if(invalidated || !syncEnabled || loop!==pollLoop)return;
      if(result.error){say('Waiting for Roku · '+result.error);return;}
      state=result.data;
      const media=detectMedia();
      const watchTitle=media?media.titleId:null;
      const peer=peerMode();
      const master=isMasterClient();
      if(video && watchTitle && !telemetryInFlight && Number.isFinite(video.currentTime)) {
        telemetryInFlight=true;
        send({type:'telemetry',data:{title_id:watchTitle,position_ms:Math.round(video.currentTime*1000),paused:video.paused,ready_state:video.readyState,client_ms:Date.now(),client_id:clientId,...(media?{app:media.app}:{}),...(!isRefTab && syncMode==='peer'?{sync_mode:'peer'}:{})}}).finally(()=>{telemetryInFlight=false;});
      }
      driftMs=watchTitle && video && Number.isFinite(video.currentTime) ? peerDrift(watchTitle,video) : null;
      if(isRefTab && localAppConnected) {
        seq=state.seq;
      } else if(peer) {
        if(isRefTab) ensureClockOffset();
        if(isRefTab && state.master_client_id===clientId && state.clients) {
          const human=Object.keys(state.clients).find(id=>id!==clientId && !id.startsWith('ref-'));
          if(human) send({type:'baton',data:{action:'pass',client_id:clientId,target_client_id:human,sync_mode:'peer'}});
        }
        if(!master) {
          const mState=state.master_state;
          const mFresh=mState && Number.isFinite(mState.received_at_ms) && Math.abs(Date.now()+(clockOffsetMs||0)-mState.received_at_ms)<60000;
          const targetApp=(mFresh && mState.app) || appFromState(state) || media?.app;
          const targetTitle=(mFresh && mState.title_id) || (state.event?.action==='title' ? state.title_id : null);
          if(targetTitle && maybeNavigateFollower(targetApp,targetTitle,media)) return;
        }
        if(seq===null) seq=state.seq;
        else if(state.seq!==seq) {
          seq=state.seq;
          const event=state.event;
          if(!master && event?.source==='master' && video) {
            if(event.action==='title' && state.title_id) {
              const navApp=state.master_state?.app || appFromState(state) || media?.app;
              if(maybeNavigateFollower(navApp,state.title_id,media)) return;
            }
            // React to the master's publish immediately rather than on the next poll.
            const nextPaused = event.action==='pause' ? true : event.action==='play' ? false : state.master_state?.paused;
            followMaster({...state.master_state, ...(typeof event.position==='number'?{position_ms:event.position,client_ms:Date.now(),received_at_ms:Date.now()+(clockOffsetMs||0)}:{}), paused:nextPaused},video);
          }
        }
        if(!master && video && state.master_state) followMaster(state.master_state,video);
      } else if(isRefTab) {
        const targetApp=appFromState(state) || media?.app;
        if(state.title_id && state.launch_status && maybeNavigateFollower(targetApp,state.title_id,media)) return;
        seq=state.seq;
        if(video) followRokuReference(state,video);
      } else {
        if(attempt?.id && state.scheduled?.id===attempt.id && /^(cancelled|aborted|error)/.test(state.scheduled.state||'')) await fallback(attempt,'Roku start failed: '+state.scheduled.state+'.');
        if(seq===null)seq=state.seq;
        else if(state.seq!==seq){
          seq=state.seq;
          const event=state.event;
          if(event?.source==='roku' && video && detectMedia()) {
            if(event.action==='pause') {
              cancelAttempt();pauseQuietly(video);say('Paused · Roku');
            } else if(event.action==='play' && video.paused && !attempt) {
              playQuietly(video).then(()=>say('Playing · Roku')).catch(()=>{});
            }
          }
        }
      }
      const requested=media?media.titleId:null;
      if(!requested)title=null;
      if(!isRefTab && requested && (requested!==title || state.title_id===null) && !titleSending && (!peer || master)){
        titleSending=true;
        try {
          const sent=await send({type:'event',action:'title',title_id:requested,client_id:clientId,...(media?{app:media.app}:{})});
          if(invalidated)return;
          if(sent.error)say('Sync failed · '+sent.error);
          else if((detectMedia()||{}).titleId===requested)title=requested;
        } finally{titleSending=false;}
      }
      if(performance.now()>=noticeUntil){
        if(isRefTab && localAppConnected) {
          /* badge already updated by pollLocalReference */
        } else if(isRefTab) {
          if(peer) {
            const playing=state?.master_state ? !state.master_state.paused : false;
            badge.textContent='TV Reference (Silent): Following master ('+(playing?'Playing':'Paused')+')';
          } else {
            const stText=state.launch_status==='sending' || state.roku==='buffer' || state.roku==='close'
              ? 'Waiting for Roku TV to start…'
              : state.roku==='pause'
                ? 'Paused with Roku'
                : state.roku==='play'
                  ? 'Synced with Roku'+(refDriftMs!==null ? ' ('+(refDriftMs>=0?'+':'')+Math.round(refDriftMs)+' ms)' : '')
                  : 'Waiting for Roku TV';
            badge.textContent='TV Reference (Silent): '+stText;
          }
        } else if(peer) {
          const playing=state?.master_state ? !state.master_state.paused : (video? !video.paused : false);
          badge.textContent=master
            ? 'Peer sync (Master): '+(playing?'Playing':'Paused')+' · click to pass baton'
            : 'Peer sync (Slave): Following master · click to take baton';
        } else {
          const age=Date.now()/1000-(state.last_update||0);
          const appLabel=state.app_name && state.app_name!=='Netflix' ? state.app_name+' · ' : '';
          const status=state.error || age>3 || state.roku==='unavailable'?'Waiting for Roku · check relay and device':state.roku==='pause'?'Paused · Roku':state.roku==='play'?'Connected · Roku playing':'Waiting for Roku';
          const drift=driftMs===null?'':(driftMs>0?' · '+Math.round(driftMs/1000)+'s behind peer':' · '+Math.round(-driftMs/1000)+'s ahead of peer');
          badge.textContent='Roku sync: '+appLabel+status+drift+(drift?' · click to re-sync':'');
        }
      }
    }catch(e){say(e.message);}
    finally{
      if(!invalidated && syncEnabled && loop===pollLoop) setTimeout(()=>{if(loop===pollLoop)poll();},750);
      else pollStarted=false;
    }
  }
  chrome.runtime?.onMessage?.addListener?.((message, sender, respond)=>{
    if(!syncEnabled) {respond?.({ok:false,disabled:true});return;}
    if(message?.type==='baton-toggle') {batonToggle();respond?.({ok:true});return;}
    if(message?.type==='sync-mode') {
      setSyncMode(message.sync_mode);
      send({type:'baton',data:{action:'mode',client_id:clientId,sync_mode:syncMode}});
      respond?.({ok:true});return;
    }
  });
  if(isRefTab) {
    badge.style.display='';
    pollLocalReference();
  }
  if(chrome.storage?.local?.get) chrome.storage.local.get(['enabled','syncMode','privacyConsent','server','token'],res=>{
    if(invalidated) return;
    for(const key of Object.keys(res || {})) if(!changedSettings.has(key)) settings[key]=res[key];
    applySettings();
  });
})();
