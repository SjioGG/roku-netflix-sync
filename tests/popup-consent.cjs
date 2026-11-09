const fs=require('fs'),vm=require('vm'),assert=require('assert');
function setup(initial={}) {
  const ids=['server','token','status','rokuLeadMs','enabled','syncMode','baton','consent','save','forget'];
  const elements=Object.fromEntries(ids.map(id=>[id,{value:'',checked:false,textContent:''}]));
  const storage={...initial},writes=[],permissions=[];
  let granted=true;
  const ctx={document:{querySelector:selector=>elements[selector.slice(1)]},URL,chrome:{
    storage:{local:{get:async()=>({...storage}),set:async value=>{writes.push(value);Object.assign(storage,value)}}},
    permissions:{request:async request=>{permissions.push(request);return granted}},
    tabs:{query:async()=>[],sendMessage:async()=>({ok:true})}
  }};
  vm.runInNewContext(fs.readFileSync('extension/popup.js','utf8'),ctx);
  return {elements,storage,writes,permissions,deny:()=>{granted=false}};
}
(async()=>{
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
