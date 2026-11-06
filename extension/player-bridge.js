// Runs in Netflix's page world. It receives no relay credentials.
(() => {
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
