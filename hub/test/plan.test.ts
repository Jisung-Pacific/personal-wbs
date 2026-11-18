// The team plan ledger (execution WBS 3.4) as the charter sets it: the team's project WBS lives in the team space, each
// person's work stays in their own ledger and is linked to a plan code, only the fields the person shares reach the team
// (by default title, status, dates and deliverable links), the copies follow the rows, and the plan is shown against
// the actual work. When someone leaves, the copies they shared stay with the team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans, planActual, titleOf } from '../src/wbs/plan.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), G = person('u_g'), X = person('u_x');
const Y = todayKst().slice(0, 4);

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const s = await spaces.create(A, '시범 팀');
  await spaces.setMember(A, s.id, 'u_b', 'member');
  await spaces.setMember(A, s.id, 'u_g', 'guest', [`${Y}:3.4`]);
  await spaces.proposeCharter(A, s.id, ['공유는 필드 단위다.'], '');
  await spaces.consentCharter(B, s.id, 1, true);
  return { store, spaces, plans, ledger, id: s.id };
}
/** A plan shaped like the execution WBS: an area, scopes under it, a step under a scope. */
const PLAN = [
  { code: '3', scope: '팀 공간', status: '진행 중' as const },
  { code: '3.1', scope: '공간 모델', deliverable: '개인·팀 공간', done: '단위 시험 통과', status: '완료' as const, owners: ['Claude'] },
  { code: '3.2', scope: '관계 기반 권한', status: '완료' as const, depends_on: ['3.1'] },
  { code: '3.4', scope: '팀 계획 원장·코드 참조', deliverable: '프로젝트 WBS, 개인 행의 팀 코드 참조, 필드 단위 공유', done: '계획 대비 실적 표시',
    status: '진행 중' as const, depends_on: ['3.2'], owners: ['Claude', '팀장'], start: `${Y}-01-05`, due: `${Y}-01-10` },
  { code: '3.4.1', scope: '계획 항목 저장', status: '진행 중' as const },
  { code: '3.5', scope: '열람 기록', status: '백로그' as const, depends_on: ['3.2'] },
];
const actorA = { uid: 'u_a', clientName: 'Claude' }, actorB = { uid: 'u_b', clientName: 'ChatGPT' };
const row = (task: string, extra: Record<string, unknown> = {}) => ({ package: '5.3 소프트웨어', area: '5 대외·경력', task, start: `${Y}-01-06`, status: '진행 중' as const, ...extra });

test('plan items: owners and members write, codes are the plan\'s own and permanent, guests and outsiders cannot write', async () => {
  const { plans, spaces, id } = await team();
  const r = await plans.put(A, id, { items: [...PLAN].reverse() });   // children before parents in the call: applied in code order
  assert.deepEqual([r.created.length, r.changed.length], [6, 0]);
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '7.1', scope: '부모 없음' }] })), 'invalid', 'a child needs its parent');
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '3.6', scope: '선행 오류', depends_on: ['9'] }] })), 'invalid', 'prerequisites must be plan items');
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '3.6' }] })), 'invalid', 'a new item needs a scope');
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '3.6', scope: 'a' }, { code: '3.6', scope: 'b' }] })), 'invalid', 'one code once per call');
  assert.equal(await outcome(plans.put(G, id, { items: [{ code: '3.4', status: '완료' }] })), 'forbidden', 'a guest reads only');
  assert.equal(await outcome(plans.put(X, id, { items: [{ code: '3.4', status: '완료' }] })), 'not_found', 'outsiders are told nothing');
  assert.equal(await outcome(plans.put(agent('u_b', 'Gemini', ['wbs.read']), id, { items: [{ code: '3.4', status: '완료' }] })), 'forbidden', 'writing needs wbs.write');
  assert.equal(await outcome(plans.list(A, 'personal')), 'invalid', 'the plan lives in a team space');

  // a change touches only the fields given and is logged with who recorded it (and through which agent)
  const c = await plans.put(agent('u_b', 'ChatGPT', ['wbs.write']), id, { items: [{ code: '3.4', due: `${Y}-01-20` }, { code: '3.1', scope: '공간 모델' }], memo: '일정 조정' });
  assert.deepEqual([c.changed, c.unchanged], [[`${Y} 3.4`], 1]);
  const item = (await plans.list(B, id)).items.find(p => p.code === '3.4')!;
  assert.equal(item.deliverable, '프로젝트 WBS, 개인 행의 팀 코드 참조, 필드 단위 공유');
  assert.deepEqual(item.log.at(-1), { at: item.log.at(-1)!.at, change: `마감 ${Y}-01-10 → ${Y}-01-20 — 일정 조정`, by: 'u_b', via: 'ChatGPT' });

  // a guest sees its project (3.4 and what is under it), nothing above it, and no names
  const g = await plans.list(G, id);
  assert.deepEqual(g.items.map(p => p.code), ['3.4', '3.4.1']);
  assert.equal(g.items[0].by, undefined); assert.ok(g.items[0].log.every(l => !('by' in l)));

  // nothing before the charter is in force
  const t = await spaces.create(A, '헌장 없음');
  assert.equal(await outcome(plans.put(A, t.id, { items: [{ code: '1', scope: 'x' }] })), 'consent_required');
});

