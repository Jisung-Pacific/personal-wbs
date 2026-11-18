// Intent alignment (execution WBS 4.1): the team writes down why it works (at most five active intents, ranked), plan
// items point at an intent (a child inherits its parent's), and the alignment sets the intents against where the shared
// work actually goes, with flags for an intent that has no plan, a plan but no work, or less work than a lower-ranked
// one. Owners and members see it per person, symmetrically; the team's agent sees counts; guests do not see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans, intentAlignment, MAX_INTENTS } from '../src/wbs/plan.js';
import { agent, person } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';
import type { Intent, PlanItem, SharedWork } from '../src/store/types.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), G = person('u_g');
const Y = todayKst().slice(0, 4);

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const s = await spaces.create(A, '시범 팀');
  await spaces.setMember(A, s.id, 'u_b', 'member');
  await spaces.setMember(A, s.id, 'u_g', 'guest', [`${Y}:2.1`]);
  await spaces.proposeCharter(A, s.id, ['공유는 필드 단위다.'], '');
  await spaces.consentCharter(B, s.id, 1, true);
  return { store, spaces, plans, ledger, id: s.id };
}
const row = (task: string, extra: Record<string, unknown> = {}) => ({ package: '5.3 소프트웨어', area: '5 대외·경력', task, start: `${Y}-01-06`, status: '진행 중' as const, ...extra });

test('intents: up to five active, ranked, retired rather than deleted; a retry does not duplicate; guests cannot write', async () => {
  const { plans, store, id } = await team();
  const r = await plans.put(A, id, { intents: [{ why: '두 사람이 같은 원장으로 일한다', what: '팀 계획과 개인 작업 연결', how: '필드 단위 공유' }, { why: '마감을 놓치지 않는다' }] });
  assert.deepEqual(r.intents, { created: ['i1', 'i2'], changed: [] });
  assert.deepEqual(r.created, [], 'no items given, none written');
  const all = await store.intents(id);
  assert.deepEqual(all.map(i => [i.id, i.rank, i.status, i.by]), [['i1', 1, 'active', 'u_a'], ['i2', 2, 'active', 'u_a']]);

  // the same why again (a retried call) changes that intent instead of adding a third
  const again = await plans.put(A, id, { intents: [{ why: '마감을 놓치지 않는다', how: '주간 점검' }] });
  assert.deepEqual(again.intents, { created: [], changed: ['i2'] });
  assert.equal((await store.intents(id)).find(i => i.id === 'i2')!.how, '주간 점검');

  assert.equal(await outcome(plans.put(A, id, { intents: [{ what: '이유 없음' }] })), 'invalid', 'a new intent needs a why');
  assert.equal(await outcome(plans.put(A, id, { intents: [{ id: 'i9', why: 'x' }] })), 'not_found');
  assert.equal(await outcome(plans.put(G, id, { intents: [{ why: '손님의 의도' }] })), 'forbidden', 'a guest reads only');
  await assert.rejects(plans.put(A, id, {}), /Give items, intents, or both/);

  // a member adds intents too; the sixth active one is refused until one is retired
  await plans.put(B, id, { intents: [{ why: '세 번째' }, { why: '네 번째' }, { why: '다섯 번째' }] });
  assert.equal(await outcome(plans.put(B, id, { intents: [{ why: '여섯 번째' }] })), 'invalid');
  assert.equal((await store.intents(id)).length, MAX_INTENTS, 'the refused call wrote nothing');
  const swap = await plans.put(B, id, { intents: [{ id: 'i5', status: 'retired' }, { why: '여섯 번째', rank: 3 }] });
  assert.deepEqual(swap.intents, { created: ['i6'], changed: ['i5'] });
  assert.deepEqual((await store.intents(id)).filter(i => i.status === 'active').length, MAX_INTENTS);
});

