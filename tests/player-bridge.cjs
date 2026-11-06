const fs=require('fs'),vm=require('vm'),assert=require('assert');
const listeners={}, results=[], seeks=[];
const document={addEventListener:(type,fn)=>listeners[type]=fn,dispatchEvent:event=>results.push(event.detail)};
const player={seek:position=>seeks.push(position)};
const window={netflix:{appContext:{state:{playerApp:{getAPI:()=>({videoPlayer:{getAllPlayerSessionIds:()=>['session'],getVideoPlayerBySessionId:()=>player}})}}}}};
class CustomEvent {constructor(type,options){this.type=type;this.detail=options.detail}}
vm.runInNewContext(fs.readFileSync('extension/player-bridge.js','utf8'),{window,document,CustomEvent,Number,Math});
listeners['roku-sync-seek']({detail:{id:'a',position:12345.6}});
assert.deepEqual(seeks,[12346]);assert.equal(results[0].error,null);
listeners['roku-sync-seek']({detail:{id:'b',position:-1}});assert.equal(seeks.length,1);
delete window.netflix;
listeners['roku-sync-seek']({detail:{id:'c',position:100}});assert.match(results[1].error,/not available/);
console.log('Netflix bridge seeks in milliseconds and reports unavailable player');
