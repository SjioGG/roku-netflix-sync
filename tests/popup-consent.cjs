const fs=require('fs'),vm=require('vm'),assert=require('assert');
function setup(initial={}, inTab=true, session={}) {
  const ids=['server','token','status','rokuLeadMs','enabled','syncMode','baton','consent','save','forget'];
  const elements=Object.fromEntries(ids.map(id=>[id,{value:'',checked:false,textContent:''}]));
  const storage={...initial},writes=[],permissions=[],drafts={...session},opened=[];
  let granted=true;
  const ctx={document:{querySelector:selector=>elements[selector.slice(1)]},URL,chrome:{
    storage:{local:{get:async()=>({...storage}),set:async value=>{writes.push(value);Object.assign(storage,value)}},session:{get:async()=>({...drafts}),set:async value=>Object.assign(drafts,value),remove:async key=>delete drafts[key]}},
    permissions:{request:async request=>{permissions.push(request);return granted}},
    runtime:{getURL:path=>`chrome-extension://fixture/${path}`},
    tabs:{getCurrent:async()=>inTab?{id:1}:undefined,create:async value=>opened.push(value),query:async()=>[],sendMessage:async()=>({ok:true})}
  }};
  vm.runInNewContext(fs.readFileSync('extension/popup.js','utf8'),ctx);
  return {elements,storage,writes,permissions,drafts,opened,deny:()=>{granted=false}};
}
(async()=>{
  const popup=setup({},false);await new Promise(setImmediate);
  popup.elements.server.value='https://relay.example';popup.elements.token.value='fixture';
  popup.elements.rokuLeadMs.value='0';popup.elements.enabled.checked=true;popup.elements.consent.checked=true;
  await popup.elements.save.onclick();
  assert.equal(popup.permissions.length,0,'a popup must not open the native permission dialog that destroys its Save continuation');
  assert.equal(popup.opened.length,1,'first-time permission setup continues in a full tab');
  assert.equal(popup.writes.length,0,'opening setup must not activate sync');
  assert.equal(popup.drafts.relaySetupDraft.token,'fixture','draft survives popup closure without entering page URLs');

  const tab=setup({},true,popup.drafts);await new Promise(setImmediate);
  assert.equal(tab.elements.token.value,'fixture','the persistent tab restores the popup draft');
  assert.equal(tab.elements.enabled.checked,true);
  assert.equal(tab.storage.enabled,undefined,'reading a draft never enables sync');
  assert.equal(tab.drafts.relaySetupDraft,undefined,'consume the temporary draft once');
  assert.equal(tab.permissions.length,0,'opening setup cannot request host permission without a click');
  await tab.elements.save.onclick();
  assert.equal(tab.storage.enabled,true,'the persistent tab commits after permission approval');
  assert.equal(tab.opened[0],undefined,'saving the persistent tab must not open more tabs');

  const h=setup({server:'https://old.example',token:'saved',enabled:true});
  await new Promise(setImmediate);
  assert.equal(h.elements.enabled.checked,false,'an existing install must explicitly consent');
  assert.equal(h.elements.consent.checked,false);
  assert.equal(h.permissions.length,0,'opening the popup never requests network access');
  h.elements.server.value='https://relay.example:9443';h.elements.token.value='fixture';
  h.elements.rokuLeadMs.value='0';h.elements.enabled.checked=true;
  await h.elements.save.onclick();
  assert.equal(h.writes.length,0,'Save without consent cannot change settings');
  assert.equal(h.permissions.length,0);
  h.elements.consent.checked=true;
  h.deny();await h.elements.save.onclick();
  assert.equal(h.writes.length,0,'denied host access cannot persist a new relay or consent');
  assert.equal(h.permissions[0].origins[0],'https://relay.example/*','request only the chosen hostname');

  const allowed=setup();await new Promise(setImmediate);
  allowed.elements.server.value='https://relay.example:9443';allowed.elements.token.value='fixture';
  allowed.elements.rokuLeadMs.value='25';allowed.elements.enabled.checked=true;allowed.elements.consent.checked=true;
  await allowed.elements.save.onclick();
  assert.equal(allowed.storage.server,'https://relay.example:9443');
  assert.equal(allowed.storage.privacyConsent.server,allowed.storage.server);
  assert.equal(allowed.storage.enabled,true);
  allowed.elements.server.value='https://other.example';allowed.elements.server.oninput();
  assert.equal(allowed.elements.consent.checked,false,'new relay needs new consent');
  await allowed.elements.consent.onchange();
  assert.equal(allowed.storage.enabled,false);
  assert.equal(allowed.storage.privacyConsent,null,'withdrawal immediately removes consent');
  await allowed.elements.forget.onclick();
  assert.equal(allowed.storage.token,null,'forget clears the stored credential');
  assert.equal(allowed.storage.server,null);

  const invalid=setup();await new Promise(setImmediate);
  invalid.elements.token.value='fixture';invalid.elements.consent.checked=true;
  for(const url of ['http://remote.example','https://user:secret@relay.example','https://relay.example/path','https://relay.example?token=secret']) {
    invalid.elements.server.value=url;
    await invalid.elements.save.onclick();
    assert.equal(invalid.permissions.length,0,'invalid relay must be rejected before a permission prompt');
  }
  console.log('Popup requires relay-specific consent, handles permission denial, and supports withdrawal and forgetting');
})().catch(error=>{console.error(error);process.exitCode=1});
