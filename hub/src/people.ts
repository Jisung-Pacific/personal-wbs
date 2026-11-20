// The hub's own pages for people (/app): what only a person may do, by their own hand, never through an agent — make a
// team space, propose and agree to its charter, add and remove members, leave, answer the Big Five questions and
// publish, change or withdraw one's work-style and direction card (execution WBS 4.2). An agent's OAuth token cannot
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
import { LedgerError } from './wbs/service.js';
import type { Spaces } from './wbs/spaces.js';
import { Cards, DEFAULT_SECTIONS, INSTRUCTIONS, MINI_IPIP, SCALE, TRAIT_KO } from './wbs/cards.js';
import type { MasterAgent } from './wbs/master.js';

const FIREBASE_SDK = '12.19.0';   // the same pinned compat builds as the consent page
const SESSION_TTL = 8 * 3600;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const ymd = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);   // KST, like the ledger
const SECTION_KO: Record<CardSection, string> = { ...TRAIT_KO, direction: '방향성' };

export interface PeopleDeps { cfg: Config; store: Store; issuer: TokenIssuer; verifyIdToken: VerifyIdToken; spaces: Spaces; cards: Cards; master?: MasterAgent }
type Signed = Request & { uid?: string };

export function peopleRouter({ cfg, store, issuer, verifyIdToken, spaces, cards, master }: PeopleDeps): Router {
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

  /** The signed-in person, from the session cookie; pages without one show the sign-in page, the API answers 401. */
  const signed = (api: boolean) => async (req: Signed, res: Response, next: NextFunction) => {
    const t = cookieOf(req);
    if (t) { try { req.uid = await issuer.verifySession(t); return next(); } catch { /* expired or foreign: sign in again */ } }
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
  const act = (f: (who: Caller, req: Signed) => Promise<unknown>) => (req: Signed, res: Response) => {
    f(person(req.uid!), req).then(v => res.json(v ?? { ok: true })).catch(e => {
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
  const header = (uid: string, name: string) => `<header class="top"><a class="brand" href="/app">PP WBS Hub</a><span class="me">${esc(name)}</span>
<button class="link" id="out" type="button">로그아웃</button></header>`;

  // ---------------------------------------------------------------- home: my spaces and my measurement
  r.get('/', signed(false), async (req: Signed, res) => {
    const uid = req.uid!, who = person(uid), [list, mine, name] = await Promise.all([spaces.list(who), cards.mine(who), nameOf(uid)]);
    const teams = list.filter(s => s.kind === 'team') as { id: string; name: string; role: string; charter?: { in_force: number | null; needs_consent: boolean; proposal: { version: number; answered: boolean } | null } }[];
    const ROLE: Record<string, string> = { owner: '소유자', member: '멤버', guest: '게스트' };
    const state = (t: typeof teams[number]) => !t.charter ? '' : t.charter.in_force === null ? '헌장 합의 전' : t.charter.needs_consent ? '헌장 동의 필요'
      : t.charter.proposal && !t.charter.proposal.answered ? '헌장 제안에 답할 차례' : '';
    page(res, '내 공간', `${header(uid, name)}<main>
<h1>내 공간</h1>
<section class="box"><h2>성향 측정</h2>
${mine.assessment ? `<p>${ymd(mine.assessment.at)} 측정${mine.assessment.stale ? ' · <b class="warn">반년이 지났습니다. 다시 측정해 주세요</b>' : ''}</p>${traitBars(mine.assessment.traits)}` : '<p>아직 측정하지 않았습니다. 카드에 성향을 싣으려면 먼저 20문항(약 3분)에 답하세요.</p>'}
<p><a class="btn primary" href="/app/assess">${mine.assessment ? '다시 측정' : '측정하기'}</a></p>
<p class="note">점수는 내 공간에만 남고, 팀에는 내가 카드에 고른 항목만 갑니다. 답 자체는 저장하지 않습니다.</p></section>
<section class="box"><h2>팀 공간</h2>
${teams.length ? `<ul class="rows">${teams.map(t => `<li><a href="/app/t/${esc(t.id)}"><b>${esc(t.name)}</b></a> <span class="chip">${ROLE[t.role] ?? esc(t.role)}</span>${state(t) ? ` <span class="chip warn">${state(t)}</span>` : ''}</li>`).join('')}</ul>` : '<p>아직 속한 팀 공간이 없습니다.</p>'}
<form id="mk" class="inline"><label for="nm">새 팀 공간</label><input id="nm" maxlength="60" placeholder="팀 이름" required><button class="btn" type="submit">만들기</button></form></section>
<section class="box"><h2>내 계정 id</h2><p>팀 소유자에게 이 id를 보내면 그 팀에 멤버로 추가할 수 있습니다.</p>
<p class="inline"><code id="myid">${esc(uid)}</code><button class="btn" id="cp" type="button">복사</button></p></section>
</main>`, `
$('mk').onsubmit = e => { e.preventDefault(); api('POST', '/app/api/spaces', { name: $('nm').value }).then(s => { location.href = '/app/t/' + s.id; }).catch(err); };
$('cp').onclick = () => copy($('myid'), $('cp'));`);
  });

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
    const all = await spaces.list(who), me = all.find(s => s.id === id) as { id: string; name: string; role: string } | undefined;
    if (!me) return page(res, '없는 공간', `${header(uid, name)}<main><h1>이 팀 공간을 찾을 수 없습니다</h1><p><a href="/app">내 공간으로</a></p></main>`);
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
    const ROLE: Record<string, string> = { owner: '소유자', member: '멤버', guest: '게스트' };
    const membersHtml = me.role === 'guest' ? '' : `<section class="box"><h2>구성원</h2><ul class="rows">${members.map(m => `<li><b>${esc(names.get(m.uid))}</b> <span class="chip">${ROLE[m.role]}</span>${m.projects?.length ? ` <span class="note">${esc(m.projects.join(', '))}</span>` : ''}
${owner && m.uid !== uid ? ` <button class="link" data-remove="${esc(m.uid)}" type="button">내보내기</button>` : ''}</li>`).join('')}</ul>
${owner ? `<form id="add" class="inline"><label for="au">계정 id로 추가</label><input id="au" placeholder="u_…" required><select id="ar" aria-label="역할"><option value="member">멤버</option><option value="guest">게스트</option></select><input id="ap" aria-label="게스트 프로젝트" placeholder="게스트 프로젝트(예: 2026:4.3)"><button class="btn" type="submit">추가</button></form>`
  : `<p><button class="link" id="leave" type="button">이 팀에서 나가기</button></p>`}</section>`;
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
    const guestHtml = me.role === 'guest' ? '<section class="box"><p>게스트로 속한 팀입니다. 배정된 프로젝트의 계획과 작업은 에이전트나 대시보드에서 봅니다.</p></section>' : '';
    page(res, me.name, `${header(uid, name)}<main><p><a href="/app">← 내 공간</a></p><h1>${esc(me.name)} <span class="chip">${ROLE[me.role]}</span></h1>
${guestHtml}${charterHtml}${membersHtml}${agentHtml}${cardsHtml}</main>`, `
const S = ${js(id)}, base = '/app/api/t/' + S;
document.querySelectorAll('[data-consent]').forEach(b => { b.onclick = () => api('POST', base + '/charter/consent', { version: +b.dataset.consent, agree: b.dataset.agree === '1' }).then(reload).catch(err); });
if ($('pp')) $('pp').onsubmit = e => { e.preventDefault(); api('POST', base + '/charter/propose', { lines: $('pl').value.split('\\n').map(s => s.trim()).filter(Boolean), note: $('pn').value }).then(reload).catch(err); };
document.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 내보냅니다'; return; } api('DELETE', base + '/members/' + encodeURIComponent(b.dataset.remove)).then(reload).catch(err); }; });
if ($('add')) $('add').onsubmit = e => { e.preventDefault(); const p = $('ap').value.split(',').map(s => s.trim()).filter(Boolean); api('POST', base + '/members', { uid: $('au').value.trim(), role: $('ar').value, projects: p }).then(reload).catch(err); };
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
  api.post('/t/:space/leave', act((who, req) => spaces.removeMember(who, sp(req), (who as { uid: string }).uid)));
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
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status)); return j; });
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
.sub, .note { color: var(--muted); font-size: 13.5px } .warn { color: var(--warn) } b.warn { font-weight: 600 }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0 }
.stack { display: grid; gap: 8px } .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
.btn { min-height: 40px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; padding: 0 14px; font: inherit; display: inline-flex; align-items: center; text-decoration: none }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600 }
.link { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 4px; min-height: 32px }
input, textarea, select { font: inherit; min-height: 40px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 6px 10px; width: 100%; min-width: 0 }
.inline input { width: auto; flex: 1 1 180px } .inline select { width: auto } textarea { min-height: 120px }
.err { color: var(--warn); min-height: 1.4em; font-size: 13.5px } code { font-family: ui-monospace, monospace; font-size: 13px; overflow-wrap: anywhere }
.chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted) } .chip.warn { color: var(--warn); border-color: var(--warn) }
.rows { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px } .lines { margin: 0 0 8px; padding-left: 22px }
.prop { border-top: 1px dashed var(--line); padding-top: 10px; margin-top: 8px }
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
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
@media (max-width: 520px) { .scale { gap: 2px } .scale label { font-size: 11.5px; padding: 6px 0; word-break: keep-all } .item { padding: 10px } .trait { grid-template-columns: 6.5em 1fr 3.2em } }`;

export { SECTION_KO, CARD_SECTIONS };
