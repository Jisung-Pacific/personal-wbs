// The Firestore store against the emulator (skipped unless FIRESTORE_EMULATOR_HOST is set), checking what the memory
// store cannot prove: transactions that allocate codes under contention, history order, single-use codes and requests.
// run: firebase emulators:exec --only firestore "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test dist/test/firestore.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStore } from '../src/store/firestore.js';
import { LocalKek } from '../src/crypto/envelope.js';
import { createHash, randomBytes } from 'node:crypto';
import { Ledger } from '../src/wbs/service.js';
import { admit } from './support.js';

const on = !!process.env.FIRESTORE_EMULATOR_HOST;

test('Firestore store: concurrent adds get distinct codes; history keeps its order; codes are single use', { skip: !on }, async () => {
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), ledger = new Ledger(store), uid = 'u_' + Date.now();
  const actor = { uid, clientName: 'Claude' };
  await ledger.add(actor, { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '첫 작업 기록 테스트', start: '2026-11-06', status: '완료' });
  const words = ['알파 베타 감마', '델타 엡실론 제타', '에타 세타 이오타', '카파 람다 뮤', '뉴 크시 오미크론'];
  const made = await Promise.all(words.map(w => ledger.add(actor, { package: '5.3', task: `${w} 작업`, start: '2026-11-06', status: '진행 중' })));
  const codes = made.map(m => m.created.code).sort();
  assert.equal(new Set(codes).size, 5, 'no two adds share a code');
  assert.deepEqual(codes, ['5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6']);
  await ledger.update(actor, { year: '2026', code: '5.3.2', status: '완료' });
  const hist = await store.events(uid, '2026', '5.3.2');
  assert.deepEqual(hist.map(e => e.event), ['생성', '상태']);
  await store.putCode({ hash: 'h1', client_id: 'c', client_name: 'Claude', redirect_uri: 'https://x/cb', code_challenge: 'x', scope: 'wbs.read', resource: 'r', uid, expires_at: Date.now() + 60e3 });
  assert.ok(await store.takeCode('h1')); assert.equal(await store.takeCode('h1'), null);
  await store.putRefresh({ hash: 'r1', family: 'f', client_id: 'c', client_name: 'Claude', uid, scope: 'wbs.read', resource: 'r', expires_at: Date.now() + 60e3, used: false });
  assert.equal((await store.useRefresh('r1'))!.used, false); assert.equal((await store.useRefresh('r1'))!.used, true);
  await store.revokeFamily('f'); assert.equal(await store.useRefresh('r1'), null);
});

test('Firestore store: a team space keeps its ledger, key and members apart; deleting it shreds and removes them', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { spaceOwner } = await import('../src/store/types.js'), { person } = await import('../src/wbs/access.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), ledger = new Ledger(store), spaces = new Spaces(store);
  const a = 'u_a' + Date.now(), b = 'u_b' + Date.now();
  await ledger.add({ uid: a, clientName: 'Claude' }, { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '개인 원장 행 기록 테스트', start: '2026-11-18', status: '완료' });
  const s = await spaces.create(person(a), '팀 공간 시험');
  await admit(spaces, person(a), s.id, b, 'member');
  await admit(spaces, person(a), s.id, 'u_g' + Date.now(), 'guest', ['2026:4.3']);
  await spaces.proposeCharter(person(a), s.id, ['팀 작업은 기본 공개다.']);
  assert.equal((await spaces.charter(person(a), s.id)).open, false, 'the member has not agreed yet');
  await spaces.consentCharter(person(b), s.id, 1, true);
  assert.deepEqual((await store.charters(s.id)).map(c => c.status), ['active']);
  const team = (await spaces.view(person(b), s.id, 'write')).owner;
  await ledger.add({ uid: b, clientName: 'Claude' }, { area: '4 창업·제품', package: '4.3 서비스 개발', task: '팀 원장 행 기록 테스트', start: '2026-11-18', status: '진행 중' }, team);
  assert.equal((await store.space(s.id))!.name, '팀 공간 시험');
  assert.deepEqual((await store.spacesOf(b)).map(x => x.role), ['member']);
  assert.equal((await store.rows(team)).length, 1); assert.equal((await store.rows(a)).length, 1);
  assert.deepEqual((await store.members(s.id)).find(m => m.role === 'guest')!.projects, ['2026:4.3']);
  await spaces.transfer(person(a), s.id, b);
  assert.equal((await store.space(s.id))!.owner, b); assert.equal((await store.membership(s.id, a))!.role, 'member');
  await spaces.remove(person(b), s.id);
  assert.equal(await store.space(s.id), null); assert.equal((await store.rows(spaceOwner(s.id))).length, 0);
  assert.deepEqual(await store.spacesOf(a), []); assert.equal((await store.rows(a)).length, 1, 'the personal ledger stays');
});

