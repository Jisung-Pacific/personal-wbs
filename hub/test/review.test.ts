// The quarterly mutual review (execution WBS 4.4): quarters; only owners open a round, once a quarter, never in employee
// mode; the questions about a person carry the evidence of their work this quarter (and are noted in their view log);
// answers are checked against the questions and the evidence; nothing is visible before release; release when everyone
// is done or the due date has passed; symmetric disclosure afterwards (a review about me only from those I reviewed,
// self-reviews and goals only if I wrote mine, never a review between two others); replies and goals after release and
// last quarter's goals in the next round's evidence; leaving, employee mode and the weekly sweep; the people's pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Views } from '../src/wbs/views.js';
import { Cards } from '../src/wbs/cards.js';
import { PEER_QUESTIONS, Reviews, SELF_QUESTIONS, prevQuarter, quarterOf, quarterRange } from '../src/wbs/review.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';
import { loadConfig } from '../src/config.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), C = person('u_c'), G = person('u_g');
const TEAM_AGENT = (space: string): Caller => ({ kind: 'team_agent', space, client: 'team-master' });
const peer = (who: string, extra: Record<string, string[]> = {}) => [
  { q: 'p_work', text: `${who}: 결제 연동을 끝내 정기 결제가 열렸다`, refs: extra.p_work },
  { q: 'p_keep', text: `${who}: 막히면 바로 공유 행에 사유를 적어 준 점` },
  { q: 'p_change', text: `${who}: 리뷰 요청이 금요일에 몰렸다, 수요일에 한 번 나눠 보내기` },
];
const self = (who: string) => [{ q: 's_work', text: `${who}: 결제 연동과 인터뷰 질문지를 끝냈다` }, { q: 's_intent', text: `${who}: 출시 의도 밖 작업이 조금 있었다` }];

async function team(start = '2026-11-20') {
  const clock = { today: start };
  const store = new MemoryStore(), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views), cards = new Cards(store, spaces, views);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const reviews = new Reviews(store, spaces, views, cards, () => clock.today);
  const id = (await spaces.create(A, '시범 팀')).id;
  await spaces.setMember(A, id, 'u_b', 'member');
  await spaces.setMember(A, id, 'u_c', 'member');
  await spaces.setMember(A, id, 'u_g', 'guest', ['2026:1.1']);
  await spaces.proposeCharter(A, id, ['공유는 필드 단위다.'], '');
  await spaces.consentCharter(B, id, 1, true);
  await spaces.consentCharter(C, id, 1, true);
  for (const [u, n] of [['u_a', '에이'], ['u_b', '비'], ['u_c', '씨']]) await store.putSecret(u, 'profile', { name: n });
  await plans.put(A, id, { intents: [{ why: '결제까지 되는 첫 출시' }] });
  await plans.put(A, id, { items: [{ code: '1', scope: '출시 준비', intent: 'i1', status: '진행 중' }, { code: '1.1', scope: '결제 연동', status: '진행 중', owners: ['u_b'] },
    { code: '2', scope: '고객 인터뷰', status: '진행 중' }] });
  type Extra = { start: string; status: '완료' | '진행 중' | '대기·심사' | '백로그'; end?: string };
  const add = async (uid: string, task: string, extra: Extra) => (await ledger.add({ uid, clientName: 'Claude' }, { package: '5.3 소프트웨어', area: '5 대외·경력', task, ...extra })).created;
  const b1 = await add('u_b', '결제 모듈 연동 완료', { start: '2026-10-05', end: '2026-10-20', status: '완료' });
  const b2 = await add('u_b', '환불 처리 흐름', { start: '2026-11-02', status: '진행 중' });
  const b3 = await add('u_b', '지난 분기 정산 정리', { start: '2026-08-01', end: '2026-08-10', status: '완료' });
  const a1 = await add('u_a', '인터뷰 질문지 작성', { start: '2026-10-10', end: '2026-10-12', status: '완료' });
  await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '1.1' });
  await plans.share(B, { year: b2.year, code: b2.code, space: id, plan: '1.1', share: ['status', 'start', 'end'] });   // no title shared
  await plans.share(B, { year: b3.year, code: b3.code, space: id, plan: '2' });
  await plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '2' });
  return { store, spaces, views, plans, cards, ledger, reviews, id, clock };
}