test('sharing: personal rows link to plan codes, only the chosen fields reach the team, and the copies follow the rows', async () => {
  const { plans, ledger, store, id } = await team();
  await plans.put(A, id, { items: PLAN });
  const a1 = (await ledger.add(actorA, row('계획 항목 저장소: 메모리·Firestore 구현, 시험 12건 통과 https://github.com/x/y/pull/7', { evidence: 'claude:abc123' }))).created;
  const b1 = (await ledger.add(actorB, row('권한 표에 work.share 추가; 사양 시험 갱신'))).created;
  const a2 = (await ledger.add(actorA, row('개인 메모: 다른 일'))).created;

  // the charter's default: title, status, dates and deliverable links; never the evidence or the full text
  const s1 = await plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '3.4.1' });
  assert.deepEqual(Object.keys(s1.team_sees).sort(), ['due', 'end', 'last_progress', 'links', 'start', 'status', 'title']);
  assert.equal(s1.team_sees.title, '계획 항목 저장소');
  assert.equal(s1.team_sees.links, 'https://github.com/x/y/pull/7');
  // a person may share less, or more (the full text); status always goes
  const s2 = await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '3.4', share: ['task'] });
  assert.deepEqual(Object.keys(s2.team_sees).sort(), ['status', 'task']);

  const copies = await store.shared(id), all = JSON.stringify(copies);
  assert.equal(copies.length, 2);
  for (const secret of ['claude:abc123', '메모리·Firestore 구현', a2.code, a1.code, '개인 메모']) assert.ok(!all.includes(secret), `the team never holds ${secret}`);
  assert.equal(await outcome(plans.share(A, { year: a1.year, code: '5.3.99', space: id, plan: '3.4' })), 'not_found', 'only rows of one\'s own ledger');
  assert.equal(await outcome(plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '8' })), 'not_found', 'only existing plan items');
  assert.equal(await outcome(plans.share(G, { year: a1.year, code: a1.code, space: id, plan: '3.4' })), 'forbidden', 'a guest shares nothing with the team');
  assert.equal(await outcome(plans.share(agent('u_a', 'Claude', ['wbs.read']), { year: a1.year, code: a1.code, space: id, plan: '3.4' })), 'forbidden');

  // the copy follows the row: a status change in the personal ledger reaches the team
  await ledger.update(actorA, { year: a1.year, code: a1.code, status: '완료', end: `${Y}-01-09` });
  const after = (await store.shared(id)).find(w => w.fields.title === '계획 항목 저장소')!;
  assert.deepEqual([after.fields.status, after.fields.end], ['완료', `${Y}-01-09`]);
  assert.deepEqual((await plans.mine(A)).map(l => [l.code, l.plan, l.team_copy]), [[a1.code, `${Y}:3.4.1`, 'live']]);

  // unlinking while in the space withdraws the copy
  const u = await plans.unshare(A, { year: a1.year, code: a1.code });
  assert.equal(u.team_copy, 'removed');
  assert.equal((await store.shared(id)).length, 1);
  assert.equal(await outcome(plans.unshare(A, { year: a1.year, code: a1.code })), 'not_found');
});

