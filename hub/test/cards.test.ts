// Work-style and direction cards (execution WBS 4.2): the Mini-IPIP scoring, cards as people's own act (agents neither
// fill, publish nor read them), symmetric disclosure section by section, work indicators inferred only from the rows
// shared with that team, rebuttals beside them, employee mode, leaving, and the view log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Views } from '../src/wbs/views.js';
import { Cards, MINI_IPIP, scoreMiniIpip, workIndicators } from '../src/wbs/cards.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import type { SharedWork } from '../src/store/types.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), C = person('u_c'), G = person('u_g');
const team = (s: string): Caller => ({ kind: 'team_agent', space: s, client: 'team-master' });
/** Answers that give each trait the wanted sum (default 12): the sum spread over its four items as keyed values 1–5,
 *  each answered as given (+) or as 6 − value (−). */
const answersFor = (want: Partial<Record<'E' | 'A' | 'C' | 'N' | 'I', number>>) => {
  const seen: Record<string, number> = {};
  return MINI_IPIP.map(it => {
    const t = want[it.trait] ?? 12, k = seen[it.trait] = (seen[it.trait] ?? -1) + 1, v = Math.floor(t / 4) + (k < t % 4 ? 1 : 0);
    return it.plus ? v : 6 - v;
  });
};

async function setup() {
  const store = new MemoryStore(), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views), cards = new Cards(store, spaces, views);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const s = await spaces.create(A, '시범 팀');
  for (const [u, role] of [['u_b', 'member'], ['u_c', 'member'], ['u_g', 'guest']] as const) await admit(spaces, A, s.id, u, role, role === 'guest' ? ['2026:4.3'] : undefined);
  await spaces.proposeCharter(A, s.id, ['공유는 필드 단위다.']);
  const open = async () => { await spaces.consentCharter(B, s.id, 1, true); await spaces.consentCharter(C, s.id, 1, true); };   // the charter in force
  return { store, spaces, plans, cards, ledger, id: s.id, open };
}

test('Mini-IPIP scoring: four items a trait, reverse-keyed as 6 − x, sums 4–20; only twenty answers of 1–5', () => {
  assert.deepEqual(scoreMiniIpip(Array(20).fill(3)), { E: 12, A: 12, C: 12, N: 12, I: 12 });
  assert.deepEqual(scoreMiniIpip(answersFor({ E: 20, C: 4, I: 16 })), { E: 20, A: 12, C: 4, N: 12, I: 16 });
  assert.deepEqual(MINI_IPIP.filter(i => !i.plus).map(i => i.n), [6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20], 'reverse-keyed items as the IPIP key has them');
  for (const bad of [Array(19).fill(3), [...Array(19).fill(3), 6], [...Array(19).fill(3), 2.5]]) assert.throws(() => scoreMiniIpip(bad), LedgerError);
});

test('people only: agents neither answer, publish nor read; guests do not see cards; the charter gate comes first', async () => {
  const { spaces, cards, id } = await setup();
  const ag = agent('u_a', 'Claude', ['wbs.read', 'wbs.write']);
  assert.equal(await outcome(cards.assess(ag, Array(20).fill(3))), 'forbidden');
  assert.equal(await outcome(cards.publish(ag, id, { sections: ['direction'], direction: { role: 'x' } })), 'forbidden');
  assert.equal(await outcome(cards.list(ag, id)), 'forbidden');
  assert.equal(await outcome(cards.list(B, id)), 'consent_required', 'not before agreeing to the charter');
  await spaces.consentCharter(B, id, 1, true); await spaces.consentCharter(C, id, 1, true);
  assert.equal(await outcome(cards.list(G, id)), 'forbidden', 'a guest does not see cards');
  assert.equal(await outcome(cards.list(person('u_x'), id)), 'not_found');
});

