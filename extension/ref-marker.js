// Runs at document_start, before a site's router can rewrite the URL. Netflix
// and YouTube both drop the #roku-sync-ref hash during boot, so the flag is
// copied to the tab's sessionStorage and <html> where content.js reads it.
(() => {
  const loc = typeof location !== 'undefined' ? location : null;
  if (!loc || !/roku-sync-ref/i.test(String(loc.hash || '') + String(loc.search || ''))) return;
  try { document.documentElement?.setAttribute('data-roku-sync-ref', '1'); } catch (e) {}
  try { globalThis.sessionStorage?.setItem?.('rokuSyncRef', '1'); } catch (e) {}
})();
