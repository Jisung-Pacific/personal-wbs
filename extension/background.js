// PP WBS browser extension — service worker: the context menu, the keyboard shortcut, and the opt-in search batch.
import { api, captureChat, sendCapture, summary } from './lib.js';

const SEARCH_SCRIPT = 'ppwbs-search';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'send-chat', title: chrome.i18n.getMessage('cmdSend'), contexts: ['page', 'selection'] });
  chrome.alarms.create('flush-search', { periodInMinutes: 15 });
  syncSearchScript();
});
chrome.runtime.onStartup.addListener(syncSearchScript);

/** Capture the active tab (activeTab is granted by the click or the shortcut) and send it. */
async function sendTab(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureChat });
    const msg = summary(await sendCapture(result));
    badge(tab.id, '✓'); notify(msg);
  } catch (e) { badge(tab.id, '!'); notify(String(e.message || e)); }
}
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'send-chat' && tab) sendTab(tab); });
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'send-chat' && tab) sendTab(tab); });
function badge(tabId, text) { chrome.action.setBadgeText({ tabId, text }); setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000); }
function notify(message) { chrome.storage.local.set({ last: { message, at: Date.now() } }); }

// ---- Google searches (opt-in): the content script reports each query once; they leave in a batch every 15 minutes
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m?.type !== 'search' || !sender.url || !/^https:\/\/www\.google\.[a-z.]+\/search/.test(sender.url) || typeof m.q !== 'string') return;
  chrome.storage.local.get(['searchOn', 'pending'], ({ searchOn, pending = [] }) => {
    if (!searchOn) return;
    pending.push({ q: m.q.slice(0, 300), at: m.at }); chrome.storage.local.set({ pending: pending.slice(-500) });
  });
});
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'flush-search') return;
  const { pending = [] } = await chrome.storage.local.get('pending'); if (!pending.length) return;
  const items = pending.slice(0, 100).map(p => ({ kind: 'search', source: 'google-search', at: p.at, title: p.q, url: `https://www.google.com/search?q=${encodeURIComponent(p.q)}`, text: '' }));
  try { const r = await api('/inbox', 'POST', { items }); if (r.ok) await chrome.storage.local.set({ pending: pending.slice(items.length) }); } catch (e) { /* signed out or offline: keep them for the next run */ }
});

/** The search content script exists only while the person has it switched on and has granted google.com. */
export async function syncSearchScript() {
  const { searchOn } = await chrome.storage.local.get('searchOn');
  const has = (await chrome.scripting.getRegisteredContentScripts({ ids: [SEARCH_SCRIPT] })).length > 0;
  const allowed = await chrome.permissions.contains({ origins: ['https://www.google.com/*'] });
  if (searchOn && allowed && !has) await chrome.scripting.registerContentScripts([{ id: SEARCH_SCRIPT, matches: ['https://www.google.com/search*'], js: ['search.js'], runAt: 'document_idle' }]);
  if ((!searchOn || !allowed) && has) await chrome.scripting.unregisterContentScripts({ ids: [SEARCH_SCRIPT] });
}
chrome.storage.onChanged.addListener(ch => { if (ch.searchOn) syncSearchScript(); });
chrome.permissions.onRemoved.addListener(syncSearchScript);
