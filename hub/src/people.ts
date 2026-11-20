// The hub's own pages for people (/app): what only a person may do, by their own hand, never through an agent — make a
// team space, propose and agree to its charter, invite people and remove them, accept or decline an invitation (one
// account, many teams: execution WBS 5.3), move between one's teams, leave, hand a team over or delete it, answer the Big
// Five questions and publish, change or withdraw one's work-style and direction card (execution WBS 4.2), download one's
// own ledger and delete one's own account (execution WBS 5.4). An agent's OAuth token cannot
// act here: a person signs in on this page (the same accounts as the consent page), and the hub keeps a first-party
// session in an HttpOnly, SameSite=Strict cookie; every change also needs the page's own request header and a
// same-origin request, so another site can neither send nor forge one.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store/types.js';
import { CARD_SECTIONS, TRAITS, type CardSection } from './store/types.js';
import type { TokenIssuer } from './auth/tokens.js';
import { random } from './auth/tokens.js';
import type { VerifyIdToken } from './auth/identity.js';
import { person, type Caller } from './wbs/access.js';
import { LedgerError, type Ledger } from './wbs/service.js';
import type { Revocations } from './auth/revocations.js';
import type { Plans } from './wbs/plan.js';
import { INVITE_DAYS, MAX_PEOPLE, TITLE_MAX, type InviteRef, type Spaces } from './wbs/spaces.js';
import { switchList } from './wbs/team.js';
import { Cards, DEFAULT_SECTIONS, INSTRUCTIONS, MINI_IPIP, SCALE, TRAIT_KO } from './wbs/cards.js';
import type { MasterAgent } from './wbs/master.js';

const FIREBASE_SDK = '12.19.0';   // the same pinned compat builds as the consent page
const SESSION_TTL = 8 * 3600;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const ymd = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);   // KST, like the ledger
const SECTION_KO: Record<CardSection, string> = { ...TRAIT_KO, direction: '방향성' };

export interface PeopleDeps { cfg: Config; store: Store; issuer: TokenIssuer; verifyIdToken: VerifyIdToken; spaces: Spaces; cards: Cards; master?: MasterAgent; ledger?: Ledger; revocations?: Revocations; plans?: Plans }
/** What a person types to delete their account: a deliberate act, never one stray click. */
const DELETE_PHRASE = '계정 삭제';
const EXPORTS = ['wbs.csv', 'events.csv'] as const;   // one's own ledger, in the file format it came from
type Signed = Request & { uid?: string };

