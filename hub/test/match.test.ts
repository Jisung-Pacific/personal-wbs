// Matching recorded work to a team plan item (execution WBS 3.8): character bigrams, so Korean particles and spacing do
// not hide a match; a link without asking only for a clear, specific match; otherwise a pending link with suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans, matchPlan } from '../src/wbs/plan.js';
import { person } from '../src/wbs/access.js';
import type { PlanItem } from '../src/store/types.js';

const item = (code: string, scope: string, deliverable = '', status = '진행 중'): PlanItem =>
  ({ year: '2026', code, scope, deliverable, done: '', depends_on: [], owners: [], status, start: '', due: '', updated: 0, by: 'u_a', log: [] });
const PLAN = [item('1', '출시 준비'), item('1.1', '결제 연동', '정기 결제와 환불'), item('1.2', '가입·로그인 흐름', '이메일·소셜 로그인, 비밀번호 재설정'),
  item('1.3', '관리자 화면', '환불 처리 화면'), item('2', '첫 고객 인터뷰', '질문지와 인터뷰 10회', '완료'), item('3', '팀 운영', '', '백로그')];

test('ranking: the item whose own words the work carries, particles and spacing aside; done and parked items are not candidates', () => {
  const r = matchPlan('정기결제를 PG에 연동했고 환불 API까지 붙임', PLAN);
  assert.equal(r[0].code, '1.1'); assert.ok(r[0].score >= 0.5, String(r[0].score));
  assert.equal(matchPlan('질문지 수정과 인터뷰 10회 일정 확정', PLAN).some(c => c.code === '2'), false, 'a finished item is not offered');
  assert.equal(matchPlan('팀 운영 규칙 정리', PLAN).some(c => c.code === '3'), false, 'nor a parked one');
  assert.deepEqual(matchPlan('', PLAN), []);
  assert.deepEqual(matchPlan('점심 메뉴 고르기', PLAN), [], 'nothing in common, nothing offered');
});

test('recording for a team: named item, a confident match, or a pending link that the team does not see', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys)), A = person('u_a');
  const s = await spaces.create(A, '시범 팀');
  await spaces.proposeCharter(A, s.id, ['공유는 필드 단위다.']);
  await plans.put(A, s.id, { items: PLAN.map(p => ({ year: p.year, code: p.code, scope: p.scope, deliverable: p.deliverable, status: p.status as '진행 중' })) });
  const add = async (task: string) => (await ledger.add({ uid: 'u_a', clientName: 'Claude' }, { area: '4 창업·제품', package: '4.3 서비스 개발', task, start: '2026-11-18', status: '진행 중' })).created;
  const r1 = await add('관리자 화면 와이어프레임');
  const n1 = await plans.recordFor(A, s.id, r1, '1.3');
  assert.equal(n1.status, 'linked');
  const r2 = await add('정기 결제 연동 시험 통과');
  const n2 = await plans.recordFor(A, s.id, r2);
  assert.equal(n2.status, 'linked'); assert.equal((n2 as { matched: { plan: string } }).matched.plan, '1.1');
  const r3 = await add('경쟁 서비스 가격표 정리');
  const n3 = await plans.recordFor(A, s.id, r3);
  assert.equal(n3.status, 'pending');
  assert.equal((await store.shared(s.id)).length, 2, 'the pending row is not at the team');
  await ledger.update({ uid: 'u_a', clientName: 'Claude' }, { year: r3.year, code: r3.code, status: '완료' });
  assert.equal((await store.shared(s.id)).length, 2, 'changing a pending row sends nothing');
  const mine = await plans.mine(A, s.id);
  assert.deepEqual(mine.map(l => [l.code, !!(l as { pending?: boolean }).pending, l.team_copy]), [[r1.code, false, 'live'], [r2.code, false, 'live'], [r3.code, true, 'none']]);
  await plans.share(A, { year: r3.year, code: r3.code, space: s.id, plan: '1' });
  assert.equal((await store.shared(s.id)).length, 3, 'linked once the person picks the item');
});
