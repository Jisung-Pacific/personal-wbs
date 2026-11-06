// Sign-in and consent page. One account (the product's Firebase Auth: Google or email), one decision (allow or deny),
// and the exact access asked for. The parked request id is the only thing the form carries besides the ID token.
import { SCOPES, type Config } from '../config.js';
import type { AuthRequest } from '../store/types.js';

const FIREBASE_SDK = '12.19.0';   // compat builds from gstatic, pinned
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --fg: #1d2330; --muted: #5b6475; --line: #dfe3ea; --accent: #2f5bd3; --on-accent: #fff; --warn: #a33a1f; color-scheme: light }
@media (prefers-color-scheme: dark) { :root { --bg: #12151b; --card: #1a1f27; --fg: #e8ebf1; --muted: #a2abbb; --line: #2c3340; --accent: #7c9cff; --on-accent: #0d1220; --warn: #ff9b7a; color-scheme: dark } }
* { box-sizing: border-box } body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; padding: 24px max(16px, env(safe-area-inset-left)) }
main { width: min(440px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 26px 24px }
h1 { font-size: 19px; margin: 0 0 4px } .sub { color: var(--muted); margin: 0 0 18px; font-size: 13.5px }
ul { margin: 0 0 18px; padding-left: 18px } li { margin: 3px 0 } .host { font-family: ui-monospace, monospace; font-size: 12.5px; color: var(--muted); word-break: break-all }
button, input { font: inherit } .row { display: grid; gap: 8px; margin: 12px 0 }
.btn { min-height: 44px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; padding: 0 14px }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600 }
input { min-height: 44px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 0 12px; width: 100% }
.who { padding: 10px 12px; border-radius: 10px; background: var(--bg); margin: 10px 0; font-size: 14px } .err { color: var(--warn); min-height: 1.4em; font-size: 13.5px }
details summary { cursor: pointer; color: var(--muted); font-size: 13.5px; min-height: 32px; display: flex; align-items: center }
.foot { margin-top: 16px; font-size: 12px; color: var(--muted) }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`;

export function errorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PP WBS Hub</title><style>${STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p class="sub">${esc(detail)}</p></main></body></html>`;
}

export function consentPage({ cfg, pending, nonce }: { cfg: Config; pending: AuthRequest; nonce: string }): string {
  const scopes = pending.scope.split(' ').map(s => `<li>${esc(SCOPES[s]?.ko || s)}${SCOPES[s]?.reserved ? ' <small>(준비 중)</small>' : ''}</li>`).join('');
  const host = (() => { try { const u = new URL(pending.redirect_uri); return /^https?:$/.test(u.protocol) ? u.host : u.protocol; } catch { return pending.redirect_uri; } })();
  const fb = cfg.firebaseWeb, dev = cfg.devLogin;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PP WBS Hub 연결</title><style nonce="${nonce}">${STYLE}</style></head><body><main>
<h1>${esc(pending.client_name)} 연결</h1>
<p class="sub">이 앱이 ${esc(cfg.brand)} 계정의 다음 권한을 요청합니다.</p>
<ul>${scopes}</ul>
<p class="host">돌아갈 곳: ${esc(host)}</p>
<form id="f" method="post" action="/oauth/approve"><input type="hidden" name="req" value="${esc(pending.id)}"><input type="hidden" name="id_token" id="tok"><input type="hidden" name="decision" id="dec" value="deny"></form>
<div id="who" class="who" hidden></div>
${fb ? `<div class="row" id="signin">
  <button class="btn primary" id="g" type="button">Google로 계속</button>
  <details><summary>이메일로 로그인</summary><form id="ef" class="row"><input id="em" type="email" autocomplete="email" placeholder="이메일" required><input id="pw" type="password" autocomplete="current-password" placeholder="비밀번호" required><button class="btn" type="submit">로그인</button></form></details>
</div>` : ''}
${dev ? `<form id="df" class="row"><input id="duid" placeholder="개발용 uid" pattern="[A-Za-z0-9_\-]{3,64}" required><button class="btn" type="submit">개발용 로그인</button></form>` : ''}
<div class="row"><button class="btn primary" id="allow" type="button" hidden>허용</button><button class="btn" id="deny" type="button">거부</button></div>
<p class="err" id="err" role="alert"></p>
<p class="foot">허용하면 이 앱이 위 권한으로 작업 원장을 읽고 기록합니다. 연결은 앱 쪽 커넥터 설정에서 언제든 끊을 수 있습니다.</p>
</main>
${fb ? `<script nonce="${nonce}" src="https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app-compat.js"></script>
<script nonce="${nonce}" src="https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth-compat.js"></script>` : ''}
<script nonce="${nonce}">
(() => {
  const $ = id => document.getElementById(id), f = $('f');
  let token = null;
  const ready = (label, t) => { token = t; $('who').textContent = label + ' 계정으로 허용합니다'; $('who').hidden = false; $('allow').hidden = false; $('allow').focus(); };
  const fail = e => { $('err').textContent = (e && e.message) || String(e); };
  $('allow').onclick = () => { if (!token) return; $('tok').value = token; $('dec').value = 'allow'; f.submit(); };
  $('deny').onclick = () => { $('dec').value = 'deny'; f.submit(); };
  ${fb ? `firebase.initializeApp(${JSON.stringify({ apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId })});
  const auth = firebase.auth();
  const signed = async u => ready(u.email || u.displayName || '로그인한', await u.getIdToken(true));
  auth.onAuthStateChanged(u => { if (u) signed(u).catch(fail); });
  $('g').onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).then(r => signed(r.user)).catch(fail);
  $('ef').onsubmit = e => { e.preventDefault(); auth.signInWithEmailAndPassword($('em').value, $('pw').value).then(r => signed(r.user)).catch(fail); };` : ''}
  ${dev ? `$('df').onsubmit = e => { e.preventDefault(); ready('개발용 ' + $('duid').value, 'dev:' + $('duid').value); };` : ''}
})();
</script></body></html>`;
}
