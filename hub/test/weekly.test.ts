// The weekly team brief and personal coaching (execution WBS 4.3): ISO weeks across year ends; the team brief speaks of
// the work only — no line names, counts or compares a person — and is kept unchanged once made, while the week in
// progress is live and not kept; owners, members, their agents and the team's agent read it, guests do not; the weekly
// run is idempotent and prunes weeks older than half a year; coaching goes to the person alone, against their own past
// weeks, and on a team connection covers only that team's rows; only the scheduler's own account starts the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Briefs, KEEP_WEEKS, isoWeek, lastFullWeek, weekRange } from '../src/wbs/weekly.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';
import { loadConfig } from '../src/config.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';
import { openapi } from '../src/rest.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const DAY = 86_400_000, ms = (d: string) => Date.parse(d + 'T00:00:00Z'), ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const plus = (d: string, n: number) => ymd(ms(d) + n * DAY);
const A = person('u_a'), B = person('u_b'), G = person('u_g');
const PEOPLE = /u_[abgz]/;

test('ISO weeks: Monday to Sunday, week 1 holds the first Thursday, 53-week years, and the last week that has ended', () => {
  assert.deepEqual(isoWeek('2026-11-20'), { week: '2026-W47', from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(isoWeek('2026-12-31'), { week: '2026-W53', from: '2026-12-28', to: '2027-01-03' });
  assert.equal(isoWeek('2027-01-03').week, '2026-W53', 'early January can belong to the year before');
  assert.equal(isoWeek('2027-01-04').week, '2027-W01');
  assert.equal(isoWeek('2024-12-30').week, '2025-W01', 'late December can belong to the year after');
  assert.deepEqual(weekRange('2026-W53'), { week: '2026-W53', from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(weekRange('2025-W01'), { week: '2025-W01', from: '2024-12-30', to: '2025-01-05' });
  for (const bad of ['2025-W53', '2026-W00', '2026-W54', '2026-47', 'W47'])
    assert.throws(() => weekRange(bad), (e: unknown) => e instanceof LedgerError && e.code === 'invalid', bad);
  assert.equal(lastFullWeek('2026-11-22').week, '2026-W46', 'on Sunday the week is still running');
  assert.equal(lastFullWeek('2026-11-23').week, '2026-W47');
});

/** A team with a plan and shared work: one row finished last week, one waiting on a blocker, an item overdue with no
 *  work, two items falling due within the week, one waiting on the other. */
async function fixture() {
  const T = todayKst(), Y = T.slice(0, 4), last = lastFullWeek(T), cur = isoWeek(T);
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const briefs = new Briefs(store, spaces, () => T);
  const s = await spaces.create(A, '시범 팀'), id = s.id;
  await admit(spaces, A, id, 'u_b', 'member');
  await admit(spaces, A, id, 'u_g', 'guest', [`${Y}:2.1`]);
  await spaces.proposeCharter(A, id, ['공유는 필드 단위다.'], '');
  await spaces.consentCharter(B, id, 1, true);
  await plans.put(A, id, { intents: [{ why: '출시 마감을 지킨다' }] });
  await plans.put(A, id, { items: [
    { code: '1', scope: '출시 준비', intent: 'i1', status: '진행 중' },
    { code: '1.1', scope: '결제 연동', status: '진행 중', due: plus(T, 3), owners: ['u_b'] },
    { code: '1.2', scope: '문서 정리', status: '진행 중', due: plus(T, 5), depends_on: ['1.1'] },
    { code: '2', scope: '지난 분기 정산', status: '진행 중', due: plus(T, -3) },
  ] });
  type Extra = { start: string; status: '완료' | '진행 중' | '대기·심사' | '백로그'; end?: string; due?: string; blocker?: string };
  const add = async (uid: string, task: string, extra: Extra) =>
    (await ledger.add({ uid, clientName: 'Claude' }, { package: '5.3 소프트웨어', area: '5 대외·경력', task, ...extra })).created;
  const b1 = await add('u_b', '결제 모듈 연동 완료', { start: last.from, end: plus(last.from, 2), status: '완료' });
  const a1 = await add('u_a', '결제 키 발급 요청', { start: plus(last.from, 1), status: '대기·심사', blocker: '외부 심사·승인: 결제사 키 발급' });
  await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '1.1', plan_year: Y });
  await plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '1.1', plan_year: Y, share: ['title', 'status', 'start', 'end', 'blocker'] });
  return { store, spaces, plans, ledger, briefs, id, T, Y, last, cur, add };
}

