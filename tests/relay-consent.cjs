const fs=require('fs'),vm=require('vm'),assert=require('assert');
const server='https://relay.example';
const consent={version:1,server};
let listener,requests=[],allowed=true,permissionCheck=null;
let storage={server,token:'fixture',enabled:true};
const ctx={chrome:{
  runtime:{onMessage:{addListener:f=>listener=f}},
  storage:{local:{get:async()=>storage}},
  permissions:{contains:async()=>permissionCheck ? permissionCheck() : allowed}
},URL,AbortSignal,performance,fetch:async(url,options)=>{
  requests.push({url,options});return {ok:true,json:async()=>({ok:true})};
}};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),ctx);
const send=()=>new Promise(resolve=>listener({type:'read'},{tab:{},url:'https://www.netflix.com/watch/123'},resolve));
(async()=>{
  assert.equal((await send()).data.disabled,true,'existing installs cannot send before consent');
  assert.equal(requests.length,0);
  storage.privacyConsent=consent;
  assert.equal((await send()).data.ok,true,'consented relay can connect');
  assert.equal(requests[0].url,server+'/sync');
  assert.equal(requests[0].options.redirect,'error','redirects must not move room data to another host');
  requests=[];
  storage.server='https://another.example';
  assert.equal((await send()).data.disabled,true,'consent applies only to the chosen relay');
  assert.equal(requests.length,0);
  storage.server=server;allowed=false;
  assert.match((await send()).error,/access/i,'revoked host access must be checked before sending');
  assert.equal(requests.length,0);
  allowed=true;storage.enabled=false;
  assert.equal((await send()).data.disabled,true);
  assert.equal(requests.length,0);
  storage.enabled=true;
  let finishPermissionCheck;
  permissionCheck=()=>new Promise(resolve=>{finishPermissionCheck=resolve});
  const pending=send();
  await new Promise(setImmediate);
  storage={...storage,enabled:false,privacyConsent:null};
  finishPermissionCheck(true);
  assert.equal((await pending).data.disabled,true,'withdrawal during the permission check cannot start a request');
  assert.equal(requests.length,0);
  console.log('Relay traffic requires explicit consent, the consented relay, enabled sync and host access');
})().catch(error=>{console.error(error);process.exitCode=1});