export function peopleRouter({ cfg, store, issuer, verifyIdToken, spaces, cards, master, ledger, revocations, plans }: PeopleDeps): Router {
  const r = express.Router(), secure = cfg.publicUrl.startsWith('https://'), COOKIE = secure ? '__Host-ppwbs' : 'ppwbs', origin = new URL(cfg.publicUrl).origin;
  const cookieOf = (req: Request) => (req.get('cookie') || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === COOKIE)?.[1];
  const setCookie = (res: Response, v: string, age: number) => res.append('Set-Cookie', `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);

  // every page: no framing, no caching, scripts and styles only with this response's nonce (and Firebase Auth's own)
  const page = (res: Response, title: string, body: string, script = '', external: string[] = []) => {
    const nonce = random(16), auth = cfg.firebaseWeb ? `https://${cfg.firebaseWeb.authDomain}` : '';
    res.set('Content-Security-Policy', ["default-src 'none'", `script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com`, `style-src 'nonce-${nonce}'`,
      "img-src data: https://www.gstatic.com https://lh3.googleusercontent.com", "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
      `frame-src ${auth} https://accounts.google.com`.trim(), "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"].join('; '))
      .set('X-Frame-Options', 'DENY').set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
      .type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · PP WBS Hub</title><style nonce="${nonce}">${STYLE}</style></head><body>${body}
${external.map(u => `<script nonce="${nonce}" src="${esc(u)}"></script>`).join('')}<script nonce="${nonce}">${BASE_JS}${script}</script></body></html>`);
  };

  /** The signed-in person, from the session cookie; pages without one show the sign-in page, the API answers 401. A
   *  session issued before its account was deleted (on any device) is dropped like an expired one (5.4). */
  const signed = (api: boolean) => async (req: Signed, res: Response, next: NextFunction) => {
    const t = cookieOf(req);
    if (t) {
      try {
        const s = await issuer.verifySession(t);
        if (!(await revocations?.revoked(s.uid, s.iat))) { req.uid = s.uid; return next(); }
        setCookie(res, '', 0);
      } catch { /* expired or foreign: sign in again */ }
    }
    if (api) return res.status(401).json({ error: 'sign_in', message: 'Sign in on the hub page first' });
    signInPage(res);
  };
  /** A change must come from this hub's own page: its request header (a cross-site form cannot add one) and, when the
   *  browser says where it came from, this origin. */
  const sameSite = (req: Request, res: Response, next: NextFunction) => {
    const o = req.get('origin'), site = req.get('sec-fetch-site');
    if (req.get('x-ppwbs') !== '1' || (o && o !== origin) || (site && site !== 'same-origin')) return res.status(403).json({ error: 'forbidden', message: 'Changes come only from the hub\'s own pages' });
    next();
  };
  const json = express.json({ limit: '32kb' });
  const act = (f: (who: Caller, req: Signed, res: Response) => Promise<unknown>) => (req: Signed, res: Response) => {
    f(person(req.uid!), req, res).then(v => res.json(v ?? { ok: true })).catch(e => {
      if (e instanceof LedgerError) return res.status({ not_found: 404, duplicate: 409, forbidden: 403, consent_required: 403, invalid: 400 }[e.code]).json({ error: e.code, message: e.message, detail: e.detail });
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid', message: e.issues.map(i => i.message).join('; ') });
      console.error(e); res.status(500).json({ error: 'server_error' });
    });
  };

  // ---------------------------------------------------------------- session
  r.post('/session', sameSite, json, async (req, res) => {
    try {
      const who = await verifyIdToken(String(req.body?.id_token || ''));
      if (who.name) await store.putSecret(who.uid, 'profile', { name: who.name.slice(0, 60) });   // the name teammates see on cards and lists
      setCookie(res, await issuer.session(who.uid, SESSION_TTL), SESSION_TTL);
      res.json({ ok: true });
    } catch { res.status(401).json({ error: 'sign_in', message: '로그인을 확인하지 못했습니다' }); }
  });
  r.post('/logout', sameSite, (_req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });

  function signInPage(res: Response) {
    const fb = cfg.firebaseWeb, social = cfg.authProviders.filter(p => p.id !== 'password'), pw = cfg.authProviders.some(p => p.id === 'password');
    page(res, '로그인', `<main class="narrow"><h1>PP WBS Hub</h1>
<p class="sub">팀 공간, 헌장, 성향·방향성 카드는 사람이 직접 하는 일이라 여기서 로그인해서 합니다. 에이전트 연결과 같은 계정입니다.</p>
${fb ? `<div class="stack">${social.map((p, i) => `<button class="btn${i ? '' : ' primary'}" type="button" data-p="${esc(p.id)}">${esc(p.label)} 계정으로 로그인</button>`).join('')}
${pw ? `<form id="ef" class="stack"><input id="em" type="email" autocomplete="email" placeholder="이메일" required><input id="pw" type="password" autocomplete="current-password" placeholder="비밀번호" required><button class="btn" type="submit">이메일로 로그인</button></form>` : ''}</div>` : ''}
${cfg.devLogin ? `<form id="df" class="stack"><input id="duid" placeholder="개발용 uid" pattern="[A-Za-z0-9_\\-]{3,64}" required><button class="btn" type="submit">개발용 로그인</button></form>` : ''}
<p class="err" id="err" role="alert"></p></main>`,
    `
const go = t => api('POST', '/app/session', { id_token: t }).then(() => location.reload()).catch(e => { $('err').textContent = e.message; });
${fb ? `firebase.initializeApp(${js({ apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId })});
const auth = firebase.auth(); auth.languageCode = 'ko';
const provider = id => id === 'google' ? new firebase.auth.GoogleAuthProvider() : new firebase.auth.OAuthProvider(id === 'apple' ? 'apple.com' : id);
document.querySelectorAll('[data-p]').forEach(b => { b.onclick = () => auth.signInWithPopup(provider(b.dataset.p)).then(r => r.user.getIdToken(true)).then(go).catch(e => { $('err').textContent = e.message; }); });
if ($('ef')) $('ef').onsubmit = e => { e.preventDefault(); auth.signInWithEmailAndPassword($('em').value, $('pw').value).then(r => r.user.getIdToken(true)).then(go).catch(e2 => { $('err').textContent = e2.message; }); };` : ''}
${cfg.devLogin ? `$('df').onsubmit = e => { e.preventDefault(); go('dev:' + $('duid').value); };` : ''}`,
    fb ? [`https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app-compat.js`, `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth-compat.js`] : []);
  }

  const nameOf = async (uid: string) => (await store.secret<{ name?: string }>(uid, 'profile'))?.name || `계정 ${uid.slice(0, 8)}`;
  const namesOf = async (uids: Iterable<string>) => new Map(await Promise.all([...new Set(uids)].map(async u => [u, await nameOf(u)] as const)));
  /** The spaces with what waits in each team, and the invitations waiting for the person (one account, many teams: 5.3). */
  const mySpaces = async (who: Caller) => {
    const all = await switchList(spaces, who, master);
    return { teams: all.filter(s => s.kind === 'team') as TeamEntry[], invites: all.filter(s => s.kind === 'invite') as InviteEntry[] };
  };
  const header = (uid: string, name: string) => `<header class="top"><a class="brand" href="/app">PP WBS Hub</a><span class="me">${esc(name)}</span>
<button class="link" id="out" type="button">로그아웃</button></header>`;

  // ---------------------------------------------------------------- home: my spaces and my measurement
  r.get('/', signed(false), async (req: Signed, res) => {
    const uid = req.uid!, who = person(uid), [{ teams, invites }, mine, name] = await Promise.all([mySpaces(who), cards.mine(who), nameOf(uid)]);
    const inviters = await namesOf(invites.map(i => i.by));
    const received = invites.length ? `<section class="box"><h2>받은 초대 <small>${invites.length}건</small></h2>
<ul class="rows">${invites.map(i => `<li><a href="/app/i/${esc(i.space)}/${esc(i.invite)}"><b>${esc(i.name)}</b></a> <span class="chip">${ROLE[i.role]}</span> <span class="note">${esc(inviters.get(i.by))} 님 초대 · ${ymd(i.expires)}까지</span></li>`).join('')}</ul>
<p class="note">열어서 읽고 수락하면 그 팀에 들어갑니다. 내 개인 원장은 어느 팀에도 보이지 않습니다.</p></section>` : '';
    page(res, '내 공간', `${header(uid, name)}<main>
<h1>내 공간</h1>
${received}
<section class="box"><h2>성향 측정</h2>
${mine.assessment ? `<p>${ymd(mine.assessment.at)} 측정${mine.assessment.stale ? ' · <b class="warn">반년이 지났습니다. 다시 측정해 주세요</b>' : ''}</p>${traitBars(mine.assessment.traits)}` : '<p>아직 측정하지 않았습니다. 카드에 성향을 싣으려면 먼저 20문항(약 3분)에 답하세요.</p>'}
<p><a class="btn primary" href="/app/assess">${mine.assessment ? '다시 측정' : '측정하기'}</a></p>
<p class="note">점수는 내 공간에만 남고, 팀에는 내가 카드에 고른 항목만 갑니다. 답 자체는 저장하지 않습니다.</p></section>
<section class="box"><h2>팀 공간</h2>
${teams.length ? `<ul class="rows">${teams.map(t => `<li><a href="/app/t/${esc(t.id)}"><b>${esc(t.name)}</b></a> <span class="chip">${ROLE[t.role] ?? esc(t.role)}</span>${chips(t)}</li>`).join('')}</ul>` : '<p>아직 속한 팀 공간이 없습니다. 팀을 만들거나, 받은 초대를 수락하세요.</p>'}
<form id="mk" class="inline"><label for="nm">새 팀 공간</label><input id="nm" maxlength="60" placeholder="팀 이름" required><button class="btn" type="submit">만들기</button></form></section>
<section class="box"><h2>내 계정 id</h2><p>팀 소유자에게 이 id를 보내면 그 팀이 이 계정으로 초대를 보냅니다. 초대는 이 페이지의 받은 초대에 뜨고, 내가 수락해야 들어갑니다.</p>
<p class="inline"><code id="myid">${esc(uid)}</code><button class="btn" id="cp" type="button">복사</button></p></section>
<section class="box"><h2>내 기록과 계정</h2>
${ledger ? `<p>내 개인 원장을 언제든 CSV로 내려받을 수 있습니다.</p><p class="inline">${EXPORTS.map(f => `<a class="btn" href="/app/export/${f}" download>${f} 내려받기</a>`).join('')}</p>` : ''}
<p><a href="/app/account">계정 삭제</a> <span class="note">지우기 전에 무엇이 지워지고 무엇이 팀에 남는지 먼저 보여 줍니다.</span></p></section>
</main>`, `
$('mk').onsubmit = e => { e.preventDefault(); api('POST', '/app/api/spaces', { name: $('nm').value }).then(s => { location.href = '/app/t/' + s.id; }).catch(err); };
$('cp').onclick = () => copy($('myid'), $('cp'));`);
  });

  // ---------------------------------------------------------------- my own ledger out, and my account gone (5.4)
  r.get('/export/:file', signed(false), async (req: Signed & { params: Record<string, string> }, res) => {
    const f = req.params.file;
    if (!ledger || !(EXPORTS as readonly string[]).includes(f)) return res.status(404).type('text/plain').send('not found');
    const out = await ledger.exportCsv(req.uid!);
    res.set('Cache-Control', 'no-store').set('Content-Disposition', `attachment; filename="${f}"`).type('text/csv; charset=utf-8')
      .send(f === 'wbs.csv' ? out.wbs : out.events);
  });

  // What goes, what stays with the teams, and what must be settled first; then the person types the phrase and confirms.
  r.get('/account', signed(false), async (req: Signed, res) => {
    const uid = req.uid!, who = person(uid), [name, plan, { teams }] = await Promise.all([nameOf(uid), spaces.deletionPlan(uid), mySpaces(who)]);
    const teamName = new Map(teams.map(t => [t.id, t.name])), label = (id: string) => esc(teamName.get(id) ?? id);
    const list = (items: string[]) => `<ul class="lines">${items.map(x => `<li>${x}</li>`).join('')}</ul>`;
    const blocked = plan.blocks.length > 0, host = cfg.host.sessionUrl ? cfg.host.name : '';
    page(res, '계정 삭제', `${header(uid, name)}<main><p><a href="/app">← 내 공간</a></p>
<h1>계정 삭제</h1>
<p class="sub">지우면 되돌릴 수 없습니다. 필요한 기록은 먼저 내려받으세요.</p>
<div id="acct" class="stack">
${ledger ? `<section class="box"><h2>먼저 내려받기</h2><p class="inline">${EXPORTS.map(f => `<a class="btn" href="/app/export/${f}" download>${f} 내려받기</a>`).join('')}</p></section>` : ''}
<section class="box"><h2>지워지는 것</h2>${list([
      '내 개인 원장의 행과 변경 기록, 받은편지함',
      '성향 점수와 이 허브에 저장된 내 이름',
      '누가 내 행을 봤는지 남은 열람 기록',
      '연결한 에이전트의 권한: 이미 발급된 토큰과 다른 기기의 로그인도 바로 끊깁니다',
    ])}<p class="note">계정의 데이터 키를 먼저 지우므로, 저장된 사본도 그 순간부터 읽을 수 없습니다.</p></section>
<section class="box"><h2>팀 공간</h2>
${plan.deletes.length ? `<h3>함께 지워지는 팀</h3><p class="note">나 혼자 있는 팀입니다.</p>${list(plan.deletes.map(label))}` : ''}
${plan.leaves.length ? `<h3>나가는 팀</h3>${list(plan.leaves.map(s => `${label(s.id)} <span class="chip">${ROLE[s.role] ?? esc(s.role)}</span>`))}
<p class="note">내 카드는 지워지고 내가 한 에이전트 위임은 멈춥니다. 헌장 동의, 승인 결정, 계획의 담당 표시는 팀 기록으로 남고 이름 대신 계정 id로 보입니다.</p>` : ''}
${blocked ? `<h3>먼저 정리할 팀</h3>${list(plan.blocks.map(b => `<a href="/app/t/${esc(b.id)}">${label(b.id)}</a> <span class="note">나 말고 ${b.people}명</span>`))}
<p class="warn">내가 소유한 팀에 다른 사람이 있으면 계정을 지울 수 없습니다. 팀 화면에서 멤버에게 소유자를 넘기거나 팀을 지운 뒤 다시 오세요.</p>` : ''}
${!plan.deletes.length && !plan.leaves.length && !blocked ? '<p>속한 팀 공간이 없습니다.</p>' : ''}</section>
${host ? `<section class="box"><h2>${esc(host)} 회원</h2><p>이 허브는 ${esc(host)}의 로그인 계정과 회원 등록을 지우지 않습니다. 그것도 없애려면 ${esc(host)}에서 따로 탈퇴하세요.</p></section>` : ''}
<section class="box"><h2>지우기</h2><form id="del" class="stack">
${plan.leaves.length ? `<label class="ck"><input type="checkbox" id="ws"> 나가는 팀에 공유했던 내 행 사본도 지웁니다</label>
<p class="note">체크하지 않으면 공유했던 행은 팀의 계획 대비 실적에 고정된 사본으로 남습니다.</p>` : ''}
<label for="cf">확인하려면 <b>${DELETE_PHRASE}</b>라고 입력하세요</label><input id="cf" autocomplete="off"${blocked ? ' disabled' : ''}>
<p><button class="btn danger" id="go" type="submit" disabled>계정 삭제</button></p><p class="err" id="err" role="alert"></p></form></section>
</div></main>`, `
const PHRASE = ${js(DELETE_PHRASE)}, input = $('cf'), go = $('go');
input.oninput = () => { go.disabled = input.value.trim() !== PHRASE; };
$('del').onsubmit = e => { e.preventDefault(); if (go.disabled) return; go.disabled = true;
  api('POST', '/app/api/account/delete', { confirm: input.value.trim(), with_shared: !!($('ws') && $('ws').checked) }).then(() => {
    $('acct').innerHTML = '<section class="box"><h2>계정을 지웠습니다</h2><p>로그인에 쓰던 계정 자체는 그대로라서, 다시 로그인하면 빈 새 계정으로 시작합니다.</p><p><a class="btn" href="/app">처음으로</a></p></section>';
    document.querySelector('.top .me').textContent = ''; $('out').hidden = true; $('acct').querySelector('a').focus();
  }).catch(e => { go.disabled = false; err(e); }); };`);
  });

  // ---------------------------------------------------------------- the team plan's CSV copy (3.10)
  r.get('/t/:space/plan.csv', signed(false), async (req: Signed & { params: Record<string, string> }, res) => {
    if (!plans) return res.status(404).type('text/plain').send('not found');
    try {
      const out = await plans.exportCsv(person(req.uid!), req.params.space);
      res.set('Cache-Control', 'no-store').set('Content-Disposition', 'attachment; filename="plan.csv"').type('text/csv; charset=utf-8').send(out.csv);
    } catch (e) {
      const code = e instanceof LedgerError ? e.code : 'error';
      res.status(code === 'not_found' ? 404 : code === 'forbidden' ? 403 : code === 'consent_required' ? 409 : 500).type('text/plain; charset=utf-8')
        .send(code === 'consent_required' ? '헌장이 시행되고 내가 동의한 뒤에 계획을 내려받을 수 있습니다.' : '이 계획은 내려받을 수 없습니다.');
    }
  });

  // ---------------------------------------------------------------- an invitation, answered by the person (5.3)
  // A link carries its code after '#', so it never reaches a server log or a referrer; an account invitation is named by
  // its space and id, and only its account can open it. The page reads the invitation through the API and asks.
  const joinPage = async (req: Signed, res: Response, ref: { space: string; invite: string } | null) => {
    const uid = req.uid!, name = await nameOf(uid);
    page(res, '팀 초대', `${header(uid, name)}<main><p><a href="/app">← 내 공간</a></p><h1 id="jt">팀 초대</h1>
<section class="box" id="jv" aria-live="polite"><p class="note">초대를 확인하는 중입니다…</p></section><p class="err" id="err" role="alert"></p></main>`, `
const REF = ${ref ? js(ref) : `(() => { const c = location.hash.slice(1); return c ? { code: c } : null; })()`};
const E = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = ${js(ROLE)}, day = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10), box = $('jv');
const lines = c => '<ol class="lines">' + c.lines.map(l => '<li>' + E(l) + '</li>').join('') + '</ol>';
const gone = m => { box.innerHTML = '<p>' + E(m) + '</p><p><a class="btn" href="/app">내 공간으로</a></p>'; };
const NOT_FOUND = '이 초대는 쓸 수 없습니다. 이미 쓰였거나 취소·만료됐거나, 다른 계정에 온 초대입니다. 팀 소유자에게 새 초대를 받으세요.';
if (!REF) gone('초대 링크에 코드가 없습니다. 받은 링크 전체를 주소창에 붙여 넣으세요.');
else api('POST', '/app/api/invites/preview', REF).then(p => {
  $('jt').textContent = p.space.name; document.title = p.space.name + ' · 팀 초대 · PP WBS Hub';
  if (p.already) { box.innerHTML = '<p>이미 이 팀의 ' + E(ROLE[p.already]) + '입니다.</p><p><a class="btn primary" href="/app/t/' + encodeURIComponent(p.space.id) + '">팀 열기</a></p>'; return; }
  let h = '<p><b>' + E(p.by_name) + '</b> 님이 <b>' + E(ROLE[p.role]) + '</b>로 초대했습니다. <span class="note">' + day(p.expires) + '까지 · 한 번만 쓰입니다</span></p>';
  if (p.role === 'guest') h += '<p>게스트는 배정된 프로젝트' + (p.projects && p.projects.length ? '(' + E(p.projects.join(', ')) + ')' : '') + '의 계획과 작업만 읽고, 헌장에 동의하지 않습니다.</p>';
  else if (p.charter) h += '<h2>헌장 ' + p.charter.version + '판</h2>' + lines(p.charter) + '<p class="note">멤버는 시행 중인 헌장에 동의하고 들어갑니다.</p>';
  else h += '<p>아직 시행 중인 헌장이 없습니다. 들어간 뒤 ' + (p.proposal ? '헌장 ' + p.proposal.version + '판 제안에 모두 동의하면' : '헌장을 제안하고 모두 동의하면') + ' 팀 공간이 열립니다.</p>' + (p.proposal ? lines(p.proposal) : '');
  h += '<p class="note">들어가도 내 개인 원장은 팀에 보이지 않습니다. 내가 고른 행의 고른 필드만 팀 계획에 공유됩니다.</p>'
    + '<p class="inline"><button class="btn primary" id="yes" type="button">' + (p.charter ? '헌장에 동의하고 들어가기' : '들어가기') + '</button><button class="btn" id="no" type="button">거절</button></p>';
  box.innerHTML = h;
  $('yes').onclick = () => api('POST', '/app/api/join', { ...REF, ...(p.charter ? { agree: p.charter.version } : {}) })
    .then(j => { location.href = '/app/t/' + encodeURIComponent(j.space); })
    .catch(e => { if (e.code === 'consent_required') { $('err').textContent = '헌장이 바뀌었습니다. 새 판을 읽도록 다시 엽니다.'; setTimeout(reload, 1200); } else if (e.status === 404) gone(NOT_FOUND); else err(e); });
  $('no').onclick = () => { const b = $('no'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 거절합니다'; return; }
    api('POST', '/app/api/join/decline', REF).then(() => gone('초대를 거절했습니다. 이 초대는 다시 쓸 수 없습니다.')).catch(e => e.status === 404 ? gone(NOT_FOUND) : err(e)); };
}).catch(e => e.status === 404 ? gone(NOT_FOUND) : gone(e.message));`);
  };
  r.get('/join', signed(false), (req: Signed, res) => joinPage(req, res, null));
  r.get('/i/:space/:iid', signed(false), (req: Signed & { params: Record<string, string> }, res) => joinPage(req, res, { space: String(req.params.space), invite: String(req.params.iid) }));

  // ---------------------------------------------------------------- the questionnaire
  r.get('/assess', signed(false), async (req: Signed, res) => {
    const name = await nameOf(req.uid!);
    page(res, '성향 측정', `${header(req.uid!, name)}<main>
<h1>성향 측정 <small>Mini-IPIP 20문항</small></h1>
<p class="sub">${esc(INSTRUCTIONS)}</p>
<form id="q">${MINI_IPIP.map(it => `<fieldset class="item"><legend><span class="n">${it.n}</span> ${esc(it.ko)}</legend>
<div class="scale">${SCALE.map(s => `<label><input type="radio" name="q${it.n}" value="${s.v}" required><span>${esc(s.ko)}</span></label>`).join('')}</div></fieldset>`).join('')}
<p class="err" id="err" role="alert"></p><button class="btn primary" type="submit">점수 보기</button></form>
<section id="out2" class="box" hidden></section>
<p class="note">출처: Donnellan, Oswald, Baird &amp; Lucas (2006), <i>Psychological Assessment</i> 18(2), 192–203. IPIP 문항(공개 도메인, ipip.ori.org). 각 성향은 네 문항의 합(4–20)이며, 다른 사람과 견주는 점수가 아닙니다.</p>
</main>`, `
$('q').onsubmit = e => { e.preventDefault();
  const a = []; for (let i = 1; i <= ${MINI_IPIP.length}; i++) { const v = document.querySelector('input[name=q' + i + ']:checked'); if (!v) { $('err').textContent = i + '번 문항에 답해 주세요'; return; } a.push(+v.value); }
  api('POST', '/app/api/assess', { answers: a }).then(r => { const o = $('out2'); o.hidden = false;
    o.innerHTML = '<h2>내 점수</h2>' + r.traits.map(t => '<div class="trait"><span>' + t.label + '</span><span class="bar" data-pct="' + Math.round((t.score - 4) / 16 * 100) + '"><i></i></span><b>' + t.score + '/20</b></div>').join('') + '<p><a class="btn" href="/app">돌아가기</a></p>';
    bars(); o.scrollIntoView(); }).catch(err); };`);
  });

  // ---------------------------------------------------------------- one team: charter, members, cards
  r.get('/t/:space', signed(false), async (req: Signed & { params: Record<string, string> }, res) => {
    const uid = req.uid!, who = person(uid), id = req.params.space, name = await nameOf(uid);
    const { teams } = await mySpaces(who), me = teams.find(s => s.id === id);
    if (!me) return page(res, '없는 공간', `${header(uid, name)}<main><h1>이 팀 공간을 찾을 수 없습니다</h1><p><a href="/app">내 공간으로</a></p></main>`);
    // one account, many teams (5.3): every team of the person, one tap away, with what waits in each
    const nav = teams.length > 1 ? `<nav class="teams" aria-label="내 팀"><ul>${teams.map(t => `<li><a href="/app/t/${esc(t.id)}"${t.id === id ? ' aria-current="page"' : ''}>${esc(t.name)}${t.waiting?.total ? ` <span class="chip warn">할 일 ${t.waiting.total}</span>` : ''}</a></li>`).join('')}</ul></nav>` : '';
    const ch = me.role === 'guest' ? null : await spaces.charter(who, id);
    const members = me.role === 'guest' ? [] : await spaces.members(who, id);
    const names = new Map(await Promise.all(members.map(async m => [m.uid, await nameOf(m.uid)] as const)));
    let deck: Awaited<ReturnType<Cards['list']>> | null = null, gate = '';
    if (me.role !== 'guest') { try { deck = await cards.list(who, id); } catch (e) { if (e instanceof LedgerError) gate = e.message; else throw e; } }
    const assess = (await cards.mine(who)).assessment, owner = me.role === 'owner';
    const myAnswer = (c: { waiting?: unknown; agreed?: unknown; objected?: unknown }) => Array.isArray(c.waiting) && (c.waiting as string[]).includes(uid);
    const charterHtml = !ch ? '' : `<section class="box"><h2>헌장</h2>
${ch.in_force ? `<p class="note">${ch.in_force.version}판 시행 중</p><ol class="lines">${ch.in_force.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol>
${!(ch.in_force.agreed as { uid: string }[]).some(a => a.uid === uid) ? `<p><button class="btn primary" data-consent="${ch.in_force.version}" data-agree="1" type="button">이 헌장에 동의하고 들어가기</button></p>` : ''}` : '<p>아직 시행 중인 헌장이 없습니다. 모두가 동의하면 팀 공간이 열립니다.</p>'}
${ch.proposal ? `<div class="prop"><p><b>${ch.proposal.version}판 제안</b>${ch.proposal.note ? ` — ${esc(ch.proposal.note)}` : ''}</p><ol class="lines">${ch.proposal.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol>
<p class="note">동의 ${(ch.proposal.agreed as unknown[]).length} · 반대 ${(ch.proposal.objected as unknown[]).length} · 대기 ${(ch.proposal.waiting as unknown[]).length}</p>
${myAnswer(ch.proposal) || (ch.proposal.objected as string[]).includes(uid) ? `<p class="inline"><button class="btn primary" data-consent="${ch.proposal.version}" data-agree="1" type="button">동의</button><button class="btn" data-consent="${ch.proposal.version}" data-agree="0" type="button">반대</button></p>` : '<p class="note">이 제안에 동의했습니다.</p>'}</div>` : `
<details><summary>새 헌장 제안</summary><form id="pp" class="stack"><label for="pl">한 줄에 하나씩, 9줄까지</label><textarea id="pl" rows="6" required></textarea><input id="pn" maxlength="200" placeholder="바꾸는 이유(선택)"><button class="btn" type="submit">제안하기</button></form></details>`}
</section>`;
    const others = members.filter(m => m.role !== 'owner'), heirs = members.filter(m => m.role === 'member');
    // display titles (3.9): words beside a name; the role, not the title, decides what one sees and does
    const myTitle = (await store.membership(id, uid))?.title ?? '';
    const titleForm = `<details><summary>내 직함</summary><form id="tt" class="inline"><input id="ttv" maxlength="${TITLE_MAX}" aria-label="내 직함" value="${esc(myTitle)}" placeholder="예: 공동 창업자, 연구원"><button class="btn" type="submit">저장</button></form>
<p class="note">직함은 이름 옆에 보이는 말일 뿐이고, 볼 수 있는 것과 할 수 있는 것은 역할이 정합니다. 비우고 저장하면 지워집니다.</p></details>`;
    // the owner hands the team over (then can leave it, or delete the account) or deletes it (5.4)
    const ownerTools = !owner ? '' : `${others.length ? `<details><summary>구성원 직함</summary><form id="tto" class="inline"><select id="ttu" aria-label="구성원">${others.map(m => `<option value="${esc(m.uid)}" data-title="${esc(m.title ?? '')}">${esc(names.get(m.uid))}</option>`).join('')}</select><input id="ttw" maxlength="${TITLE_MAX}" aria-label="직함" placeholder="예: 공동 창업자"><button class="btn" type="submit">저장</button></form></details>` : ''}
<details><summary>소유자 넘기기</summary>
${heirs.length ? `<form id="tf" class="inline"><select id="tfu" aria-label="새 소유자">${heirs.map(m => `<option value="${esc(m.uid)}">${esc(names.get(m.uid))}</option>`).join('')}</select><button class="btn" type="submit" id="tfb">넘기기</button></form>
<p class="note">넘기면 나는 멤버가 되고, 구성원 관리·초대·에이전트 위임은 새 소유자가 합니다. 게스트에게는 넘길 수 없습니다.</p>` : '<p class="note">넘길 멤버가 없습니다. 게스트는 소유자가 될 수 없습니다.</p>'}</details>
<details><summary>팀 삭제</summary><p class="note">이 팀의 계획, 헌장, 공유된 행 사본, 카드, 초대, 에이전트 위임이 모두 지워지고 되돌릴 수 없습니다. 구성원 각자의 개인 원장은 그대로입니다.</p>
<form id="td" class="stack"><label for="tdn">확인하려면 팀 이름 <b>${esc(me.name)}</b>을 입력하세요</label><input id="tdn" autocomplete="off"><p><button class="btn danger" id="tdb" type="submit" disabled>팀 삭제</button></p></form></details>`;
    const membersHtml = me.role === 'guest' ? '' : `<section class="box"><h2>구성원</h2><ul class="rows">${members.map(m => `<li><b>${esc(names.get(m.uid))}</b>${m.title ? ` <span class="ttl">${esc(m.title)}</span>` : ''} <span class="chip">${ROLE[m.role]}</span>${m.projects?.length ? ` <span class="note">${esc(m.projects.join(', '))}</span>` : ''}
${owner && m.uid !== uid ? ` <button class="link" data-remove="${esc(m.uid)}" type="button">내보내기</button>` : ''}</li>`).join('')}</ul>
${titleForm}${owner ? (others.length ? `<details><summary>역할 바꾸기</summary><form id="rc" class="inline"><select id="rcu" aria-label="구성원">${others.map(m => `<option value="${esc(m.uid)}">${esc(names.get(m.uid))}</option>`).join('')}</select>
<select id="rcr" aria-label="역할"><option value="member">멤버</option><option value="guest">게스트</option></select><input id="rcp" aria-label="게스트 프로젝트" placeholder="게스트 프로젝트(예: 2026:4.3)"><button class="btn" type="submit">바꾸기</button></form></details>` : '') + ownerTools
  : `<p><button class="link" id="leave" type="button">이 팀에서 나가기</button></p>`}<p class="err" id="terr" role="alert"></p></section>`;
    // invitations (5.3): the owner hands a one-time link to one person or invites an account; joining is theirs to do
    const sent = owner ? await spaces.invites(who, id) : [];
    const sentNames = await namesOf(sent.flatMap(i => i.status === 'joined' ? [i.who!] : []));
    const inviteHtml = !owner ? '' : `<section class="box"><h2>초대</h2>
<p class="note">초대받은 사람이 직접 수락해야 들어옵니다. 초대는 ${INVITE_DAYS}일 뒤 만료되고 한 번만 쓰입니다. 구성원과 열린 초대를 합쳐 ${MAX_PEOPLE}명까지입니다.</p>
<form id="inv" class="stack"><div class="inline"><label for="ir">역할</label><select id="ir"><option value="member">멤버</option><option value="guest">게스트</option></select>
<input id="ip" aria-label="게스트 프로젝트" placeholder="게스트 프로젝트(예: 2026:4.3)" disabled></div>
<p class="inline"><button class="btn primary" type="submit">초대 링크 만들기</button></p>
<div class="inline"><label for="iu">또는 계정 id로</label><input id="iu" placeholder="u_…" autocomplete="off"><button class="btn" type="button" id="iacc">이 계정에 초대 보내기</button></div></form>
<div id="nl" class="prop" hidden><p><b>초대 링크</b> <span class="note">지금 한 번만 보입니다. 초대할 한 사람에게만 보내세요.</span></p><p class="inline"><code id="lk"></code><button class="btn" id="lkcp" type="button">복사</button></p></div>
<h3>보낸 초대</h3>${sent.length ? `<ul class="rows">${sent.slice(0, 12).map(i => sentHtml(i, sentNames)).join('')}</ul>` : '<p class="note">보낸 초대가 없습니다.</p>'}</section>`;
    const cardsHtml = me.role === 'guest' ? '' : `<section class="box"><h2>성향·방향성 카드</h2>
${gate ? `<p class="warn">${esc(gate === 'This team space opens once everyone has agreed to its charter' ? '헌장이 시행되면 카드를 쓸 수 있습니다.' : '헌장에 동의하면 카드를 쓸 수 있습니다.')}</p>` : !deck ? '' : deck.employee_mode ? `<p class="warn">이 팀은 직원 모드라 카드를 쓰지 않습니다.</p>` : `
<p class="note">서로 맞춰 가기 위한 카드입니다. 내가 공개한 항목만큼만 서로 보이고, 순위·평균·평가에 쓰지 않습니다.</p>
${editor(deck.mine as CardView | null, !!assess)}
${deck.mine ? cardHtml(deck.mine as CardView, '내 카드', true) : ''}
${deck.mine ? (deck.cards.length ? `<div class="grid">${(deck.cards as CardView[]).map(c => cardHtml(c, names.get(c.uid) || '구성원', false)).join('')}</div>` : '<p>아직 다른 사람이 공개한 카드가 없습니다.</p>')
  : `<p>${(deck as { others_published?: number }).others_published ?? 0}명이 카드를 공개했습니다. 내 카드를 공개하면 내가 고른 항목만큼 서로 보입니다.</p>`}`}
${owner ? `<details><summary>직원 모드</summary><p class="note">직원이 있는 팀은 동의가 자유롭지 않아 카드를 끕니다. 켜면 이 팀의 카드가 모두 지워집니다.</p>
<p><button class="btn" id="emp" data-on="${deck?.employee_mode ? '0' : '1'}" type="button">${deck?.employee_mode ? '직원 모드 끄기' : '직원 모드 켜기'}</button></p></details>` : ''}
</section>`;
    // the team master agent (4.5): who acts for the team, how the owner delegates and stops it, what waits for a decision
    let agentHtml = '';
    if (me.role !== 'guest' && master && !gate) {
      try {
        const [dels, sum] = await Promise.all([master.delegations(who, id), master.summary(who, id)]);
        const live = dels.filter(d => d.active), waiting = sum && 'to_decide' in sum ? (sum.to_decide ?? 0) + (sum.drafts ?? 0) : 0;
        const byName = new Map(await Promise.all([...new Set(live.map(d => d.by))].map(async u => [u, await nameOf(u)] as const)));
        const addr = `${cfg.publicUrl}/mcp/t/${id}/agent`;
        agentHtml = `<section class="box"><h2>팀 마스터 에이전트</h2>
<p class="note">팀을 대신해 팀 요약본(이름 없는 계획 대비 실적, 의도 정렬 수치, 주간 브리핑, 헌장)만 읽고, 계획 변경과 주간 보고를 제안합니다. 반영은 사람이 승인해야 합니다. 누구의 개인 원장·카드·열람 기록도 읽지 못합니다.</p>
${live.length ? `<ul class="rows">${live.map(d => `<li><b>${esc(d.client_name)}</b> <span class="note">${esc(d.since)}부터 · ${esc(byName.get(d.by) ?? '')} 위임${d.last ? ` · 마지막 제안 ${esc(d.last)}` : ''}</span>${owner ? ` <button class="link" type="button" data-stop="${esc(d.client_id)}">중단</button>` : ''}</li>`).join('')}</ul>` : '<p>위임된 에이전트가 없습니다.</p>'}
${owner ? `<details><summary>에이전트 위임하기</summary><p>이 주소로 커넥터를 추가하고, 열리는 동의 화면에서 이 팀의 소유자 계정으로 허용하면 위임됩니다.</p>
<p class="inline"><code id="agurl">${esc(addr)}</code><button class="btn" id="agcp" type="button">주소 복사</button></p>
<ol class="lines"><li>Claude: Customize &gt; Connectors &gt; + &gt; Add custom connector &gt; 이름 <code>PP WBS · ${esc(me.name)} 마스터</code> &gt; 이 주소 &gt; Add &gt; Connect</li>
<li>매주 월요일 브리핑이 나온 뒤 "지난주 주간 보고 초안을 올려 줘"를 예약해 두면, 사람은 여기서 승인만 합니다.</li></ol></details>` : ''}
<p><a class="btn${waiting ? ' primary' : ''}" href="/app/t/${esc(id)}/agent">${waiting ? `승인할 것 ${waiting}건` : '제안과 주간 보고 보기'}</a></p></section>`;
      } catch (e) { if (!(e instanceof LedgerError)) throw e; }
    }
    // the team plan as the team's own CSV copy (3.10): the hub holds the original; offered once the charter gate lets the
    // person read the plan (a charter in force, agreed by owners and members), as every plan read
    const planHtml = plans && me.charter?.in_force && !me.charter.needs_consent ? `<section class="box"><h2>팀 계획 사본</h2>
<p>허브가 원본이고, 이 파일은 팀이 정한 곳(드라이브, 저장소)에 두는 복제본입니다. 계획 항목마다 실적과 표시를 담습니다${me.role === 'guest' ? '(배정된 프로젝트만)' : ''}.</p>
<p><a class="btn" href="/app/t/${esc(id)}/plan.csv" download>plan.csv 내려받기</a></p></section>` : '';
    const guestHtml = me.role === 'guest' ? `<section class="box"><p>게스트로 속한 팀입니다. 배정된 프로젝트의 계획과 작업은 에이전트나 대시보드에서 봅니다.</p>${titleForm}<p class="err" id="terr" role="alert"></p></section>` : '';
    page(res, me.name, `${header(uid, name)}<main><p><a href="/app">← 내 공간</a></p>${nav}<h1>${esc(me.name)} <span class="chip">${ROLE[me.role]}</span></h1>
${guestHtml}${charterHtml}${membersHtml}${planHtml}${inviteHtml}${agentHtml}${cardsHtml}</main>`, `
const S = ${js(id)}, base = '/app/api/t/' + S;
document.querySelectorAll('[data-consent]').forEach(b => { b.onclick = () => api('POST', base + '/charter/consent', { version: +b.dataset.consent, agree: b.dataset.agree === '1' }).then(reload).catch(err); });
if ($('pp')) $('pp').onsubmit = e => { e.preventDefault(); api('POST', base + '/charter/propose', { lines: $('pl').value.split('\\n').map(s => s.trim()).filter(Boolean), note: $('pn').value }).then(reload).catch(err); };
document.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 내보냅니다'; return; } api('DELETE', base + '/members/' + encodeURIComponent(b.dataset.remove)).then(reload).catch(err); }; });
const projects = el => el.value.split(',').map(s => s.trim()).filter(Boolean);
if ($('rc')) $('rc').onsubmit = e => { e.preventDefault(); const g = $('rcr').value === 'guest'; api('POST', base + '/members', { uid: $('rcu').value, role: $('rcr').value, ...(g ? { projects: projects($('rcp')) } : {}) }).then(reload).catch(err); };
if ($('inv')) {
  const role = () => $('ir').value, body = () => ({ role: role(), ...(role() === 'guest' ? { projects: projects($('ip')) } : {}) });
  $('ir').onchange = () => { $('ip').disabled = role() !== 'guest'; };
  $('inv').onsubmit = e => { e.preventDefault(); api('POST', base + '/invites', body()).then(r => {   // the code is shown once, in the fragment: never sent to the server again in a URL
    $('lk').textContent = location.origin + '/app/join#' + r.code; $('nl').hidden = false; $('lkcp').focus(); }).catch(err); };
  $('lkcp').onclick = () => copy($('lk'), $('lkcp'));
  $('iacc').onclick = () => { const u = $('iu').value.trim(); if (!u) { $('iu').focus(); return; } api('POST', base + '/invites', { ...body(), for: u }).then(reload).catch(err); };
}
document.querySelectorAll('[data-revoke]').forEach(b => { b.onclick = () => api('DELETE', base + '/invites/' + encodeURIComponent(b.dataset.revoke)).then(reload).catch(err); });
const terr = e => { $('terr').textContent = e.message; };
if ($('tt')) $('tt').onsubmit = e => { e.preventDefault(); api('POST', base + '/title', { title: $('ttv').value }).then(reload).catch(terr); };
if ($('tto')) { const u = $('ttu'), w = $('ttw'), fill = () => { w.value = u.selectedOptions[0].dataset.title || ''; };
  u.onchange = fill; fill();
  $('tto').onsubmit = e => { e.preventDefault(); api('POST', base + '/title', { uid: u.value, title: w.value }).then(reload).catch(terr); }; }
if ($('tf')) $('tf').onsubmit = e => { e.preventDefault(); const b = $('tfb');
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 넘깁니다'; return; }
  api('POST', base + '/transfer', { to: $('tfu').value }).then(reload).catch(terr); };
if ($('td')) { const n = $('tdn'), b = $('tdb'), want = ${js(me.name)};
  n.oninput = () => { b.disabled = n.value.trim() !== want; };
  $('td').onsubmit = e => { e.preventDefault(); if (b.disabled) return; b.disabled = true;
    api('POST', base + '/delete', { name: n.value.trim() }).then(() => { location.href = '/app'; }).catch(x => { b.disabled = false; terr(x); }); }; }
if ($('leave')) $('leave').onclick = () => { const b = $('leave'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 나갑니다(공유한 행은 팀에 고정된 사본으로 남음)'; return; } api('POST', base + '/leave').then(() => { location.href = '/app'; }).catch(err); };
if ($('card')) $('card').onsubmit = e => { e.preventDefault();
  const v = id => ($(id) || {}).value || '', sections = [...document.querySelectorAll('input[name=sec]:checked')].map(x => x.value);
  api('POST', base + '/card', { sections, direction: { role: v('dr'), grow: v('dg'), ask: v('da') }, rebuttal: { traits: v('rt'), work: v('rw'), direction: v('rd') } }).then(reload).catch(err); };
if ($('wd')) $('wd').onclick = () => api('DELETE', base + '/card').then(reload).catch(err);
if ($('agcp')) $('agcp').onclick = () => copy($('agurl'), $('agcp'));
document.querySelectorAll('[data-stop]').forEach(b => { b.onclick = () => { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 바로 중단합니다'; return; } api('POST', base + '/agent/stop', { client_id: b.dataset.stop }).then(reload).catch(err); }; });
if ($('emp')) $('emp').onclick = () => { const b = $('emp'); if (b.dataset.on === '1' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 카드가 모두 지워집니다'; return; } api('POST', base + '/employee-mode', { on: b.dataset.on === '1' }).then(reload).catch(err); };`);
  });

  // ---------------------------------------------------------------- the team master agent: approvals (4.5)
  const gateMsg = (e: unknown) => e instanceof LedgerError ? (/charter/i.test(e.message) ? '헌장에 동의하면 볼 수 있습니다.' : e.message) : null;
  const STATUS_KO: Record<string, string> = { open: '결정 대기', applied: '반영됨', declined: '반려', stale: '계획이 바뀌어 무효', withdrawn: '철회', proposed: '승인 대기', approved: '승인됨' };
  r.get('/t/:space/agent', signed(false), async (req: Signed & { params: Record<string, string> }, res) => {
    const uid = req.uid!, who = person(uid), id = req.params.space, name = await nameOf(uid);
    const sp0 = (await spaces.list(who)).find(s => s.id === id) as { id: string; name: string; role: string } | undefined;
    const shell = (body: string, script = '') => page(res, '팀 마스터 에이전트', `${header(uid, name)}<main><p><a href="/app/t/${esc(id)}">← ${esc(sp0?.name ?? '팀')}</a></p><h1>팀 마스터 에이전트 <small>제안과 승인</small></h1>${body}<p class="err" id="err" role="alert"></p></main>`,
      `const S = ${js(id)}, base = '/app/api/t/' + S;\n${script}`);
    if (!sp0 || sp0.role === 'guest' || !master) return shell('<section class="box"><p>팀의 소유자와 멤버가 봅니다.</p></section>');
    let L: Awaited<ReturnType<MasterAgent['list']>>;
    try { L = await master.list(who, id); } catch (e) { const m = gateMsg(e); if (m === null) throw e; return shell(`<section class="box"><p class="warn">${esc(m)}</p></section>`); }
    const people = L as Extract<typeof L, { open: unknown }>;
    const uids = new Set<string>(); people.open.forEach(p => p.approvers.forEach(a => uids.add(a.uid))); people.decided.forEach(p => p.approvers.forEach(a => uids.add(a.uid)));
    const names = new Map(await Promise.all([...uids].map(async u => [u, await nameOf(u)] as const)));
    const changes = (p: { preview: { code: string; created: boolean; changes: string[] }[] }) => `<ul class="rows">${p.preview.map(v => `<li><code>${esc(v.code)}</code> ${v.created ? '<span class="chip">새 항목</span> ' : ''}${esc(v.changes.join(', '))}</li>`).join('')}</ul>`;
    const approvers = (p: { approvers: { uid: string; decided: string | null }[] }) => `<p class="note">결정할 사람: ${p.approvers.map(a => `${esc(names.get(a.uid) ?? a.uid)}(${a.decided === 'approve' ? '승인' : a.decided === 'decline' ? '반려' : '대기'})`).join(', ')}</p>`;
    const decideForm = (attr: string, v: string) => `<div class="inline"><input data-note-for="${esc(v)}" maxlength="300" aria-label="메모(선택)" placeholder="메모(선택)"><button class="btn primary" type="button" ${attr}="${esc(v)}" data-approve="1">승인</button><button class="btn" type="button" ${attr}="${esc(v)}" data-approve="0">반려</button></div>`;
    const drafts = people.drafts.length ? `<section class="box"><h2>승인 기다리는 주간 보고</h2>${people.drafts.map(r0 => `<div class="card"><h3>${esc(r0.week)} <span class="chip">${esc(r0.client)} 작성</span></h3>
<p class="pre">${esc(r0.text)}</p>${r0.recommendations.length ? `<h3>권고</h3><ol class="lines">${r0.recommendations.map(x => `<li>${esc(x.text)}</li>`).join('')}</ol>` : ''}
<p class="note">승인하면 팀 전체가 주간 브리핑 옆에서 봅니다.</p>${decideForm('data-week', r0.week)}</div>`).join('')}</section>` : '';
    const open = `<section class="box"><h2>열린 제안</h2>${people.open.length ? people.open.map(p => `<div class="card"><h3>${esc(p.client)} 제안 <span class="note">${esc(p.at)}</span></h3>
<p>${esc(p.why)}</p>${changes(p)}${approvers(p)}${p.mine_to_decide ? decideForm('data-pid', p.id) : ''}</div>`).join('') : '<p>결정을 기다리는 제안이 없습니다.</p>'}</section>`;
    const reports = people.reports.length ? `<section class="box"><h2>승인된 주간 보고</h2>${people.reports.map(r0 => `<details><summary>${esc(r0.week)} · ${esc(r0.client)} 작성</summary><p class="pre">${esc(r0.text)}</p>${r0.recommendations.length ? `<ol class="lines">${r0.recommendations.map(x => `<li>${esc(x.text)}</li>`).join('')}</ol>` : ''}</details>`).join('')}</section>` : '';
    const past = people.decided.length ? `<section class="box"><h2>지난 결정</h2><ul class="rows">${people.decided.map(p => `<li><span class="chip">${STATUS_KO[p.status] ?? esc(p.status)}</span> ${esc(p.preview.map(v => v.code).join(', '))} — ${esc(p.why)}${p.note ? ` <span class="note">${esc(p.note)}</span>` : ''}</li>`).join('')}</ul></section>` : '';
    shell(`${drafts}${open}${reports}${past}`, `
document.querySelectorAll('[data-pid]').forEach(b => { b.onclick = () => { const n = document.querySelector('[data-note-for="' + b.dataset.pid + '"]');
  api('POST', base + '/proposals/' + encodeURIComponent(b.dataset.pid) + '/decide', { approve: b.dataset.approve === '1', note: n ? n.value : '' }).then(reload).catch(err); }; });
document.querySelectorAll('[data-week]').forEach(b => { b.onclick = () => { const n = document.querySelector('[data-note-for="' + b.dataset.week + '"]');
  api('POST', base + '/reports/' + encodeURIComponent(b.dataset.week) + '/decide', { approve: b.dataset.approve === '1', note: n ? n.value : '' }).then(reload).catch(err); }; });`);
  });

  // ---------------------------------------------------------------- the API the pages call
  const api = express.Router();
  api.use(signed(true), sameSite, json);
  api.post('/spaces', act((who, req) => spaces.create(who, String(req.body?.name || ''))));
  api.post('/assess', act((who, req) => cards.assess(who, Array.isArray(req.body?.answers) ? req.body.answers.map(Number) : [])));
  const sp = (req: Request) => String(req.params.space);
  api.post('/t/:space/charter/propose', act((who, req) => spaces.proposeCharter(who, sp(req), z.array(z.string()).parse(req.body?.lines), String(req.body?.note || ''))));
  api.post('/t/:space/charter/consent', act((who, req) => spaces.consentCharter(who, sp(req), Number(req.body?.version), req.body?.agree === true)));
  api.post('/t/:space/members', act((who, req) => {
    const b = z.object({ uid: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/), role: z.enum(['member', 'guest']), projects: z.array(z.string()).max(20).optional() }).parse(req.body);
    return spaces.setMember(who, sp(req), b.uid, b.role, b.role === 'guest' ? b.projects : undefined);
  }));
  api.delete('/t/:space/members/:uid', act((who, req) => spaces.removeMember(who, sp(req), String(req.params.uid))));
  // invitations (5.3): the owner sends, the invited person reads and answers
  api.post('/t/:space/invites', act((who, req) => {
    const b = z.object({ role: z.enum(['member', 'guest']), projects: z.array(z.string()).max(20).optional(), for: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/).optional() }).parse(req.body);
    return spaces.invite(who, sp(req), { role: b.role, projects: b.role === 'guest' ? b.projects : undefined, for: b.for });
  }));
  api.get('/t/:space/invites', act((who, req) => spaces.invites(who, sp(req))));
  api.delete('/t/:space/invites/:iid', act((who, req) => spaces.revoke(who, sp(req), String(req.params.iid))));
  const refOf = (b: unknown): InviteRef => { const o = (b ?? {}) as Record<string, unknown>; return typeof o.code === 'string' ? { code: o.code } : { space: String(o.space ?? ''), invite: String(o.invite ?? '') }; };
  api.post('/invites/preview', act(async (who, req) => { const p = await spaces.preview(who, refOf(req.body)); return { ...p, by_name: await nameOf(p.by) }; }));
  api.post('/join', act((who, req) => spaces.join(who, refOf(req.body), req.body?.agree === undefined ? undefined : Number(req.body.agree))));
  api.post('/join/decline', act((who, req) => spaces.decline(who, refOf(req.body))));
  api.post('/t/:space/leave', act((who, req) => spaces.removeMember(who, sp(req), (who as { uid: string }).uid)));
  api.post('/t/:space/title', act((who, req) => spaces.setTitle(who, sp(req), String(req.body?.uid || (who as { uid: string }).uid), String(req.body?.title ?? ''))));
  api.post('/t/:space/transfer', act((who, req) => spaces.transfer(who, sp(req), String(req.body?.to || ''))));
  api.post('/t/:space/delete', act(async (who, req) => {   // the team's name, typed: deleting a team is never one stray click
    const s = (await spaces.list(who)).find(x => x.id === sp(req)) as { name?: string } | undefined;
    if (!s || String(req.body?.name ?? '').trim() !== s.name) throw new LedgerError('invalid', 'Type the team\'s name to delete it');
    return spaces.remove(who, sp(req));
  }));
  // the account (5.4): the person's own act, on this page only; the tombstone stops every earlier token and session
  api.post('/account/delete', act(async (who, req, res) => {
    if (String(req.body?.confirm ?? '').trim() !== DELETE_PHRASE) throw new LedgerError('invalid', `Type "${DELETE_PHRASE}" to delete the account`);
    const out = await spaces.deleteAccount(req.uid!, { withShared: req.body?.with_shared === true });
    revocations?.note(req.uid!, out.at);
    setCookie(res, '', 0);
    return out;
  }));
  api.post('/t/:space/card', act((who, req) => cards.publish(who, sp(req), req.body)));
  api.delete('/t/:space/card', act((who, req) => cards.withdraw(who, sp(req))));
  api.get('/t/:space/cards', act((who, req) => cards.list(who, sp(req))));
  api.post('/t/:space/employee-mode', act((who, req) => cards.setEmployeeMode(who, sp(req), req.body?.on === true)));
  if (master) {
    api.post('/t/:space/agent/stop', act((who, req) => master.stop(who, sp(req), String(req.body?.client_id || ''))));
    api.post('/t/:space/proposals/:pid/decide', act((who, req) => master.decide(who, sp(req), String(req.params.pid), req.body?.approve === true, String(req.body?.note || ''))));
    api.post('/t/:space/reports/:week/decide', act((who, req) => master.decideReport(who, sp(req), String(req.params.week), req.body?.approve === true, String(req.body?.note || ''))));
  }
  r.use('/api', api);
  return r;
}

const ROLE: Record<string, string> = { owner: '소유자', member: '멤버', guest: '게스트' };
type TeamEntry = { id: string; kind: 'team'; name: string; role: string; projects?: string[];
  charter?: { in_force: number | null; needs_consent: boolean; proposal: { version: number; answered: boolean } | null };
  waiting?: { charter: number; decide: number; drafts: number; total: number } };
type InviteEntry = { kind: 'invite'; space: string; invite: string; name: string; role: 'member' | 'guest'; projects?: string[]; by: string; expires: number };
/** What waits for the person in a team, as chips: the charter's state, then decisions (plan proposals, weekly reports). */
function chips(t: TeamEntry) {
  const c = t.charter, state = !c ? '' : c.in_force === null ? '헌장 합의 전' : c.needs_consent ? '헌장 동의 필요' : c.proposal && !c.proposal.answered ? '헌장 제안에 답할 차례' : '';
  const n = (t.waiting?.decide ?? 0) + (t.waiting?.drafts ?? 0);
  return `${state ? ` <span class="chip warn">${state}</span>` : ''}${n ? ` <span class="chip warn">승인할 것 ${n}건</span>` : ''}`;
}
/** An invitation as its owner sees it, and the time it lapses or closed. A pending account invitation shows only the
 *  account id the owner typed, never the stored name: a person's name reaches a team when they join. */
function sentHtml(i: { id: string; kind: 'link' | 'account'; role: string; projects?: string[]; for?: string; status: string; expires: number; who?: string; closed?: number }, names: Map<string, string>) {
  const target = i.kind === 'link' ? '링크' : i.status === 'joined' ? esc(names.get(i.for!)) : `계정 <code>${esc(i.for!.slice(0, 10))}</code>`;
  const st = i.status === 'open' ? `${ymd(i.expires)}까지 열림` : i.status === 'expired' ? '만료' : i.status === 'joined' ? `${i.kind === 'link' ? `${esc(names.get(i.who!))} ` : ''}참여 · ${ymd(i.closed!)}`
    : i.status === 'declined' ? `거절 · ${ymd(i.closed!)}` : `취소함 · ${ymd(i.closed!)}`;
  return `<li><span class="chip">${ROLE[i.role]}</span> ${target}${i.projects?.length ? ` <span class="note">${esc(i.projects.join(', '))}</span>` : ''} <span class="note">· ${st}</span>${i.status === 'open' ? ` <button class="link" type="button" data-revoke="${esc(i.id)}">취소</button>` : ''}</li>`;
}

type CardView = { uid: string; sections: CardSection[]; measured: number; stale: boolean; traits: { trait: string; label: string; score: number; of: number }[];
  direction?: { role: string; grow: string; ask: string }; work: { line: string; rows: number }; rebuttal: { traits?: string; work?: string; direction?: string } };

function traitBars(traits: { label: string; score: number }[]) {
  return `<div class="traits">${traits.map(t => `<div class="trait"><span>${esc(t.label)}</span><span class="bar" role="img" aria-label="${esc(t.label)} ${t.score}/20" data-pct="${Math.round((t.score - 4) / 16 * 100)}"><i></i></span><b>${t.score}/20</b></div>`).join('')}</div>`;
}

function cardHtml(c: CardView, title: string, mine: boolean) {
  const d = c.direction, rb = (t?: string) => t ? `<p class="rebut"><span>본인 반론</span> ${esc(t)}</p>` : '';
  return `<article class="card${mine ? ' mine' : ''}"><h3>${esc(title)}</h3>
${c.traits.length ? `${traitBars(c.traits)}<p class="note">${c.measured ? `${ymd(c.measured)} 자기 보고` : ''}${c.stale ? ' · 반년 넘음' : ''}</p>${rb(c.rebuttal.traits)}` : ''}
${d ? `<dl class="dir">${d.role ? `<dt>1년 뒤 맡고 싶은 역할</dt><dd>${esc(d.role)}</dd>` : ''}${d.grow ? `<dt>키우고 싶은 것</dt><dd>${esc(d.grow)}</dd>` : ''}${d.ask ? `<dt>팀에 바라는 것</dt><dd>${esc(d.ask)}</dd>` : ''}</dl>${rb(c.rebuttal.direction)}` : ''}
<p class="work"><span class="chip">추론</span> ${esc(c.work.rows ? c.work.line : '이 팀에 공유한 행이 아직 없습니다')} <span class="note">· 이 팀에 공유한 행만</span></p>${rb(c.rebuttal.work)}
</article>`;
}

function editor(mine: CardView | null, assessed: boolean) {
  const on = new Set<CardSection>(mine?.sections ?? DEFAULT_SECTIONS), d = mine?.direction, rb = mine?.rebuttal ?? {};
  const box = (s: CardSection) => `<label class="ck"><input type="checkbox" name="sec" value="${s}"${on.has(s) ? ' checked' : ''}${s !== 'direction' && !assessed ? ' disabled' : ''}><span>${esc(SECTION_KO[s])}</span></label>`;
  return `<details${mine ? '' : ' open'}><summary>${mine ? '내 카드 고치기' : '내 카드 공개하기'}</summary>
${assessed ? '' : '<p class="warn">성향 점수를 실으려면 먼저 <a href="/app/assess">20문항에 답하세요</a>. 방향성만 공개할 수도 있습니다.</p>'}
<form id="card" class="stack"><fieldset class="secs"><legend>보일 항목 (정서 안정성은 고를 때만)</legend>${[...TRAITS, 'direction' as const].map(s => box(s)).join('')}</fieldset>
<label for="dr">1년 뒤 맡고 싶은 역할</label><input id="dr" maxlength="160" value="${esc(d?.role)}">
<label for="dg">키우고 싶은 것</label><input id="dg" maxlength="160" value="${esc(d?.grow)}">
<label for="da">팀에 바라는 것</label><input id="da" maxlength="160" value="${esc(d?.ask)}">
<details><summary>반론 (카드 옆에 함께 보임)</summary>
<label for="rt">성향 점수에 대해</label><input id="rt" maxlength="300" value="${esc(rb.traits)}">
<label for="rw">작업 지표(추론)에 대해</label><input id="rw" maxlength="300" value="${esc(rb.work)}">
<label for="rd">방향성에 대해</label><input id="rd" maxlength="300" value="${esc(rb.direction)}"></details>
<p class="err" id="err" role="alert"></p>
<p class="inline"><button class="btn primary" type="submit">${mine ? '고친 내용 공개' : '공개하기'}</button>${mine ? '<button class="btn" id="wd" type="button">카드 내리기</button>' : ''}</p></form></details>`;
}

const BASE_JS = `
const $ = id => document.getElementById(id);
const api = (method, path, body) => fetch(path, { method, credentials: 'same-origin', headers: { 'x-ppwbs': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.message || j.error || ('HTTP ' + r.status)), { status: r.status, code: j.error }); return j; });
const err = e => { const el = $('err') || document.querySelector('.err'); if (el) el.textContent = e.message; };
const reload = () => location.reload();
const copy = (el, btn) => { try { navigator.clipboard.writeText(el.textContent).then(() => { btn.textContent = '복사됨'; }, () => sel(el)); } catch (e) { sel(el); } };
const sel = el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
if ($('out')) $('out').onclick = () => api('POST', '/app/logout').then(() => { location.href = '/app'; });
// bar lengths are set here, not in style attributes: the page's policy allows no inline styles
const bars = () => document.querySelectorAll('.bar[data-pct] > i').forEach(i => { i.style.width = Math.max(0, Math.min(100, +i.parentNode.dataset.pct)) + '%'; });
bars();
`;

const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --fg: #1d2330; --muted: #5b6475; --line: #dfe3ea; --accent: #2f5bd3; --on-accent: #fff; --warn: #a33a1f; --bar: #2f5bd3; --track: #e7eaf0; color-scheme: light }
@media (prefers-color-scheme: dark) { :root { --bg: #12151b; --card: #1a1f27; --fg: #e8ebf1; --muted: #a2abbb; --line: #2c3340; --accent: #7c9cff; --on-accent: #0d1220; --warn: #ff9b7a; --bar: #7c9cff; --track: #2c3340; color-scheme: dark } }
* { box-sizing: border-box } body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif }
.top { display: flex; align-items: center; gap: 12px; padding: 10px max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left)); border-bottom: 1px solid var(--line); background: var(--card) }
.brand { font-weight: 700; color: var(--fg); text-decoration: none } .me { margin-left: auto; color: var(--muted); font-size: 13.5px }
main { max-width: 860px; margin: 0 auto; padding: 20px max(16px, env(safe-area-inset-right)) 48px max(16px, env(safe-area-inset-left)); display: grid; gap: 16px }
main.narrow { max-width: 440px; margin-top: 8vh } h1 { font-size: 22px; margin: 0; text-wrap: balance } h1 small { font-size: 14px; color: var(--muted); font-weight: 400 }
h2 { font-size: 16px; margin: 0 0 8px } h3 { font-size: 15px; margin: 0 0 8px } p { margin: 0 0 8px } a { color: var(--accent) }
.sub, .note { color: var(--muted); font-size: 13.5px } .ttl { color: var(--muted) } .warn { color: var(--warn) } b.warn { font-weight: 600 }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0 }
.stack { display: grid; gap: 8px } .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
.btn { min-height: 40px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; padding: 0 14px; font: inherit; display: inline-flex; align-items: center; text-decoration: none }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600 }
.btn.danger { background: var(--warn); color: var(--on-accent); border-color: var(--warn); font-weight: 600 } .btn:disabled { opacity: .45; cursor: not-allowed }
.link { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 4px; min-height: 32px }
input, textarea, select { font: inherit; min-height: 40px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 6px 10px; width: 100%; min-width: 0 }
.inline input { width: auto; flex: 1 1 180px } .inline select { width: auto } textarea { min-height: 120px }
.err { color: var(--warn); min-height: 1.4em; font-size: 13.5px } code { font-family: ui-monospace, monospace; font-size: 13px; overflow-wrap: anywhere }
.chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted) } .chip.warn { color: var(--warn); border-color: var(--warn) }
.rows { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px } .lines { margin: 0 0 8px; padding-left: 22px }
.prop { border-top: 1px dashed var(--line); padding-top: 10px; margin-top: 8px } .box > h3 { margin-top: 14px }
details > summary { cursor: pointer; color: var(--accent); min-height: 36px; display: flex; align-items: center }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0 } legend { padding: 0; font-weight: 600 }
.item { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 0 0 10px }
.item legend { float: left; width: 100% } .item .scale { clear: both }   /* the legend inside the box, not on its border */
.item .n { display: inline-grid; place-items: center; min-width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--line); font-size: 12px; margin-right: 4px; font-variant-numeric: tabular-nums }
.scale { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 10px }
.scale label { display: grid; justify-items: center; gap: 4px; text-align: center; font-size: 12.5px; color: var(--muted); cursor: pointer; padding: 6px 2px; border-radius: 8px; border: 1px solid transparent }
.scale input { width: 20px; min-height: 20px; height: 20px; margin: 0 } .scale label:has(input:checked) { border-color: var(--accent); color: var(--fg) }
.traits { display: grid; gap: 6px; margin: 0 0 6px } .trait { display: grid; grid-template-columns: 7.5em 1fr 3.5em; gap: 10px; align-items: center; font-size: 14px }
.trait b { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600 } .bar { height: 8px; border-radius: 4px; background: var(--track); overflow: hidden } .bar i { display: block; height: 100%; background: var(--bar) }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 12px }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--card); min-width: 0 } .card.mine { border-color: var(--accent); margin-bottom: 12px }
.dir { margin: 6px 0; display: grid; gap: 2px } .dir dt { color: var(--muted); font-size: 12.5px } .dir dd { margin: 0 0 4px }
.work { font-size: 13.5px; margin: 8px 0 4px } .rebut { font-size: 13px; margin: 2px 0 6px; padding-left: 8px; border-left: 3px solid var(--line) } .rebut span { color: var(--muted) }
.secs { display: flex; flex-wrap: wrap; gap: 4px 14px } .secs legend { width: 100%; margin-bottom: 4px; font-weight: 400; color: var(--muted); font-size: 13.5px }
.ck { display: inline-flex; gap: 6px; align-items: center; min-height: 32px } .ck input { width: 18px; min-height: 18px; height: 18px }
.pre { white-space: pre-wrap; overflow-wrap: anywhere } h2 small { font-weight: 400; color: var(--muted); font-size: 13px } .card + .card { margin-top: 10px }
.teams ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px }
.teams a { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--fg); text-decoration: none }
.teams a[aria-current="page"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); font-weight: 600 }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
@media (max-width: 520px) { .scale { gap: 2px } .scale label { font-size: 11.5px; padding: 6px 0; word-break: keep-all } .item { padding: 10px } .trait { grid-template-columns: 6.5em 1fr 3.2em } }`;

export { SECTION_KO, CARD_SECTIONS };
