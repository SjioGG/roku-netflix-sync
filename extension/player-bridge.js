// Runs in Netflix's page world. It receives no relay credentials.
(() => {
  const loc = typeof location !== 'undefined' ? location : (typeof window !== 'undefined' ? window.location : null);
  if (loc && /roku-sync-ref/i.test(String(loc.hash || '') + String(loc.search || ''))) {
    try { document.documentElement?.setAttribute('data-roku-sync-ref', '1'); } catch (e) {}
    try { globalThis.sessionStorage?.setItem?.('rokuSyncRef', '1'); } catch (e) {}
  }
  if (window.__rokuSyncPlayerBridge) return;
  window.__rokuSyncPlayerBridge = true;
  document.addEventListener('roku-sync-seek', event => {
    const {id, position} = event.detail || {};
    if (typeof id !== 'string' || !Number.isFinite(position) || position < 0) return;
    let error = null;
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      const ids = api?.getAllPlayerSessionIds();
      const player = ids?.length && api.getVideoPlayerBySessionId(ids[0]);
      if (!player || typeof player.seek !== 'function') throw Error('Netflix player is not available yet.');
      player.seek(Math.round(position));
    } catch (e) { error = e.message || 'Netflix could not seek.'; }
    document.dispatchEvent(new CustomEvent('roku-sync-seek-result', {detail:{id,error}}));
  });
})();