test('the team brief: progress, bottlenecks, shared blockers, risks within seven days, intents and what falls due — and no person', async () => {
  const { briefs, id, T, last } = await fixture();
  const b = await briefs.weekly(A, id);
  assert.equal(b.week, last.week); assert.equal(b.from, last.from); assert.equal(b.as_of, T);
  assert.equal('live' in b, false, 'an ended week');
  assert.deepEqual(b.progress, { rows_done: 1, rows_started: 2, items_done: [] });
  assert.equal(b.lines[0], '진척: 공유 행 완료 1 · 시작 2 · 완료된 계획 항목 없음');
  const late = b.bottlenecks.find(x => x.code === '2')!;
  assert.ok(late.why.includes('마감 3일 지남') && late.why.includes('진행 중인데 공유된 작업 없음'), late.why.join());
  assert.deepEqual(b.blockers, ['외부 심사·승인: 결제사 키 발급']);
  assert.deepEqual(b.risks.map(r => [r.code, r.why]), [['1.1', ['작업 1/2행']], ['1.2', ['공유된 작업 없음', '선행 1.1 미완료']]]);
  assert.deepEqual(b.risks.map(r => [r.rows, r.done, r.pending]), [[2, 1, []], [0, 0, ['1.1']]], 'the same, as data for screens');
  assert.ok(late.flags.includes('late') && late.flags.includes('no_work') && late.slip_days === 3);
  assert.deepEqual([b.intents.active, b.intents.items, b.intents.unanchored, b.intents.off_intent_rows], [1, [], 1, 0]);
  assert.deepEqual(b.next.map(x => [x.code, x.due]), [['1.1', plus(T, 3)], ['1.2', plus(T, 5)]]);
  assert.ok(b.lines.some(l => l === '의도: 의도 없는 계획 1개'), b.lines.join('\n'));
  assert.ok(b.lines.some(l => l.startsWith('리스크(7일 안): 1.1 결제 연동 ~')));
  assert.doesNotMatch(JSON.stringify(b), PEOPLE, 'no account, owner or author anywhere in the brief');
  assert.doesNotMatch(b.lines.join('\n'), /팀원|사람|명\b/, 'and no line counts people');
});

test('an ended week is made once and kept as it was; the week in progress is live and never kept; old weeks are not made up', async () => {
  const { briefs, store, plans, id, T, Y, last, cur, add } = await fixture();
  const first = await briefs.weekly(A, id);
  assert.deepEqual(await store.weeklies(id), [last.week], 'the first reader made last week\'s brief');
  // more work that ended last week, and a plan item finished now: the kept brief does not move
  const b2 = await add('u_b', '문서 초안 정리', { start: last.from, end: last.to, status: '완료' });
  await plans.share(B, { year: b2.year, code: b2.code, space: id, plan: '1.2', plan_year: Y });
  await plans.put(A, id, { items: [{ code: '2', status: '완료' }] });
  assert.deepEqual(await briefs.weekly(B, id), first, 'every reader gets the same text');
  assert.deepEqual(await briefs.weekly(B, id, last.week), first);

  const live = await briefs.weekly(B, id, cur.week);
  assert.equal((live as { live?: boolean }).live, true); assert.equal(live.as_of, T);
  assert.deepEqual(live.progress.items_done, [{ code: '2', scope: '지난 분기 정산' }], 'finished during this week');
  assert.ok(!live.bottlenecks.some(x => x.code === '2'), 'a finished item is no bottleneck');
  assert.deepEqual(await store.weeklies(id), [last.week], 'the live week is not kept');

  assert.equal(await outcome(briefs.weekly(A, id, isoWeek(plus(T, -70)).week)), 'not_found', 'an older week nobody made');
  assert.equal(await outcome(briefs.weekly(A, id, '2026-47')), 'invalid');
});

test('who reads the brief: owners, members, their agents with wbs.read, and the team\'s agent; not guests or outsiders', async () => {
  const { briefs, id } = await fixture();
  const teamAgent: Caller = { kind: 'team_agent', space: id, client: 'Claude' };
  for (const c of [A, B, agent('u_b', 'ChatGPT', ['wbs.read']), teamAgent]) assert.equal(await outcome(briefs.weekly(c, id)), 'ok', JSON.stringify(c));
  assert.equal(await outcome(briefs.weekly(G, id)), 'forbidden', 'a guest');
  assert.equal(await outcome(briefs.weekly(agent('u_b', 'ChatGPT', []), id)), 'forbidden', 'an agent without wbs.read');
  assert.notEqual(await outcome(briefs.weekly(person('u_z'), id)), 'ok', 'someone outside the team');
});

test('the weekly run: last week for every team that lacks it, nothing twice, weeks older than half a year removed', async () => {
  const { briefs, spaces, store, id, T, last } = await fixture();
  const other = (await spaces.create(A, '두 번째 팀')).id;
  await briefs.weekly(A, id);   // a reader made this team's brief before the run
  assert.deepEqual(await briefs.runWeekly(), { week: last.week, generated: 1, removed: 0 });
  assert.deepEqual(await briefs.runWeekly(), { week: last.week, generated: 0, removed: 0 }, 'idempotent');
  assert.deepEqual(await store.weeklies(other), [last.week]);

  const kept = (await store.weekly(id, last.week))!;
  const old = isoWeek(plus(T, -7 * (KEEP_WEEKS + 2))).week, recent = isoWeek(plus(T, -7 * (KEEP_WEEKS - 2))).week;
  await store.putWeekly(id, { ...kept, week: old });
  await store.putWeekly(id, { ...kept, week: recent });
  assert.deepEqual(await briefs.runWeekly(), { week: last.week, generated: 0, removed: 1 });
  assert.deepEqual(await store.weeklies(id), [recent, last.week].sort());
});