test('quarters: calendar quarters, the one before across a year end, and a bad id', () => {
  assert.deepEqual(quarterOf('2026-11-20'), { id: '2026-Q4', from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(quarterRange('2027-Q1'), { id: '2027-Q1', from: '2027-01-01', to: '2027-03-31' });
  assert.equal(quarterOf('2026-03-31').id, '2026-Q1'); assert.equal(quarterOf('2026-04-01').id, '2026-Q2');
  assert.equal(prevQuarter('2027-Q1'), '2026-Q4');
  assert.throws(() => quarterRange('2026-Q5'), (e: unknown) => e instanceof LedgerError && e.code === 'invalid');
  assert.equal(SELF_QUESTIONS.length, 4); assert.equal(PEER_QUESTIONS.length, 4);
  assert.ok([...SELF_QUESTIONS, ...PEER_QUESTIONS].every(q => q.ko && q.en), 'every question in Korean and English');
});

test('opening: owners only (an agent needs wbs.write), the current quarter once, a due date within 30 days, two people at least', async () => {
  const { reviews, spaces, cards, id } = await team();
  assert.equal(await outcome(reviews.open(B, id)), 'forbidden', 'a member');
  assert.equal(await outcome(reviews.open(G, id)), 'forbidden', 'a guest');
  assert.equal(await outcome(reviews.open(agent('u_a', 'Claude', ['wbs.read']), id)), 'forbidden', 'an agent without wbs.write');
  assert.equal(await outcome(reviews.open(A, id, { due: '2026-12-25' })), 'invalid', 'more than 30 days');
  assert.equal(await outcome(reviews.open(A, id, { due: '2026-11-20' })), 'invalid', 'today');
  assert.equal(await outcome(reviews.open(A, id, { quarter: '2026-Q3' })), 'invalid', 'a quarter that ended more than a month ago');
  assert.deepEqual(await reviews.open(agent('u_a', 'Claude', ['wbs.read', 'wbs.write']), id),
    { space: id, quarter: '2026-Q4', from: '2026-10-01', to: '2026-12-31', due: '2026-12-04', participants: 3, opened: true }, 'the owner\'s agent; the guest is not in it');
  assert.equal(await outcome(reviews.open(A, id)), 'duplicate');

  const solo = (await spaces.create(A, '혼자')).id;
  await spaces.proposeCharter(A, solo, ['혼자 쓴다.'], '');
  assert.equal(await outcome(reviews.open(A, solo)), 'invalid', 'one person cannot review anyone');
  const emp = (await spaces.create(A, '직원 팀')).id;
  await spaces.setMember(A, emp, 'u_b', 'member'); await spaces.proposeCharter(A, emp, ['직원 팀.'], ''); await spaces.consentCharter(B, emp, 1, true);
  await cards.setEmployeeMode(A, emp, true);
  assert.equal(await outcome(reviews.open(A, emp)), 'forbidden', 'employee mode');
});

test('the questions about a person carry this quarter\'s evidence, read under the cards\' symmetry and noted in their view log', async () => {
  const { reviews, views, cards, id } = await team();
  await reviews.open(A, id);
  const q = await reviews.questions(A, id, 'u_b');
  assert.deepEqual([q.about, q.questions.map(x => x.id)], [{ uid: 'u_b', name: '비', self: false }, ['p_work', 'p_keep', 'p_change', 'p_direction']]);
  assert.deepEqual(q.evidence.work.map(w => [w.plan, w.title, w.status, w.intent]), [['1.1', '결제 모듈 연동 완료', '완료', '결제까지 되는 첫 출시'], ['1.1', '', '진행 중', '결제까지 되는 첫 출시']],
    'this quarter only (the August row is out), the title only where it was shared, the intent inherited from the parent');
  assert.match(q.evidence.work[1].label, /^1\.1 결제 연동 · 진행 중$/);
  assert.deepEqual(q.evidence.items.map(i => i.code), ['1.1'], 'the plan items they carry');
  assert.deepEqual([q.evidence.intents, q.evidence.off_intent_rows, q.evidence.goals, q.evidence.direction], [[{ rank: 1, why: '결제까지 되는 첫 출시', rows: 2 }], 0, null, null]);
  const seen = (await views.mine(B)).log[0].entries.find(e => e.viewer === 'u_a' && e.what === 'work');
  assert.equal(seen?.rows, 2, 'B\'s view log notes that A read two of B\'s rows');

  // the direction from B's card shows only while A's own card shows a direction too
  await cards.assess(B, Array(20).fill(3)); await cards.publish(B, id, { sections: ['C', 'direction'], direction: { role: '결제 담당', grow: '설계', ask: '' } });
  assert.equal((await reviews.questions(A, id, 'u_b')).evidence.direction, null, 'A has no card');
  await cards.publish(A, id, { sections: ['direction'], direction: { role: '제품', grow: '', ask: '' } });
  assert.deepEqual((await reviews.questions(A, id, 'u_b')).evidence.direction, { role: '결제 담당', grow: '설계', ask: '' });

  const s = await reviews.questions(A, id, 'self');
  assert.deepEqual([s.about.self, s.questions.map(x => x.id), s.evidence.work.map(w => w.plan)], [true, ['s_work', 's_intent', 's_collab', 's_direction'], ['2']]);
  assert.equal(await outcome(reviews.questions(A, id, 'u_g')), 'not_found', 'a guest is not in the round');
  assert.equal(await outcome(reviews.questions(G, id, 'u_b')), 'forbidden');
  assert.equal(await outcome(reviews.questions(TEAM_AGENT(id), id, 'u_b')), 'forbidden', 'the team\'s agent writes no reviews');
});

test('answers: the round\'s questions, required ones in a sentence, evidence from the person\'s own; revisable until release; via the agent noted', async () => {
  const { reviews, store, spaces, id } = await team();
  await reviews.open(A, id);
  const ev = (await reviews.questions(A, id, 'u_b')).evidence.work[0].ref;
  assert.equal(await outcome(reviews.submit(A, id, { about: 'u_b', answers: peer('A').slice(0, 2) })), 'invalid', 'p_change is required');
  assert.equal(await outcome(reviews.submit(A, id, { about: 'u_b', answers: [...peer('A').slice(0, 2), { q: 'p_change', text: '짧음' }] })), 'invalid', 'a sentence at least');
  assert.equal(await outcome(reviews.submit(A, id, { about: 'u_b', answers: [...peer('A'), { q: 's_work', text: '자기 리뷰 질문을 남에게' }] })), 'invalid', 'not a peer question');
  assert.equal(await outcome(reviews.submit(A, id, { about: 'u_b', answers: peer('A', { p_work: ['w_nope'] }) })), 'invalid', 'evidence not of this person');
  const r = await reviews.submit(A, id, { about: 'u_b', answers: peer('A', { p_work: [ev] }) });
  assert.deepEqual([r.saved, r.released, r.todo], [true, false, ['self', 'u_c']]);
  const kept = (await store.reviews(id, '2026-Q4'))[0];
  assert.deepEqual([kept.via, kept.answers[0].refs.map(x => x.label)], ['', ['1.1 결제 연동 — 결제 모듈 연동 완료 · 완료']]);
  await reviews.submit(A, id, { about: 'u_b', answers: [...peer('A2')] });
  assert.match((await store.reviews(id, '2026-Q4'))[0].answers[0].text, /^A2:/, 'revised in place');
  await reviews.submit(agent('u_b', 'ChatGPT', ['wbs.read', 'wbs.write']), id, { about: 'self', answers: self('B') });
  assert.equal((await store.reviews(id, '2026-Q4')).find(v => v.by === 'u_b')!.via, 'ChatGPT', 'written through an agent');
  assert.equal(await outcome(reviews.submit(agent('u_b', 'ChatGPT', ['wbs.read']), id, { about: 'self', answers: self('B') })), 'forbidden', 'wbs.write');
  await spaces.setMember(A, id, 'u_d', 'member');
  assert.equal(await outcome(reviews.submit(person('u_d'), id, { about: 'self', answers: self('D') })), 'consent_required', 'the charter first, as everywhere in the team');
  await spaces.consentCharter(person('u_d'), id, 1, true);
  assert.equal(await outcome(reviews.submit(person('u_d'), id, { about: 'self', answers: self('D') })), 'forbidden', 'joined after the round opened');
});

test('before release each sees only their own; the team\'s agent sees progress only; everyone done releases it', async () => {
  const { reviews, id } = await team();
  await reviews.open(A, id);
  await reviews.submit(A, id, { about: 'self', answers: self('A') });
  const a = await reviews.get(A, id) as { status: string; results: unknown; written: unknown[]; counts: unknown; todo: string[] };
  assert.deepEqual([a.status, a.results, a.written.length, a.counts, a.todo], ['open', null, 1, { participants: 3, done: 0 }, ['u_b', 'u_c']]);
  assert.equal((await reviews.get(B, id) as { written: unknown[] }).written.length, 0, 'B sees nothing of A\'s');
  const t = await reviews.get(TEAM_AGENT(id), id);
  assert.deepEqual(Object.keys(t).sort(), ['counts', 'due', 'from', 'opened', 'quarter', 'released', 'space', 'status', 'to']);
  assert.equal(await outcome(reviews.get(G, id)), 'forbidden');

  for (const [w, c] of [['u_a', A], ['u_b', B], ['u_c', C]] as const) {
    for (const o of ['u_a', 'u_b', 'u_c'].filter(x => x !== w)) await reviews.submit(c, id, { about: o, answers: peer(w) });
    await reviews.submit(c, id, { about: 'self', answers: self(w) });
  }
  const done = await reviews.get(A, id) as { status: string; results: { about_me: unknown[]; hidden_about_me: number; selves: unknown[]; written: unknown[] } };
  assert.equal(done.status, 'released', 'the last one done releases the round');
  assert.deepEqual([done.results.about_me.length, done.results.hidden_about_me, done.results.selves.length, done.results.written.length], [2, 0, 2, 3]);
  assert.equal(await outcome(reviews.submit(A, id, { about: 'self', answers: self('늦게') })), 'invalid', 'frozen once released');
});

test('symmetric disclosure: a review about me only from those I reviewed, self-reviews and goals only if I wrote mine, never one between two others', async () => {
  const { reviews, clock, id } = await team();
  await reviews.open(A, id);
  // A: self, B, C · B: A only · C: self, A, B
  await reviews.submit(A, id, { about: 'self', answers: self('A') });
  await reviews.submit(A, id, { about: 'u_b', answers: peer('A가 B에게') });
  await reviews.submit(A, id, { about: 'u_c', answers: peer('A가 C에게') });
  await reviews.submit(B, id, { about: 'u_a', answers: peer('B가 A에게') });
  await reviews.submit(C, id, { about: 'self', answers: self('C') });
  await reviews.submit(C, id, { about: 'u_a', answers: peer('C가 A에게') });
  await reviews.submit(C, id, { about: 'u_b', answers: peer('C가 B에게') });
  assert.equal((await reviews.get(A, id)).status, 'open', 'not everyone is done, the due date is ahead');
  clock.today = '2026-12-05';   // the day after the due date
  type Res = { results: { about_me: { by: { uid: string } }[]; hidden_about_me: number; selves: { by: { uid: string } }[] } };
  const view = async (c: Caller) => { const g = await reviews.get(c, id) as unknown as Res; return [g.results.about_me.map(x => x.by.uid), g.results.hidden_about_me, g.results.selves.map(x => x.by.uid)]; };
  assert.deepEqual(await view(A), [['u_b', 'u_c'], 0, ['u_c']], 'A reviewed both; B wrote no self-review');
  assert.deepEqual(await view(B), [['u_a'], 1, []], 'B did not review C, so C\'s review of B stays hidden; B wrote no self-review');
  assert.deepEqual(await view(C), [['u_a'], 0, ['u_a']]);
  for (const c of [A, B, C]) {
    const all = JSON.stringify(await reviews.get(c, id));
    const me = (c as { uid: string }).uid.slice(2).toUpperCase();
    for (const [from, to] of [['A', 'B'], ['A', 'C'], ['B', 'A'], ['C', 'A'], ['C', 'B']]) if (from !== me && to !== me) assert.ok(!all.includes(`${from}가 ${to}에게`), `${me} never sees ${from}→${to}`);
  }
});

test('replies and goals after release; next quarter\'s evidence carries them to those who could read them', async () => {
  const { reviews, clock, id } = await team();
  await reviews.open(A, id);
  assert.equal(await outcome(reviews.reply(A, id, { goals: ['너무 이름'] })), 'invalid', 'not before release');
  await reviews.submit(A, id, { about: 'self', answers: self('A') });
  await reviews.submit(C, id, { about: 'self', answers: self('C') });
  clock.today = '2026-12-05';
  await assert.rejects(reviews.reply(A, id, { goals: ['1', '2', '3', '4'] }), /3/);
  assert.deepEqual((await reviews.reply(A, id, { text: '리뷰 요청을 나눠 보내겠다', goals: ['결제 실패 1% 미만', '수요일 리뷰'] })).goals, ['결제 실패 1% 미만', '수요일 리뷰']);
  const c = await reviews.get(C, id) as unknown as { results: { selves: { by: { uid: string }; reply: { goals: string[] } | null }[] } };
  assert.deepEqual(c.results.selves.find(x => x.by.uid === 'u_a')!.reply!.goals, ['결제 실패 1% 미만', '수요일 리뷰']);
  assert.equal((await reviews.get(B, id) as unknown as { results: { selves: unknown[] } }).results.selves.length, 0, 'B wrote no self-review');

  clock.today = '2027-01-10';
  assert.equal((await reviews.open(A, id)).quarter, '2027-Q1');
  assert.deepEqual((await reviews.questions(A, id, 'self')).evidence.goals, ['결제 실패 1% 미만', '수요일 리뷰'], 'one\'s own');
  assert.deepEqual((await reviews.questions(C, id, 'u_a')).evidence.goals, ['결제 실패 1% 미만', '수요일 리뷰'], 'C wrote a self-review last quarter');
  assert.equal((await reviews.questions(B, id, 'u_a')).evidence.goals, null, 'B did not');
  assert.equal((await reviews.get(A, id) as { quarter: string }).quarter, '2027-Q1', 'the latest round by default');
  assert.equal((await reviews.get(A, id, '2026-Q4') as { quarter: string }).quarter, '2026-Q4');
});

test('leaving takes one out of the round with everything by or about one; employee mode removes every round; the sweep releases and prunes', async () => {
  const { reviews, spaces, cards, store, clock, id } = await team();
  await reviews.open(A, id);
  await reviews.submit(A, id, { about: 'u_c', answers: peer('A') });
  await reviews.submit(C, id, { about: 'u_a', answers: peer('C') });
  await reviews.submit(B, id, { about: 'u_a', answers: peer('B') });
  await spaces.removeMember(C, id, 'u_c');
  const r = (await store.reviewRounds(id))[0];
  assert.deepEqual([r.participants, (await store.reviews(id, r.id)).map(v => `${v.by}>${v.about}`)], [['u_a', 'u_b'], ['u_b>u_a']]);

  // the weekly sweep: due rounds released, rounds older than four quarters removed
  await store.putReviewRound(id, { ...r, id: '2025-Q3', released: 1 });
  await store.putReviewRound(id, { ...r, id: '2025-Q4', released: 1 });
  clock.today = '2026-12-10';
  assert.deepEqual(await reviews.sweep(), { released: 1, removed: 1 });
  assert.deepEqual((await store.reviewRounds(id)).map(x => [x.id, !!x.released]), [['2025-Q4', true], ['2026-Q4', true]]);

  await cards.setEmployeeMode(A, id, true);
  assert.deepEqual(await store.reviewRounds(id), [], 'employee mode removes every round');
  const g = await reviews.get(A, id) as { status: string; employee_mode: boolean };
  assert.deepEqual([g.status, g.employee_mode], ['none', true]);
});

test('the people\'s pages: open a round, write with evidence, the team page shows the progress; an agent token opens none of it', async () => {
  const store = new MemoryStore(), srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1' } as NodeJS.ProcessEnv), issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier()));
  const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
  const signIn = async (uid: string) => (await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) })).headers.get('set-cookie')!.split(';')[0];
  const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.message || j.error), { status: r.status }); return j;
  };
  const html = async (cookie: string, path: string) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); assert.equal(r.status, 200); return r.text(); };
  try {
    const ca = await signIn('u_pa'), cb = await signIn('u_pb'), a = call(ca), b = call(cb);
    const s = await a('POST', '/app/api/spaces', { name: '리뷰 팀' });
    await a('POST', `/app/api/t/${s.id}/members`, { uid: 'u_pb', role: 'member' });
    await a('POST', `/app/api/t/${s.id}/charter/propose`, { lines: ['서로 리뷰한다.'], note: '' });
    await b('POST', `/app/api/t/${s.id}/charter/consent`, { version: 1, agree: true });
    assert.match(await html(ca, `/app/t/${s.id}`), /상호 리뷰[\s\S]*리뷰 열기/);
    assert.match(await html(cb, `/app/t/${s.id}/review`), /소유자가 분기 리뷰를 엽니다/);
    await assert.rejects(b('POST', `/app/api/t/${s.id}/review/open`, {}), (e: { status: number }) => e.status === 403);
    const o = await a('POST', `/app/api/t/${s.id}/review/open`, {});
    assert.equal(o.quarter, quarterOf(todayKst()).id);
    const page = await html(cb, `/app/t/${s.id}/review/u_pa`);
    assert.match(page, /에 대한 리뷰/); assert.match(page, /근거/); assert.match(page, /p_change/);
    const r = await b('POST', `/app/api/t/${s.id}/review/submit`, { about: 'u_pa', answers: peer('PB') });
    assert.deepEqual([r.saved, r.todo], [true, ['self']]);
    assert.match(await html(cb, `/app/t/${s.id}/review`), /작성함[\s\S]*남음|남음[\s\S]*작성함/);
    assert.match(await html(ca, `/app/t/${s.id}`), /0\/2명 마침 · 내가 남은 리뷰 2/);
    const at = (await issuer.access('u_pa', 'c1', 'Claude', 'wbs.read wbs.write', `${base}/mcp`)).token;
    assert.equal((await fetch(`${base}/app/api/t/${s.id}/review/open`, { method: 'POST', headers: { ...H, authorization: `Bearer ${at}` }, body: '{}' })).status, 401, 'an agent token is not a session');
  } finally { await new Promise<void>(r => srv.close(() => r())); }
});
