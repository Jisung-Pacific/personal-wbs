// The team charter as the strategy document sets it: a team space opens only when everyone has agreed to a charter of
// at most 9 lines; each newcomer enters after agreeing; a change takes effect only with everyone's agreement; every
// version stays in the record with dated answers. Agents read the charter but never agree or propose. A newcomer joins
// by an invitation and agrees on joining (spaces.join).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), C = person('u_c'), D = person('u_d'), G = person('u_g');
/** The default charter of the strategy document (9 lines). */
const CHARTER = [
  '원본은 둘이다. 팀 계획 원장(프로젝트 WBS, 팀 소유)과 개인 실적 원장(PP WBS, 본인 소유). 둘 다 허브가 실시간 원본이다.',
  '연결은 코드로 한다. 개인 행은 팀 계획 코드를 참조로 달고, 팀 화면은 참조된 행을 구독해 계획 대비 실적을 그린다.',
  '공유는 필드 단위다. 팀 코드가 붙은 행은 제목·상태·날짜·산출물 링크만 팀에 보이고, 메모·근거·막힘 상세는 본인이 고를 때만 보인다.',
  '팀 작업은 기본 공개다. 팀 코드가 붙은 행은 팀원 모두가 보고, 팀 코드가 없는 행은 개인 공간에만 있다. 누구도 남의 범위를 바꾸지 못한다.',
  '에이전트는 제안하고 사람은 승인한다. 개인 행은 본인이, 팀 계획 변경은 그 작업의 A가 승인한다. 행마다 기록자(사람 또는 에이전트 ID·세션)를 남긴다.',
  '성향과 방향성은 서로 본다. 업무 성향 지표와 의도 정렬(왜·무엇을·어떻게)은 팀원끼리 대칭으로 공개하고, 카드마다 본인이 반론을 단다. 감정 기록과 원문 대화는 개인 공간에만 남는다.',
  '평가는 모두가 같은 기준으로 받는다. 작업·산출물, 의도 정렬, 성향·방향성을 분기마다 상호 리뷰로 보고, 순위표와 자동 점수는 두지 않는다. 지분·역할 같은 결정은 사람이 근거를 남기고 내린다.',
  '열람은 본인에게 보인다. 누가 언제 내 행과 카드를 봤는지 본인이 본다.',
  '떠날 때는 나눈다. 개인 원장은 본인이 가져가고, 팀 계획 원장과 공유된 필드의 사본은 팀에 남는다. 가져가는 사본에서 팀 기밀 상세는 가려 경력 기록 수준으로 남긴다.',
];
async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), s = await spaces.create(A, '내 팀');
  await admit(spaces, A, s.id, 'u_b', 'member'); await admit(spaces, A, s.id, 'u_c', 'member');
  await admit(spaces, A, s.id, 'u_g', 'guest', ['2026:4.3']);
  return { store, spaces, id: s.id };
}

test('the space opens only when everyone has agreed; an objection holds it; a newcomer enters after agreeing', async () => {
  const { spaces, id } = await team();
  assert.equal(await outcome(spaces.view(A, id, 'read')), 'consent_required', 'no charter yet: closed even to the owner');
  const p = await spaces.proposeCharter(A, id, CHARTER, '기본 헌장');
  assert.equal(p.open, false); assert.equal(p.proposal!.lines.length, 9);
  assert.deepEqual([(p.proposal!.agreed as { uid: string }[]).map(x => x.uid), p.proposal!.waiting], [['u_a'], ['u_b', 'u_c']], 'the guest is not asked');

  await spaces.consentCharter(B, id, 1, true);
  const held = await spaces.consentCharter(C, id, 1, false);
  assert.deepEqual([held.open, held.proposal!.objected, held.proposal!.waiting], [false, ['u_c'], []]);
  for (const who of [A, B, G]) assert.equal(await outcome(spaces.view(who, id, 'read')), 'consent_required');

  const opened = await spaces.consentCharter(C, id, 1, true);   // answering again replaces the objection
  assert.equal(opened.open, true); assert.equal(opened.in_force!.version, 1);
  assert.deepEqual((opened.in_force!.agreed as { uid: string; at: number }[]).map(x => x.uid), ['u_a', 'u_b', 'u_c']);
  assert.ok((opened.in_force!.agreed as { at: number }[]).every(x => x.at > 0), 'every agreement is dated');
  for (const who of [A, B, C, G]) assert.equal(await outcome(spaces.view(who, id, 'read')), 'ok');

  // a newcomer joins by an invitation, agreeing to the version in force on joining (the agreement is dated with the rest)
  const inv = await spaces.invite(A, id, { role: 'member', for: 'u_d' }), ref = { space: id, invite: inv.id };
  assert.equal(await outcome(spaces.join(D, ref)), 'consent_required', 'a member joins agreeing to the charter in force');
  assert.equal(await outcome(spaces.join(D, ref, 2)), 'consent_required', 'and to the version in force, not another');
  await spaces.join(D, ref, 1);
  assert.equal(await outcome(spaces.view(D, id, 'write')), 'ok');
  assert.deepEqual(((await spaces.charter(A, id)).in_force!.agreed as { uid: string }[]).map(x => x.uid), ['u_a', 'u_b', 'u_c', 'u_d']);
  // a guest made a member: listed as needing consent, kept out until agreeing; the others are unaffected
  await spaces.setMember(A, id, 'u_g', 'member');
  const row = (await spaces.list(G)).find(x => x.id === id) as { charter?: unknown };
  assert.deepEqual(row.charter, { in_force: 1, needs_consent: true, proposal: null });
  assert.equal(await outcome(spaces.view(G, id, 'read')), 'consent_required');
  assert.equal(await outcome(spaces.view(B, id, 'write')), 'ok');
  await spaces.consentCharter(G, id, 1, true);
  assert.equal(await outcome(spaces.view(G, id, 'write')), 'ok');
  assert.equal(await outcome(spaces.consentCharter(G, id, 1, false)), 'invalid', 'the version in force is changed by a proposal, not an objection');
});

