// Content-script fixture for a user who explicitly enabled sync for this relay.
module.exports=function(overrides={}) {
  const value={enabled:true,server:'http://127.0.0.1:8766',privacyConsent:{version:1,server:'http://127.0.0.1:8766'},...overrides};
  return {local:{get:(keys,callback)=>{callback?.(value);return Promise.resolve(value)}}};
};
