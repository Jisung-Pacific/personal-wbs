// PP WBS browser extension — shared module (options page, popup and service worker).
//
// The extension is a collection channel for places where no agent can write the ledger itself: AI chat sites without
// tools (DeepSeek, Grok, Meta AI, Kimi, Perplexity, …) and, only when the person turns it on, Google searches. It sends
// everything to the person's own account on their PP WBS Hub and nowhere else:
//   - "Send this chat"   the conversation on the open tab → the hub inbox (an agent later turns work into ledger rows)
//   - "Record lines"     PP-WBS-RECORD {json} lines an assistant wrote (instructions.md) → ledger rows directly
//   - Google searches    opt-in; queries → the inbox, batched every 15 minutes
// Sign-in is OAuth 2.1 against the hub (dynamic registration, authorization code with PKCE, launchWebAuthFlow);
// tokens stay in this browser profile's extension storage.

export const BUILD_HUB = '';   // a store build sets the hub URL here (scripts/build_extension.py); empty → ask in options

// ---------------------------------------------------------------- storage
const get = keys => chrome.storage.local.get(keys);
const set = obj => chrome.storage.local.set(obj);
export async function hubUrl() { const { hub } = await get('hub'); return String(hub || BUILD_HUB || '').replace(/\/+$/, ''); }
export async function setHub(url) {
  const u = new URL(url); if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error(t('needHttps'));
  await chrome.storage.local.remove(['tok', 'reg']); await set({ hub: u.origin });
}

// ---------------------------------------------------------------- OAuth (runs in the options page: a tab survives the sign-in window)
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function client(hub) {
  const redirect = chrome.identity.getRedirectURL('cb'), { reg } = await get('reg');
  if (reg && reg.hub === hub && reg.redirect === redirect) return reg;
  const r = await fetch(`${hub}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'PP WBS browser extension', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  if (!r.ok) throw new Error(`${t('regFailed')} (${r.status})`);
  const out = { hub, redirect, client_id: (await r.json()).client_id };
  await set({ reg: out }); return out;
}
async function tokenCall(hub, form) {
  const r = await fetch(`${hub}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `token ${r.status}`);
  return { access: j.access_token, refresh: j.refresh_token, until: Date.now() + (j.expires_in || 3600) * 1000 - 60_000 };
}
/** Must be called from a user action on an extension page (it may ask for the hub's host permission). */
export async function signIn() {
  const hub = await hubUrl(); if (!hub) throw new Error(t('noHub'));
  if (!await chrome.permissions.contains({ origins: [hub + '/*'] }) && !await chrome.permissions.request({ origins: [hub + '/*'] })) throw new Error(t('needPermission'));
  const c = await client(hub), verifier = rand(32), state = rand(16), resource = `${hub}/v1`;
  const url = `${hub}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: c.redirect,
    code_challenge: await sha256(verifier), code_challenge_method: 'S256', state, scope: 'wbs.read wbs.write', resource });
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url, interactive: true }));
  const p = back.searchParams;
  if (p.get('state') !== state) throw new Error('state mismatch');
  if (p.get('error')) throw new Error(p.get('error_description') || p.get('error'));
  if (p.get('iss') && p.get('iss') !== hub) throw new Error('issuer mismatch');
  const tok = await tokenCall(hub, { grant_type: 'authorization_code', code: p.get('code'), redirect_uri: c.redirect, client_id: c.client_id, code_verifier: verifier, resource });
  await set({ tok: { ...tok, hub } });
}
export async function signOut() {
  const hub = await hubUrl(), { tok, reg } = await get(['tok', 'reg']);
  if (tok?.refresh && reg) await fetch(`${hub}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tok.refresh, client_id: reg.client_id }) }).catch(() => {});
  await chrome.storage.local.remove('tok');
}
export async function signedIn() { return !!(await accessToken()); }
async function accessToken() {
  const hub = await hubUrl(), { tok, reg } = await get(['tok', 'reg']);
  if (!tok || tok.hub !== hub) return null;
  if (tok.until > Date.now()) return tok.access;
  if (!tok.refresh || !reg) return null;
  try { const n = await tokenCall(hub, { grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: reg.client_id, resource: `${hub}/v1` }); await set({ tok: { ...n, hub } }); return n.access; }
  catch { await chrome.storage.local.remove('tok'); return null; }
}