test('Firestore store: the team plan, intents, cards, weekly briefs, links and shared copies are sealed, freeze on leaving and go with the space', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { Plans } = await import('../src/wbs/plan.js'), { person } = await import('../src/wbs/access.js');
  const { Views } = await import('../src/wbs/views.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys)), a = 'u_a' + Date.now(), b = 'u_b' + Date.now();
  const s = await spaces.create(person(a), '계획 시험');
  await admit(spaces, person(a), s.id, b, 'member');
  await spaces.proposeCharter(person(a), s.id, ['공유는 필드 단위다.']); await spaces.consentCharter(person(b), s.id, 1, true);
  await plans.put(person(a), s.id, { intents: [{ why: '저장소를 믿을 수 있게' }], items: [{ code: '1', year: '2026', scope: '팀 계획', intent: 'i1' }, { code: '1.1', year: '2026', scope: '저장소', status: '진행 중', due: '2026-11-30' }] });
  assert.deepEqual((await store.intents(s.id)).map(i => [i.id, i.why, i.status]), [['i1', '저장소를 믿을 수 있게', 'active']]);
  const r = (await ledger.add({ uid: b, clientName: 'Claude' }, { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '저장소 구현: 비공개 상세', start: '2026-11-19', status: '진행 중' })).created;
  await plans.share(person(b), { year: r.year, code: r.code, space: s.id, plan: '1.1' });
  await ledger.update({ uid: b, clientName: 'Claude' }, { year: r.year, code: r.code, status: '완료' });
  const v = await plans.actual(person(a), s.id, '2026');
  assert.deepEqual([v.items[1].actual.rows, v.items[1].actual.status], [1, '완료']);
  await plans.actual(person(a), s.id, '2026');   // a second read merges into the same day's sealed log entry
  const seen = (await views.mine(person(b))).log[0].entries[0];
  assert.deepEqual([seen.viewer, seen.count, seen.rows], [a, 2, 1]);
  assert.equal((await store.links(b)).length, 1);
  // cards (4.2): sealed per person under the space key, the employee-mode flag on the space, gone with the space
  const card = { uid: a, sections: ['C', 'direction'] as ('C' | 'direction')[], scores: { C: 16 }, measured: 1, direction: { role: '제품', grow: '', ask: '' }, rebuttal: { work: '학회 준비' }, published: 1, updated: 1 };
  await store.putCard(s.id, card);
  assert.deepEqual(await store.cards(s.id), [card]);
  assert.equal(await store.cardsOff(s.id), false); await store.setCardsOff(s.id, true); assert.equal(await store.cardsOff(s.id), true);
  await store.setCardsOff(s.id, false);
  // weekly briefs (4.3): sealed per week under the space key, listed in order, every team space found for the run
  const brief = { week: '2026-W46', from: '2026-11-09', to: '2026-11-15', as_of: '2026-11-16', generated: 1,
    progress: { rows_done: 1, rows_started: 1, items_done: [] }, bottlenecks: [], blockers: [], risks: [],
    intents: { lines: [], items: [], active: 0, off_intent_rows: 0, unanchored: 0 }, next: [], lines: ['진척: 공유 행 완료 1 · 시작 1 · 완료된 계획 항목 없음'] };
  await store.putWeekly(s.id, brief); await store.putWeekly(s.id, { ...brief, week: '2026-W45' });
  assert.deepEqual(await store.weekly(s.id, '2026-W46'), brief);
  assert.deepEqual(await store.weeklies(s.id), ['2026-W45', '2026-W46']);
  assert.ok((await store.teamSpaceIds()).includes(s.id));
  await store.removeWeekly(s.id, '2026-W45'); assert.deepEqual(await store.weeklies(s.id), ['2026-W46']);
  // the team master agent (4.5): a delegation per client (a URL client id too), proposals decided in a transaction, reports by week
  await store.putDelegation(s.id, { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_name: 'Claude', by: a, at: 1, active: true, family: 'f1' });
  assert.deepEqual((await store.delegations(s.id)).map(d => [d.client_name, d.active, d.family]), [['Claude', true, 'f1']]);
  const prop = { id: 'p_1', items: [{ code: '1', status: '완료' }], why: '하위가 모두 끝남', refs: [], client: 'Claude', client_id: 'c', at: 1,
    preview: [{ year: '2026', code: '1', created: false, changes: ['상태 진행 중 → 완료'] }], approvers: [a], decisions: {}, base: { '2026:1': 1 }, status: 'open' as const };
  await store.putProposal(s.id, prop);
  assert.equal(await store.proposalTx(s.id, 'p_1', async p => ({ put: { ...p!, status: 'declined' as const }, out: p!.status })), 'open');
  assert.equal((await store.proposals(s.id))[0].status, 'declined');
  await store.putReport(s.id, { week: '2026-W46', text: '지난주 결제 연동이 끝났다.', recommendations: [], client: 'Claude', client_id: 'c', at: 1, status: 'proposed' });
  assert.equal((await store.report(s.id, '2026-W46'))!.status, 'proposed'); assert.equal((await store.reports(s.id)).length, 1);
  await spaces.removeMember(person(b), s.id, b);
  assert.ok((await store.shared(s.id))[0].frozen, 'the copy stays with the team, frozen');
  await spaces.remove(person(a), s.id);
  assert.deepEqual([(await store.plan(s.id)).length, (await store.shared(s.id)).length, (await store.intents(s.id)).length, (await store.cards(s.id)).length, (await store.weeklies(s.id)).length], [0, 0, 0, 0, 0]);
});