test('plan items point at an active intent; "" clears it; the change is logged', async () => {
  const { plans, id } = await team();
  await plans.put(A, id, { intents: [{ why: '연결' }, { why: '마감' }] });
  await plans.put(A, id, { items: [{ code: '1', scope: '팀 공간', intent: 'i1' }, { code: '1.1', scope: '공간 모델' }] });
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '1.2', scope: 'x', intent: 'i7' }] })), 'invalid', 'an unknown intent');
  await plans.put(A, id, { intents: [{ id: 'i2', status: 'retired' }] });
  assert.equal(await outcome(plans.put(A, id, { items: [{ code: '1.1', intent: 'i2' }] })), 'invalid', 'a retired intent');
  await plans.put(A, id, { items: [{ code: '1.1', intent: 'i1' }] });
  await plans.put(A, id, { items: [{ code: '1.1', intent: '' }] });
  const log = (await plans.list(A, id)).items.find(p => p.code === '1.1')!.log.map(l => l.change);
  assert.deepEqual(log, ['생성', '의도 없음 → i1', '의도 i1 → 없음']);
});

test('alignment model: inheritance, leaves, shares in whole percents, the three flags, unanchored plan and off-intent work', () => {
  const it = (id: string, rank: number, status: Intent['status'] = 'active'): Intent => ({ id, why: `의도${id}`, what: '', how: '', rank, status, updated: 0, by: 'u_a' });
  const item = (code: string, intent?: string, status: PlanItem['status'] = '진행 중'): PlanItem =>
    ({ year: Y, code, scope: code, deliverable: '', done: '', depends_on: [], owners: [], status, start: '', due: '', updated: 0, by: 'u_a', log: [], ...(intent !== undefined ? { intent } : {}) });
  let n = 0;
  const w = (uid: string, plan: string, status = '진행 중', goal?: string): SharedWork => ({ id: `w${n++}`, uid, plan: `${Y}:${plan}`, fields: { status, title: `t${plan}`, ...(goal ? { goal } : {}) }, at: 0 });
  const rep = (k: number, f: () => SharedWork) => Array.from({ length: k }, f);
  const items = [item('1', 'i1'), item('1.1'), item('1.2', undefined, '완료'), item('2', 'i2'), item('2.1'), item('3', 'i3'), item('3.1'), item('4'), item('4.1'), item('5', 'i4'), item('5.1')];
  // 10 rows: i1 gets 2 (1 done), i2 gets 0, i3 gets 6, the unanchored 4.1 gets 1, the retired i4's 5.1 gets 1
  const work = [w('u_a', '1.1', '완료'), w('u_b', '1.2'), ...Array.from({ length: 6 }, (_, k) => w(k % 2 ? 'u_a' : 'u_b', '3.1', '진행 중', k < 3 ? '응답 시간 단축' : undefined)), w('u_b', '4.1'), w('u_a', '5.1')];
  assert.equal(work.length, 10);
  const a = intentAlignment(items, [it('i3', 3), it('i1', 1), it('i2', 2), it('i4', 4, 'retired'), it('i5', 5)], work, true);
  assert.deepEqual(a.intents.map(r => [r.id, r.items, r.items_done, r.work, r.work_done, r.share, r.flags]), [
    ['i1', 2, 1, 2, 1, 0.2, ['focus_drift']],   // 20% against i3's 60%: at least 20 points less than a lower-ranked one
    ['i2', 1, 0, 0, 0, 0, ['no_work', 'focus_drift']],
    ['i3', 1, 0, 6, 0, 0.6, []],
    ['i5', 0, 0, 0, 0, 0, ['no_plan']],
  ]);
  assert.deepEqual(a.unanchored, [`${Y} 4.1`, `${Y} 5.1`], 'no intent, or a retired one');
  assert.equal(a.off_intent_work, 2); assert.equal(a.total_work, 10);
  assert.deepEqual(a.off_intent_titles, ['t4.1', 't5.1'], 'what the off-intent work is');
  assert.deepEqual([a.intents[2].goals, a.intents[0].goals], [['응답 시간 단축'], []], 'the goals people shared, once each');
  assert.deepEqual(a.intents[2].people, ['u_a', 'u_b']);
  assert.deepEqual(a.by_person, [{ uid: 'u_a', rows: 5, by_intent: { i1: 1, i2: 0, i3: 3, i5: 0 }, off_intent: 1 }, { uid: 'u_b', rows: 5, by_intent: { i1: 1, i2: 0, i3: 3, i5: 0 }, off_intent: 1 }]);
  assert.equal(a.lines[0], '1순위 의도i1 — 계획 2개 · 작업 1/2행(20%) · 2명 | 순위보다 작업이 적음');
  assert.equal(a.lines.at(-1), '의도 없는 계획 2개 (4.1, 5.1) · 의도 밖 작업 2행');
  // the team's agent: counts, no one by name
  const anon = intentAlignment(items, [it('i1', 1)], work, false);
  assert.equal(anon.intents[0].people, 2); assert.equal('by_person' in anon, false);
  // exactly 20 points apart is flagged (whole percents: in floating point 0.4 + 0.2 > 0.6)
  const edge = intentAlignment([item('1', 'i1'), item('2', 'i2')], [it('i1', 1), it('i2', 2)], [...rep(4, () => w('u_a', '1')), ...rep(6, () => w('u_a', '2'))], true);
  assert.deepEqual(edge.intents.map(r => [r.share, r.flags]), [[0.4, ['focus_drift']], [0.6, []]]);
  const near = intentAlignment([item('1', 'i1'), item('2', 'i2')], [it('i1', 1), it('i2', 2)], [...rep(5, () => w('u_a', '1')), ...rep(6, () => w('u_a', '2'))], true);
  assert.deepEqual(near.intents.map(r => r.flags), [[], []], '45% against 55%: within 20 points');
});

