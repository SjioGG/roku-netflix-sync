const assert=require('assert'),harness=require('./native-harness.cjs');
const settle=()=>new Promise(setImmediate);
function storageFixture(value) {
  let change,initial;
  return {
    local:{get:(keys,cb)=>{initial=()=>cb({...value})}},
    onChanged:{addListener:fn=>{change=fn}},
    start:()=>initial(),
    update(changes){
      const event={};
      for(const [key,newValue] of Object.entries(changes)) {event[key]={oldValue:value[key],newValue};value[key]=newValue;}
      change(event,'local');
    }
  };
}
(async()=>{
  const storage=storageFixture({enabled:true,server:'https://old.example',token:'fixture'});
  const h=harness({storage});
  assert.equal(h.elements[0].style.display,'none','badge stays hidden before consent settings load');
  storage.start();await settle();
  assert.equal(h.messages.length,0,'existing enabled setting alone cannot start sync');
  assert.equal(Object.keys(h.handlers).length,0,'unconsented page has no playback handlers');
  storage.update({privacyConsent:{version:1,server:'https://old.example'}});await settle();
  assert(h.messages.some(m=>m.type==='telemetry'),'explicit consent activates sync');
  storage.update({privacyConsent:null});await settle();
  h.messages.length=0;
  await h.video.play();
  h.timers.splice(0).forEach(t=>t.f());await settle();
  assert.equal(h.messages.length,0,'withdrawal stops commands and polling');
  assert.equal(h.video.paused,false,'native playback stays available');

  for(const roomChange of [{server:'https://new.example',privacyConsent:{version:1,server:'https://new.example'}},{token:'new-fixture'}]) {
    const roomStorage=storageFixture({enabled:true,server:'https://old.example',token:'fixture',privacyConsent:{version:1,server:'https://old.example'}});
    const room=harness({storage:roomStorage});roomStorage.start();await settle();
    roomStorage.update(roomChange);await settle();
    assert.match(room.elements[0].textContent,/Reload this tab/,'room changes need a fresh tab state');
    room.messages.length=0;
    room.timers.splice(0).forEach(t=>t.f());await settle();
    assert.equal(room.messages.length,0,'old room cannot publish into the new room before reload');
    assert.equal(Object.keys(room.handlers).length,0,'old playback handlers are detached');
  }
  console.log('Content controls stay off until consent, stop on withdrawal and require fresh state after changing rooms');
})().catch(error=>{console.error(error);process.exitCode=1});