// ---------------------------------------------------------------- hub calls
export async function api(path, method = 'GET', body) {
  const hub = await hubUrl(), at = await accessToken();
  if (!hub || !at) throw new Error(t('signInFirst'));
  const r = await fetch(`${hub}/v1${path}`, { method, headers: { authorization: `Bearer ${at}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

/** A captured page → inbox item(s), and its PP-WBS-RECORD lines → ledger rows (anything the hub refuses goes to the inbox). */
export async function sendCapture(cap) {
  const out = { inbox: 0, again: 0, rows: [], refused: 0, duplicates: 0 };
  const today = new Date().toISOString().slice(0, 10);
  if (cap.text) {
    const r = await api('/inbox', 'POST', { items: [{ kind: 'chat', source: cap.source, at: today, title: cap.title.slice(0, 300), text: cap.text, url: cap.url }] });
    if (!r.ok) throw new Error(r.body.message || r.body.error || `inbox ${r.status}`);
    out.inbox = r.body.added; out.again = r.body.existing;
  }
  for (const rec of cap.records || []) {
    const r = await api('/rows', 'POST', { evidence: `${cap.source}:${cap.url}`, ...rec });
    if (r.ok) out.rows.push(`${r.body.created?.year} ${r.body.created?.code}`);
    else if (r.status === 409) out.duplicates++;
    else {   // a record the hub cannot place (unknown package, bad date): keep it for an agent to fix
      out.refused++;
      await api('/inbox', 'POST', { items: [{ kind: 'record', source: cap.source, at: today, title: String(rec.task || '').slice(0, 300), text: JSON.stringify(rec), url: cap.url }] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- capture (injected into the open tab by chrome.scripting)
/** Runs inside the page: the conversation as text, plus PP-WBS-RECORD lines. Self-contained (it is serialized). */
export function captureChat() {
  const SOURCES = [[/(^|\.)chatgpt\.com$|chat\.openai\.com$/, 'chatgpt'], [/chat\.deepseek\.com$/, 'deepseek'], [/(^|\.)grok\.com$|x\.com$/, 'grok'],
    [/(^|\.)meta\.ai$/, 'meta-ai'], [/gemini\.google\.com$/, 'gemini'], [/kimi\.(com|moonshot\.cn)$/, 'kimi'], [/perplexity\.ai$/, 'perplexity'],
    [/claude\.ai$/, 'claude'], [/chat\.mistral\.ai$/, 'mistral'], [/copilot\.microsoft\.com$/, 'copilot'], [/chat\.qwen\.ai$|tongyi\.aliyun\.com$/, 'qwen']];
  const host = location.hostname, source = (SOURCES.find(([re]) => re.test(host)) || [null, host.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '') || 'web'])[1];
  // message elements where the site marks them; otherwise the main region as one block (layouts change; the fallback keeps working)
  const SEL = '[data-message-author-role], user-query, model-response, [data-testid="user-message"], .font-claude-message, [class*="message-bubble"], .ds-message';
  const msgs = [...document.querySelectorAll(SEL)].filter(el => !el.closest('nav, aside, header, footer') && el.innerText.trim());
  const outer = msgs.filter(el => !msgs.some(o => o !== el && o.contains(el)));
  const role = el => el.getAttribute('data-message-author-role') || (el.matches('user-query, [data-testid="user-message"]') ? 'user' : el.matches('model-response, .font-claude-message') ? 'assistant' : '');
  let text = outer.length ? outer.map(el => `${role(el) ? role(el) + ': ' : ''}${el.innerText.trim()}`).join('\n\n')
    : (document.querySelector('main') || document.body).innerText.trim();
  if (text.length > 20000) text = text.slice(0, 9000) + '\n…\n' + text.slice(-10900);   // the start and the end carry the request and the result
  // PP-WBS-RECORD {…}: the object is read by brace matching (pages may join lines), strings and escapes respected
  const records = [], all = document.body.innerText || '';
  for (let i = all.indexOf('PP-WBS-RECORD'); i >= 0; i = all.indexOf('PP-WBS-RECORD', i + 13)) {
    const a = all.indexOf('{', i); if (a < 0 || a - i > 40) continue;
    let depth = 0, str = false, esc = false, b = -1;
    for (let k = a; k < all.length && k < a + 4000; k++) {
      const c = all[k];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { b = k; break; }
    }
    if (b < 0) continue;
    try { const r = JSON.parse(all.slice(a, b + 1).replace(/[“”]/g, '"')); if (r && r.task && !records.some(x => JSON.stringify(x) === JSON.stringify(r))) records.push(r); } catch (e) { /* not JSON: skip */ }
  }
  const url = location.origin + location.pathname;   // no query or fragment (they often carry tracking or session data)
  return { source, title: document.title || url, url, text, records };
}

// ---------------------------------------------------------------- tiny i18n for the extension pages
const MSG = {
  ko: { noHub: '허브 주소를 먼저 넣으세요.', needHttps: 'https 주소여야 합니다.', needPermission: '허브 주소에 연결할 권한이 필요합니다.', regFailed: '허브에 등록하지 못했습니다',
    signInFirst: '먼저 로그인하세요.', sent: '보냈습니다', inbox: '받은 편지함', again: '이미 보낸 대화', rows: '원장 기록', dup: '이미 있음', refused: '받은 편지함으로', nothing: '보낼 내용이 없습니다.' },
  en: { noHub: 'Enter the hub URL first.', needHttps: 'The URL must be https.', needPermission: 'Permission to reach the hub is needed.', regFailed: 'Could not register with the hub',
    signInFirst: 'Sign in first.', sent: 'Sent', inbox: 'inbox', again: 'already sent', rows: 'ledger rows', dup: 'already there', refused: 'to the inbox', nothing: 'Nothing to send.' },
};
export const t = k => (MSG[(navigator.language || 'en').startsWith('ko') ? 'ko' : 'en'][k] || k);
export function summary(o) {
  if (!o.inbox && !o.again && !o.rows.length && !o.duplicates && !o.refused) return t('nothing');
  return [o.inbox ? `${t('inbox')} +${o.inbox}` : '', o.again ? t('again') : '', o.rows.length ? `${t('rows')} ${o.rows.join(', ')}` : '', o.duplicates ? `${t('dup')} ${o.duplicates}` : '', o.refused ? `${t('refused')} ${o.refused}` : ''].filter(Boolean).join(' · ');
}
