// Google search capture — registered only while the person has switched it on (options page) and granted google.com.
// Reports the query of a results page once per tab session: the query and the time, nothing else (no results, no clicks).
(() => {
  const q = new URL(location.href).searchParams.get('q');
  if (!q || !q.trim()) return;
  const key = 'ppwbs:' + q;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* storage blocked: report anyway */ }
  chrome.runtime.sendMessage({ type: 'search', q: q.trim(), at: new Date().toISOString() });
})();