test('Firestore store: invitations — a link found by its hash and used once under contention, an account invitation in its list, lookups gone with the space', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { person } = await import('../src/wbs/access.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), spaces = new Spaces(store);
  const sha = (x: string) => createHash('sha256').update(x).digest('hex'), n = Date.now();
  const a = `u_a${n}`, c = `u_c${n}`;
  const s = await spaces.create(person(a), '초대 시험');
  await spaces.proposeCharter(person(a), s.id, ['공유는 필드 단위다.']);
  const link = await spaces.invite(person(a), s.id, { role: 'member' });
  const acct = await spaces.invite(person(a), s.id, { role: 'guest', projects: ['2026:4.3'], for: c });
  assert.deepEqual(await store.inviteByHash(sha(link.code!)), { space: s.id, id: link.id });
  assert.deepEqual(await store.invitesFor(c), [{ space: s.id, id: acct.id }]);
  assert.equal((await store.invite(s.id, link.id))!.hash, sha(link.code!));
  // two people race one link: exactly one gets in, and the link is gone from the lookup
  const tries = await Promise.allSettled([`u_b${n}`, `u_d${n}`].map(u => spaces.join(person(u), { code: link.code! }, 1)));
  assert.equal(tries.filter(t => t.status === 'fulfilled').length, 1);
  assert.equal((await store.members(s.id)).length, 2);
  assert.equal(await store.inviteByHash(sha(link.code!)), null);
  // the account invitation: joined in one step with the account's own list of spaces kept in step
  await spaces.join(person(c), { space: s.id, invite: acct.id });
  assert.deepEqual(await store.invitesFor(c), []);
  assert.deepEqual([(await store.membership(s.id, c))!.projects, (await store.spacesOf(c)).map(x => x.id)], [['2026:4.3'], [s.id]]);
  assert.deepEqual((await spaces.invites(person(a), s.id)).map(i => i.status).sort(), ['joined', 'joined']);
  // open invitations' lookups go with the space
  const l2 = await spaces.invite(person(a), s.id, { role: 'member' }), a2 = await spaces.invite(person(a), s.id, { role: 'member', for: `u_e${n}` });
  await spaces.remove(person(a), s.id);
  assert.equal(await store.inviteByHash(sha(l2.code!)), null);
  assert.deepEqual(await store.invitesFor(a2.for!), []);
});

