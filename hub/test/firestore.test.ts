// The Firestore store against the emulator (skipped unless FIRESTORE_EMULATOR_HOST is set), checking what the memory
// store cannot prove: transactions that allocate codes under contention, history order, single-use codes and requests.
// run: firebase emulators:exec --only firestore "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test dist/test/firestore.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStore } from '../src/store/firestore.js';
import { LocalKek } from '../src/crypto/envelope.js';
import { randomBytes } from 'node:crypto';
import { Ledger } from '../src/wbs/service.js';

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
  await spaces.setMember(person(a), s.id, b, 'member');
  await spaces.setMember(person(a), s.id, 'u_g' + Date.now(), 'guest', ['2026:4.3']);
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

test('Firestore store: the team plan, intents, links and shared copies are sealed, freeze on leaving and go with the space', { skip: !on }, async () => {
  const { Spaces } = await import('../src/wbs/spaces.js'), { Plans } = await import('../src/wbs/plan.js'), { person } = await import('../src/wbs/access.js');
  const { Views } = await import('../src/wbs/views.js');
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys)), a = 'u_a' + Date.now(), b = 'u_b' + Date.now();
  const s = await spaces.create(person(a), '계획 시험');
  await spaces.setMember(person(a), s.id, b, 'member');
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
  await spaces.removeMember(person(b), s.id, b);
  assert.ok((await store.shared(s.id))[0].frozen, 'the copy stays with the team, frozen');
  await spaces.remove(person(a), s.id);
  assert.deepEqual([(await store.plan(s.id)).length, (await store.shared(s.id)).length, (await store.intents(s.id)).length], [0, 0, 0]);
});