test('a change takes effect only with everyone\'s agreement, and every version stays in the record', async () => {
  const { spaces, id } = await team();
  await spaces.proposeCharter(A, id, CHARTER); await spaces.consentCharter(B, id, 1, true); await spaces.consentCharter(C, id, 1, true);

  const v2 = CHARTER.map((l, i) => i === 7 ? '열람은 본인에게 보인다. 누가 언제 내 행과 카드를 봤는지 본인이 보고, 열람 기록은 1년 보관한다.' : l);
  await spaces.proposeCharter(B, id, v2, '열람 기록 보관 기간');
  assert.equal(await outcome(spaces.proposeCharter(C, id, CHARTER)), 'invalid', 'one proposal at a time');
  assert.equal(await outcome(spaces.view(C, id, 'read')), 'ok', 'the version in force still holds while a change is open');
  assert.equal(await outcome(spaces.withdrawCharter(C, id, 2)), 'forbidden', 'only the proposer or the owner withdraws');
  await spaces.withdrawCharter(A, id, 2);

  await spaces.proposeCharter(C, id, v2, '다시 제안');
  await spaces.consentCharter(A, id, 3, true);
  assert.equal((await spaces.charter(A, id)).in_force!.version, 1, 'one answer missing: nothing changes');
  const done = await spaces.consentCharter(B, id, 3, true);
  assert.equal(done.in_force!.version, 3); assert.equal(done.in_force!.lines[7], v2[7]);
  assert.deepEqual(done.history.map(h => `${h.version}:${h.status}`), ['1:superseded', '2:withdrawn', '3:active']);
  assert.ok(done.history.every(h => h.at > 0) && done.history[0].closed_at! >= done.history[2].active_at!);

  // the last person still to answer leaves: the proposal settles without them
  await spaces.proposeCharter(A, id, CHARTER.slice(0, 8), '아홉째 줄 삭제');
  await spaces.consentCharter(B, id, 4, true);
  await spaces.removeMember(C, id, 'u_c');
  assert.equal((await spaces.charter(A, id)).in_force!.version, 4);
});

test('limits: at most 9 lines; guests neither read nor answer; agents read but never agree or propose; a team agent sees counts only', async () => {
  const { spaces, id } = await team();
  assert.equal(await outcome(spaces.proposeCharter(A, id, [...CHARTER, '열 번째 줄'])), 'invalid');
  assert.equal(await outcome(spaces.proposeCharter(A, id, ['  '])), 'invalid');
  assert.equal(await outcome(spaces.proposeCharter(A, id, ['가'.repeat(301)])), 'invalid');
  assert.equal(await outcome(spaces.proposeCharter(G, id, CHARTER)), 'forbidden');
  assert.equal(await outcome(spaces.charter(G, id)), 'forbidden');
  const bot: Caller = agent('u_b', 'Claude', ['wbs.read', 'wbs.write']);
  assert.equal(await outcome(spaces.proposeCharter(bot, id, CHARTER)), 'forbidden');
  await spaces.proposeCharter(A, id, CHARTER);
  assert.equal(await outcome(spaces.consentCharter(bot, id, 1, true)), 'forbidden', 'agreeing is the person\'s own act');
  assert.deepEqual((await spaces.charter(bot, id)).proposal!.waiting, ['u_b', 'u_c'], 'an agent of a member reads the charter and who is waiting');
  const T: Caller = { kind: 'team_agent', space: id, client: 'team-master' };
  const seen = await spaces.charter(T, id);
  assert.deepEqual([seen.proposal!.agreed, seen.proposal!.waiting, seen.proposal!.by], [1, 2, undefined], 'counts, not names');
});