test('coaching: the person\'s own pace and open work, their part in each team; a team connection sees only that team\'s rows', async () => {
  const { briefs, plans, id, T, add } = await fixture();
  const solo = await add('u_b', '개인 서류 정리', { start: plus(T, -20), status: '진행 중', due: plus(T, -2) });   // not shared, overdue, stalled
  const odd = await add('u_b', '전혀 무관한 실험 메모 작성', { start: T, status: '진행 중' });
  const rec = await plans.recordFor(B, id, { year: odd.year, code: odd.code, task: '전혀 무관한 실험 메모 작성' });
  assert.equal(rec.status, 'pending', 'no confident match: a pending link');

  const c = await briefs.coach(B);
  assert.deepEqual(c.pace, { this_week_so_far: 0, last_week: 1, median_8_weeks: 0 }, 'against their own past weeks');
  assert.equal(c.overdue.length, 1); assert.match(c.overdue[0], new RegExp(`${solo.code} 개인 서류 정리`));
  assert.equal(c.stalled.length, 1);
  assert.deepEqual(c.teams, [{ space: id, name: '시범 팀', mine: [{ code: '1.1', scope: '결제 연동', due: plus(T, 3), late: false }], pending: 1 }]);
  assert.ok(c.lines.includes('팀 시범 팀: 맡은 계획 항목 1개 · 팀 계획 항목을 고르지 않은 연결 대기 1행'), c.lines.join('\n'));
  assert.match(c.note, /본인에게만/);
  assert.doesNotMatch(JSON.stringify(c), /u_a|u_g/, 'nothing about anyone else');

  const t = await briefs.coach(B, id);
  assert.equal(t.scope, 'rows linked to this team');
  assert.deepEqual(t.overdue, [], 'the unshared row stays out of a team connection');
  assert.equal(t.pace.last_week, 1, 'the linked row that finished last week');
  assert.equal(t.teams.length, 1);

  const teamAgent: Caller = { kind: 'team_agent', space: id, client: 'Claude' };
  assert.equal(await outcome(briefs.coach(teamAgent)), 'forbidden', 'never through the team\'s agent');
  assert.equal(await outcome(briefs.coach(agent('u_b', 'ChatGPT', []))), 'forbidden');
  assert.equal(await outcome(briefs.coach(agent('u_b', 'ChatGPT', ['wbs.read']))), 'ok');
});

async function boot(env: Record<string, string>) {
  const store = new MemoryStore(), srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1', ...env } as NodeJS.ProcessEnv), issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier(), undefined, async t => t === 'scheduler-ok'));
  return { base, store, issuer, close: () => new Promise<void>(r => srv.close(() => r())) };
}

test('POST /internal/weekly: only the scheduler\'s own account, and only where one is configured', async () => {
  const off = await boot({});
  try {
    assert.equal((await fetch(`${off.base}/internal/weekly`, { method: 'POST', headers: { authorization: 'Bearer scheduler-ok' } })).status, 404);
  } finally { await off.close(); }
  const on = await boot({ HUB_SCHEDULER_SA: 'ppwbs-hub-weekly@example.iam.gserviceaccount.com' });
  try {
    const post = (h: Record<string, string>) => fetch(`${on.base}/internal/weekly`, { method: 'POST', headers: h });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer forged' })).status, 401);
    const sp = new Spaces(on.store), s = await sp.create(A, '시범 팀');
    await sp.proposeCharter(A, s.id, ['공유는 필드 단위다.'], '');   // a lone owner's proposal is the charter
    const r = await post({ authorization: 'Bearer scheduler-ok' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { week: lastFullWeek(todayKst()).week, generated: 1, removed: 0 });
    assert.deepEqual(await on.store.weeklies(s.id), [lastFullWeek(todayKst()).week]);

    // and the REST face: the brief by space and week, coaching for the token's own person
    const tok = (await on.issuer.access('u_a', 'c1', 'Claude', 'wbs.read', `${on.base}/v1`)).token;
    const get = (p: string) => fetch(`${on.base}/v1${p}`, { headers: { authorization: `Bearer ${tok}` } });
    const w = await get(`/weekly?space=${s.id}`);
    assert.equal(w.status, 200); assert.equal((await w.json()).week, lastFullWeek(todayKst()).week);
    assert.equal((await get(`/weekly?space=${s.id}&week=2026-47`)).status, 400);
    const c = await get('/coach');
    assert.equal(c.status, 200); assert.match((await c.json()).note, /본인에게만/);
  } finally { await on.close(); }
  const doc = openapi(loadConfig({ HUB_PUBLIC_URL: 'https://hub.example' } as NodeJS.ProcessEnv), '0') as { paths: Record<string, unknown> };
  assert.ok(doc.paths['/weekly'] && doc.paths['/coach'], 'documented for HTTP agents');
});
