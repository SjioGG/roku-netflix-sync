const fs=require('fs'),vm=require('vm'),assert=require('assert');
// BEE-227: a disabled extension must not reach the relay at all.
let listener,fetched=false,storage={server:'http://127.0.0.1:8766',token:'fixture',enabled:false,privacyConsent:{version:1,server:'http://127.0.0.1:8766'}};
const context={chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{local:{get:async()=>storage}}},URL,AbortSignal,performance,fetch:async()=>{fetched=true;return {ok:true,json:async()=>({})}}};
context.chrome.permissions={contains:async()=>true};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),context);
new Promise(resolve=>listener({type:'read'},{tab:{},url:'https://www.netflix.com/watch/123'},resolve)).then(async result=>{
  assert.equal(JSON.stringify(result),JSON.stringify({data:{disabled:true}}),'disabled service worker replies without relay traffic');
  assert.equal(fetched,false,'no relay fetch while disabled');
  storage={server:'http://127.0.0.1:8766',token:'fixture',enabled:true,privacyConsent:{version:1,server:'http://127.0.0.1:8766'}};
  const enabled=await new Promise(resolve=>listener({type:'read'},{tab:{},url:'https://www.netflix.com/watch/123'},resolve));
  assert.equal(enabled.data.disabled,undefined,'re-enabling restores relay traffic');
  assert.equal(fetched,true,'relay fetch resumes after re-enabling');
  console.log('Disabled service worker short-circuits before any relay fetch');
}).catch(error=>{console.error(error);process.exit(1)});