test('plan vs actual: work rolls up to parents, slips and flags, names for members, counts for guests', async () => {
  const { plans, ledger, id } = await team();
  await plans.put(A, id, { items: PLAN });
  const a1 = (await ledger.add(actorA, row('저장소 구현'))).created;
  const b1 = (await ledger.add(actorB, row('권한 표 갱신'))).created;
  await plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '3.4.1' });
  await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '3.4' });
  await ledger.update(actorB, { year: b1.year, code: b1.code, status: '대기·심사', blocker: '외부 심사·승인: 리뷰' });

  const v = await plans.actual(A, id, Y);
  const by = Object.fromEntries(v.items.map(i => [i.code, i]));
  assert.deepEqual([by['3.4'].actual.rows, by['3.4'].actual.done, by['3.4'].actual.status], [2, 0, '진행 중'], 'a parent counts its steps\' work');
  assert.deepEqual(by['3.4'].actual.people, ['u_a', 'u_b']);
  assert.ok(by['3.4'].flags.includes('waiting'));
  assert.equal(by['3'].actual.rows, 2, 'the area rolls up everything under it');
  assert.ok(by['3.4'].flags.includes('late') && by['3.4'].slip_days! > 0, 'due date passed with work open');
  assert.deepEqual(by['3.1'].flags, [], 'a done item without linked work is fine');
  assert.equal(by['3.4'].work.length, 1, 'each item lists the rows linked to it directly');
  assert.ok(v.lines.some(l => l.startsWith(`${Y} 3.4 팀 계획 원장·코드 참조 | 계획 진행 중 ~${Y}-01-10 | 실적 0/2 진행 중`)), v.lines.join('\n'));
  assert.deepEqual([v.totals.items, v.totals.leaf_items, v.totals.shared_rows], [6, 4, 2]);

  // work done while the plan is still open, and a parked item with work started
  await ledger.update(actorA, { year: a1.year, code: a1.code, status: '완료' });
  await ledger.update(actorB, { year: b1.year, code: b1.code, status: '완료' });
  const w = Object.fromEntries((await plans.actual(A, id, Y)).items.map(i => [i.code, i]));
  assert.ok(w['3.4.1'].flags.includes('work_done_plan_open') && w['3.4'].flags.includes('work_done_plan_open'));
  assert.equal(w['3.4'].actual.status, '완료'); assert.ok(!w['3.4'].flags.includes('late'), 'finished work is not late, only slipped');

  // the guest sees its project only, with counts instead of names; the team's own agent reads it too, without names
  const g = await plans.actual(G, id, Y);
  assert.deepEqual(g.items.map(i => i.code), ['3.4', '3.4.1']);
  assert.equal(g.items[0].actual.people, 2); assert.ok(g.items[0].work.every(x => !('uid' in x)));
  const t = await plans.actual({ kind: 'team_agent', space: id, client: 'team-master' } as Caller, id, Y);
  assert.equal(t.items.length, 6); assert.equal(t.items[3].actual.people, 2);
});

test('leaving: what a person shared stays with the team, frozen; the links stay with the person', async () => {
  const { plans, ledger, spaces, store, id } = await team();
  await plans.put(A, id, { items: PLAN });
  const b1 = (await ledger.add(actorB, row('권한 표 갱신'))).created;
  await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '3.4' });
  await spaces.removeMember(B, id, 'u_b');   // B leaves
  const kept = await store.shared(id);
  assert.equal(kept.length, 1); assert.ok(kept[0].frozen, 'the copy stays, frozen');
  await ledger.update(actorB, { year: b1.year, code: b1.code, status: '완료' });
  assert.equal((await store.shared(id))[0].fields.status, '진행 중', 'a frozen copy no longer follows the row');
  assert.deepEqual((await plans.mine(B)).map(l => l.team_copy), ['frozen']);
  assert.equal((await plans.unshare(B, { year: b1.year, code: b1.code })).team_copy, 'kept (shared before you left)');
  assert.equal((await store.shared(id)).length, 1, 'the team keeps what was shared');

  // becoming a guest freezes too; sharing again after returning as a member makes it live
  await spaces.setMember(A, id, 'u_b', 'member'); await spaces.consentCharter(B, id, 1, true);
  const b2 = (await ledger.add(actorB, row('플랜 화면 초안'))).created;
  await plans.share(B, { year: b2.year, code: b2.code, space: id, plan: '3.4.1' });
  await spaces.setMember(A, id, 'u_b', 'guest', [`${Y}:3.4`]);
  assert.ok((await store.shared(id)).every(w => w.frozen));
  await spaces.setMember(A, id, 'u_b', 'member');
  await plans.share(B, { year: b2.year, code: b2.code, space: id, plan: '3.4.1' });
  await ledger.update(actorB, { year: b2.year, code: b2.code, status: '완료' });
  const live = (await store.shared(id)).find(w => w.plan === `${Y}:3.4.1`)!;
  assert.deepEqual([live.frozen, live.fields.status], [undefined, '완료']);
});

test('titles: the text up to the first colon or semicolon, else the first 50 characters', () => {
  assert.equal(titleOf('허브 스키마 재점검: 테스트 196건'), '허브 스키마 재점검');
  assert.equal(titleOf('짧음: x'), '짧음: x', 'a head under 4 characters is not a title');
  assert.equal(titleOf('가'.repeat(60)), '가'.repeat(50) + '…');
  // planActual works on plain data too (a dashboard can call it with what the hub returned)
  const r = planActual([{ year: '2026', code: '1', scope: 's', deliverable: '', done: '', depends_on: [], owners: [], status: '진행 중', start: '', due: '', updated: 0, by: 'u', log: [] }], [], '2026-11-19', false);
  assert.deepEqual(r.items[0].flags, ['no_work']);
});
