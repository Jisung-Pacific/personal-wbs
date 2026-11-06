// Popup: one action (send this tab's chat) and the account state. Sign-in happens on the options page.
import { captureChat, sendCapture, signedIn, hubUrl, summary, t } from './lib.js';
const $ = id => document.getElementById(id);
const en = !(navigator.language || '').startsWith('ko');
if (en) { $('send').textContent = 'Send this chat'; $('opts').textContent = 'Settings · sign in'; document.querySelector('.muted.small').textContent = 'Sends the open tab’s conversation to your inbox; PP-WBS-RECORD lines in it go straight into the ledger. Shortcut Alt+Shift+W.'; }
(async () => {
  const ok = await signedIn(), hub = await hubUrl();
  $('who').textContent = ok ? new URL(hub).host : (en ? 'not signed in' : '로그인 전');
  $('send').disabled = !ok;
})();
$('opts').onclick = () => chrome.runtime.openOptionsPage();
$('send').onclick = async () => {
  $('send').disabled = true; $('out').textContent = '…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureChat });
    $('out').textContent = `${t('sent')}: ${summary(await sendCapture(result))}`;
  } catch (e) { $('out').textContent = String(e.message || e); }
  finally { $('send').disabled = false; }
};