test('symmetric, section by section; scores only in the person\'s own space; a direction-only card needs no test', async () => {
  const { store, cards, id, open } = await setup();
  await open();
  assert.equal(await outcome(cards.publish(A, id, {})), 'invalid', 'traits need an assessment first');
  await cards.assess(A, answersFor({ E: 18, A: 14, C: 16, N: 8, I: 15 }));
  const kept = await store.secret<Record<string, unknown>>('u_a', 'big5');
  assert.deepEqual(Object.keys(kept!).sort(), ['at', 'instrument', 'scores'], 'the answers are not kept');
  await cards.publish(A, id, { direction: { role: '제품 책임', grow: '데이터 설계', ask: '주 1회 짧은 리뷰' }, rebuttal: { work: '11월은 학회 준비로 공유 행이 적음' } });
  await cards.assess(B, answersFor({ C: 20, N: 16 }));
  await cards.publish(B, id, { sections: ['C', 'N', 'direction'], direction: { ask: '결정은 글로 남기기' } });
  await cards.publish(C, id, { sections: ['direction'], direction: { role: '디자인' } });   // no assessment: direction only
  const byA = await cards.list(A, id), byB = await cards.list(B, id), byC = await cards.list(C, id);
  const of = (l: typeof byA, u: string) => l.cards.find(c => c.uid === u)!;
  assert.deepEqual(byA.mine!.sections, ['E', 'A', 'C', 'I', 'direction'], 'by default four traits and the direction; emotional stability only by choice');
  assert.deepEqual(of(byA, 'u_b').traits.map(t => t.trait), ['C'], 'A sees only what A also shows: not B\'s N');
  assert.deepEqual(of(byB, 'u_a').traits.map(t => [t.trait, t.score]), [['C', 16]], 'B sees only C of A');
  assert.ok(of(byB, 'u_a').direction && of(byA, 'u_b').direction);
  assert.deepEqual(of(byC, 'u_a').traits, [], 'C, showing no traits, sees none');
  assert.equal(of(byB, 'u_a').rebuttal.work, '11월은 학회 준비로 공유 행이 적음', 'the rebuttal travels with the card');
  const n = (byB.mine!.traits.find(t => t.trait === 'N'))!;
  assert.deepEqual([n.label, n.score, n.raw], ['정서 안정성', 8, 16], 'neuroticism shown as emotional stability (24 − N)');
  // the team's delegated agent sees what is published; someone without a card sees none
  const d = await cards.list(team(id), id);
  assert.deepEqual(d.cards.find(c => c.uid === 'u_b')!.traits.map(t => t.trait), ['C', 'N']);
  await cards.withdraw(C, id);
  const none = await cards.list(C, id);
  assert.deepEqual([none.cards.length, none.mine], [0, null]); assert.equal(none.others_published, 2);
  // no averages, ranks or totals anywhere in the output
  assert.doesNotMatch(JSON.stringify(byA), /average|rank|percentile|평균|순위/);
});

test('work indicators come only from the rows shared with that team, marked inferred', async () => {
  const { plans, cards, ledger, id, open } = await setup();
  await open();
  await plans.put(A, id, { items: [{ year: '2026', code: '1', scope: '시범' }] });
  const add = async (uid: string, task: string, start: string, end: string, due: string) =>
    (await ledger.add({ uid, clientName: 'Claude' }, { area: '4 창업·제품', package: '4.3 서비스 개발', task, start, end, due, status: '완료' })).created;
  for (const [t, s, e, d] of [['API 문서', '2026-11-02', '2026-11-06', '2026-11-06'], ['권한 표', '2026-11-09', '2026-11-13', '2026-11-12'], ['요금 비교', '2026-11-16', '2026-11-20', '2026-11-20']] as const) {
    const r = await add('u_b', t, s, e, d);
    await plans.share(B, { year: r.year, code: r.code, space: id, plan: '1' });
  }
  await add('u_b', '개인 일', '2026-11-01', '2026-11-30', '2026-11-30');   // personal, never shared: no effect
  await cards.publish(B, id, { sections: ['direction'], direction: { role: '백엔드' } });
  await cards.publish(A, id, { sections: ['direction'], direction: { role: '제품' } });
  const w = (await cards.list(A, id)).cards.find(c => c.uid === 'u_b')!.work;
  assert.deepEqual([w.rows, w.done, w.median_days, w.on_time, w.usual_finish_day, w.inferred], [3, 3, 4, { kept: 2, of: 3 }, '금', true]);
  assert.match(w.line, /공유 행 3 · 완료 3 · 열린 행 0 · 완료까지 중앙값 4일 · 마감 지킴 2\/3 · 주로 금요일에 마침/);
  assert.equal(workIndicators([] as SharedWork[]).line, '공유 행 0 · 완료 0 · 열린 행 0');
});

test('employee mode removes every card at once and is the owner\'s switch; leaving takes one\'s card off; reads are noted', async () => {
  const { store, spaces, cards, id, open } = await setup();
  await open();
  await cards.publish(A, id, { sections: ['direction'], direction: { role: '제품' } });
  await cards.publish(B, id, { sections: ['direction'], direction: { role: '백엔드' } });
  await cards.list(B, id);   // B reads A's card: noted in A's view log
  const log = await store.views('u_a', '2000-01-01');
  assert.deepEqual(log.flatMap(d => d.entries.map(e => [e.viewer, e.what])), [['u_b', 'card']]);
  assert.equal(await outcome(cards.setEmployeeMode(B, id, true)), 'forbidden', 'a member cannot switch it');
  const on = await cards.setEmployeeMode(A, id, true);
  assert.deepEqual([on.employee_mode, on.removed], [true, 2]);
  assert.equal(await outcome(cards.publish(B, id, { sections: ['direction'], direction: { role: 'x' } })), 'forbidden');
  assert.equal((await cards.list(A, id)).employee_mode, true);
  await cards.setEmployeeMode(A, id, false);
  await cards.publish(B, id, { sections: ['direction'], direction: { role: '백엔드' } });
  await spaces.removeMember(B, id, 'u_b');
  assert.deepEqual((await store.cards(id)).map(c => c.uid), [], 'leaving took the card off');
});
