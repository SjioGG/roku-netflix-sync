const STREAMING_HOST = /^https?:\/\/([^/]+\.)?(netflix\.com|youtube\.com|plex\.tv|plex\.direct|primevideo\.com|disneyplus\.com|max\.com|apple\.com|hulu\.com|twitch\.tv)\//i;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || !STREAMING_HOST.test(sender.url || '')) return;
  (async () => {
    const {server, token, rokuLeadMs, enabled, syncMode, privacyConsent} = await chrome.storage.local.get(['server','token','rokuLeadMs','enabled','syncMode','privacyConsent']);
    if (enabled !== true || privacyConsent?.version !== 1 || privacyConsent.server !== server) return {disabled: true};
    if (!server || !token) throw Error('Configure the relay URL and token in the extension.');
    const url = new URL(server);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw Error('Use HTTPS, or localhost for testing.');
    if (url.username || url.password || url.origin !== server) throw Error('Save a relay origin without credentials, a path or a query.');
    const origin = url.protocol + '//' + url.hostname + '/*';
    if (!await chrome.permissions.contains({origins:[origin]})) throw Error('Relay access is missing. Open Roku sync and Save to grant access.');
    // Consent or the relay can change while Chrome checks the host grant.
    const current = await chrome.storage.local.get(['server','token','enabled','syncMode','privacyConsent']);
    if (current.enabled !== true || current.privacyConsent?.version !== 1 || current.privacyConsent.server !== server || current.server !== server || current.token !== token || current.syncMode !== syncMode) return {disabled:true};
    const start = performance.now();
    const response = await fetch(url.origin + (message.type === 'read' ? '/sync' : message.type === 'clock' ? '/clock' : message.type === 'sample' ? '/sample' : message.type === 'schedule' ? '/schedule-start' : message.type === 'cancel' ? '/cancel-start' : message.type === 'telemetry' ? '/telemetry' : message.type === 'baton' ? '/baton' : '/event'), {
      method: ['read','clock'].includes(message.type) ? 'GET' : 'POST',
      headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
      redirect: 'error',
      credentials: 'omit',
      ...(message.type === 'event' ? {body: JSON.stringify({action: message.action, position: message.position, title_id: message.title_id, key: message.key, ...(message.app ? {app: message.app} : {}), ...(message.client_id ? {client_id: message.client_id} : {}), ...(syncMode === 'peer' ? {sync_mode: 'peer'} : {})})} : message.type === 'baton' ? {body: JSON.stringify(message.data || {})} : message.type === 'schedule' ? {body: JSON.stringify({sample_id:message.sample_id,position_ms:message.position_ms,lead_ms:message.lead_ms,roku_lead_ms:rokuLeadMs ?? 0})} : message.type === 'cancel' ? {body: JSON.stringify({id:message.id})} : message.type === 'telemetry' ? {body: JSON.stringify(message.data)} : {}),
      signal: AbortSignal.timeout(message.type === 'sample' ? 12000 : (message.type === 'event' && message.action === 'seek') ? 25000 : 5000)
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    data.relay_round_trip_ms=Math.round(performance.now()-start);
    return data;
  })().then(data => respond({data}), err => respond({error: err.message}));
  return true;
});