test('alignment through the service: shared work counts under its plan item; owners and members by name, agents by count, guests not at all', async () => {
  const { plans, ledger, id } = await team();
  await plans.put(A, id, { intents: [{ why: '두 사람이 같은 원장으로 일한다' }, { why: '마감을 놓치지 않는다' }] });
  await plans.put(A, id, { items: [{ code: '1', scope: '팀 공간', intent: 'i1' }, { code: '1.1', scope: '공간 모델' }, { code: '2', scope: '일정', intent: 'i2' }, { code: '2.1', scope: '주간 점검' }, { code: '3', scope: '기타' }] });
  const a1 = (await ledger.add({ uid: 'u_a', clientName: 'Claude' }, row('공간 모델 구현'))).created;
  const b1 = (await ledger.add({ uid: 'u_b', clientName: 'ChatGPT' }, row('권한 표 정리', { goal: '팀원이 자기 행만 고쳐 쓰게' }))).created;
  const b2 = (await ledger.add({ uid: 'u_b', clientName: 'ChatGPT' }, row('잡무 정리'))).created;
  await plans.share(A, { year: a1.year, code: a1.code, space: id, plan: '1.1' });
  await plans.share(B, { year: b1.year, code: b1.code, space: id, plan: '1.1', share: ['title', 'status', 'goal'] });
  await plans.share(B, { year: b2.year, code: b2.code, space: id, plan: '3' });
  const m = await plans.align(B, id);
  assert.deepEqual(m.intents.map(r => [r.id, r.work, r.share, r.people, r.flags]), [['i1', 2, 0.67, ['u_a', 'u_b'], []], ['i2', 0, 0, [], ['no_work']]]);
  assert.deepEqual(m.intents[0].goals, ['팀원이 자기 행만 고쳐 쓰게'], 'a goal reaches the team only where its person shared it');
  assert.deepEqual(m.unanchored, [`${Y} 3`]); assert.equal(m.off_intent_work, 1); assert.deepEqual(m.off_intent_titles, ['잡무 정리']);
  // plan vs actual carries each item's intent, own or inherited, for those who may see the alignment
  const pv = await plans.actual(B, id);
  assert.deepEqual(pv.items.map(p => [p.code, p.intent, p.intent_inherited]), [['1', 'i1', false], ['1.1', 'i1', true], ['2', 'i2', false], ['2.1', 'i2', true], ['3', '', false]]);
  assert.ok((await plans.actual(G, id)).items.every(p => !('intent' in p)), 'not for guests');
  assert.deepEqual(m.by_person!.map(p => [p.uid, p.rows, p.off_intent]), [['u_a', 1, 0], ['u_b', 2, 1]]);
  const g = await plans.align(agent('u_a', 'Claude', ['wbs.read']), id);
  assert.ok(Array.isArray(g.intents[0].people), 'an agent acting for a member sees what the member sees');
  assert.equal(await outcome(plans.align(G, id)), 'forbidden', 'guests do not see the alignment');
  assert.equal(await outcome(plans.align(person('u_x'), id)), 'not_found');
});