test('Firestore store: deleting an account leaves a hashed tombstone and takes its refresh tokens, ledger and invitation list', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { person } = await import('../src/wbs/access.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), ledger = new Ledger(store), spaces = new Spaces(store);
  const n = Date.now(), a = `u_a${n}`, o = `u_o${n}`;
  await ledger.add({ uid: a, clientName: 'Claude' }, { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '지워질 개인 원장 행', start: '2026-11-20', status: '진행 중' });
  for (const h of ['ra', 'rb']) await store.putRefresh({ hash: `${h}${n}`, family: `f${h}${n}`, client_id: 'c', client_name: 'Claude', uid: a, scope: 'wbs.read', resource: 'r', expires_at: n + 60e3, used: false });
  const s = await spaces.create(person(o), '초대한 팀'); await spaces.invite(person(o), s.id, { role: 'member', for: a });
  assert.equal(await store.deletedAt(a), null);
  const out = await spaces.deleteAccount(a, { now: n });
  assert.equal(out.at, n); assert.equal(await store.deletedAt(a), n);
  const tomb = await (store as unknown as { db: { collection(c: string): { doc(id: string): { get(): Promise<{ exists: boolean; data(): Record<string, unknown> }> } } } }).db
    .collection('deleted_accounts').doc(createHash('sha256').update(a).digest('hex')).get();
  assert.ok(tomb.exists); assert.deepEqual(Object.keys(tomb.data()).sort(), ['at', 'expire'], 'the plain account id is not stored');
  assert.equal(await store.useRefresh(`ra${n}`), null); assert.equal(await store.useRefresh(`rb${n}`), null);
  assert.deepEqual(await store.rows(a), []); assert.deepEqual(await store.invitesFor(a), []);
});

test('Firestore store: a display title is sealed under the space key and survives a hand-over', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { person } = await import('../src/wbs/access.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), spaces = new Spaces(store);
  const n = Date.now(), o = `u_o${n}`, m = `u_m${n}`;
  const s = await spaces.create(person(o), '직함 팀');
  const inv = await spaces.invite(person(o), s.id, { role: 'member', for: m });
  await spaces.join(person(m), { space: s.id, invite: inv.id });
  await spaces.setTitle(person(m), s.id, m, '공동 창업자');
  const raw = (await (store as unknown as { db: { collection(c: string): { doc(id: string): { collection(c: string): { doc(id: string): { get(): Promise<{ data(): Record<string, unknown> }> } } } } } }).db
    .collection('spaces').doc(s.id.replace(/^spaces\//, '')).collection('members').doc(m).get()).data();
  assert.ok(raw.enc); assert.equal(JSON.stringify(raw).includes('공동 창업자'), false, 'the title is not stored in the clear');
  await spaces.transfer(person(o), s.id, m);
  assert.equal((await store.membership(s.id, m))?.title, '공동 창업자');
  assert.equal((await store.members(s.id)).find(x => x.uid === m)?.role, 'owner');
});
