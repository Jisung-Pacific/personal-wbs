// Team spaces over the in-memory store: roles, the 10-person cap, leaving, handing over, deleting a space or an account,
// and the personal ledger staying byte for byte what it was. A space's data key is its own, apart from every account's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { spaceOwner } from '../src/store/types.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { MAX_PEOPLE, PERSONAL, Spaces } from '../src/wbs/spaces.js';
import { Envelope, LocalKek, MemoryDekStore } from '../src/crypto/envelope.js';

/** The LedgerError code a call fails with, or "ok". */
const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const task = (t: string) => ({ package: '4.3 서비스 개발', area: '4 창업·제품', task: t, start: '2026-11-18', status: '진행 중' as const });
const claude = (uid: string) => ({ uid, clientName: 'Claude' });

test('team space: owner, members and guests; outsiders see nothing; the personal ledger is untouched', async () => {
  const store = new MemoryStore(), ledger = new Ledger(store), spaces = new Spaces(store);
  await ledger.add(claude('u_a'), task('개인 원장 행: 허브 왕복 검증'));
  const before = await ledger.exportCsv('u_a');

  const s = await spaces.create('u_a', '  연구실   시범 ');
  assert.match(s.id, /^s_[A-Za-z0-9_-]{22}$/); assert.equal(s.name, '연구실 시범');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_b', 'member')), 'ok');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_g', 'guest')), 'ok');

  // members write to the team ledger; a guest reads it; an outsider is told the space does not exist
  const team = await spaces.ledgerFor('u_b', s.id, 'write');
  assert.equal(team, spaceOwner(s.id));
  const made = await ledger.add(claude('u_b'), task('팀 계획: 공간 모델 설계와 단위 시험'), team);
  assert.equal(made.created.code, '4.3.1');
  assert.equal((await ledger.search(await spaces.ledgerFor('u_g', s.id, 'read'), {})).total, 1);
  assert.equal(await outcome(spaces.ledgerFor('u_g', s.id, 'write')), 'forbidden');
  assert.equal(await outcome(spaces.ledgerFor('u_x', s.id, 'read')), 'not_found');
  assert.equal(await outcome(spaces.ledgerFor('u_x', 'not-a-space', 'read')), 'invalid');
  assert.equal(await spaces.ledgerFor('u_x', PERSONAL, 'write'), 'u_x');
  assert.equal(await spaces.ledgerFor('u_x', undefined, 'write'), 'u_x');

  // the personal ledgers did not move: the owner's export is byte for byte the same, the member's own is still empty
  assert.equal((await ledger.exportCsv('u_a')).wbs, before.wbs);
  assert.equal((await ledger.exportCsv('u_a')).events, before.events);
  assert.equal((await ledger.search('u_b', {})).total, 0);

  // the switcher's list: personal first, then the team with the caller's role
  assert.deepEqual(await spaces.list('u_g'), [
    { id: PERSONAL, kind: 'personal', name: '', role: 'owner' }, { id: s.id, kind: 'team', name: '연구실 시범', role: 'guest' }]);
  assert.deepEqual((await spaces.members('u_g', s.id)).map(m => `${m.uid}:${m.role}`), ['u_a:owner', 'u_b:member', 'u_g:guest']);
});

test('team space: only the owner manages; the owner leaves only after handing over; at most 10 people', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store);
  const s = await spaces.create('u_a', '내 팀');
  await spaces.setMember('u_a', s.id, 'u_b', 'member');
  assert.equal(await outcome(spaces.setMember('u_b', s.id, 'u_c', 'member')), 'forbidden');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_a', 'member')), 'invalid');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u/evil', 'member')), 'invalid');
  assert.equal(await outcome(spaces.removeMember('u_a', s.id, 'u_a')), 'invalid');
  assert.equal(await outcome(spaces.transfer('u_a', s.id, 'u_nobody')), 'invalid');

  for (let i = 3; i <= MAX_PEOPLE; i++) await spaces.setMember('u_a', s.id, `u_${i}`, 'guest');
  assert.equal((await store.members(s.id)).length, MAX_PEOPLE);
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_11', 'member')), 'invalid');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_3', 'member')), 'ok', 'a role change is not a new person');

  // a member leaves on their own and loses access at once
  assert.equal(await outcome(spaces.removeMember('u_3', s.id, 'u_3')), 'ok');
  assert.equal(await outcome(spaces.ledgerFor('u_3', s.id, 'read')), 'not_found');

  // handing over: the new owner manages, the old owner stays as a member and may now leave
  assert.equal(await outcome(spaces.transfer('u_a', s.id, 'u_4')), 'invalid', 'a guest cannot take over');
  await spaces.transfer('u_a', s.id, 'u_b');
  assert.equal((await store.space(s.id))!.owner, 'u_b');
  assert.equal((await store.membership(s.id, 'u_a'))!.role, 'member');
  assert.equal(await outcome(spaces.setMember('u_a', s.id, 'u_c', 'member')), 'forbidden');
  assert.equal(await outcome(spaces.removeMember('u_a', s.id, 'u_a')), 'ok');
});

test('deleting a space removes its ledger and memberships; deleting an account ends memberships under the ownership rule', async () => {
  const store = new MemoryStore(), ledger = new Ledger(store), spaces = new Spaces(store);
  const t = await spaces.create('u_a', '팀'), solo = await spaces.create('u_a', '혼자 쓰는 공간');
  await spaces.setMember('u_a', t.id, 'u_b', 'member');
  await ledger.add(claude('u_a'), task('팀 원장 행: 삭제될 데이터'), await spaces.ledgerFor('u_a', t.id, 'write'));
  await ledger.add(claude('u_b'), task('개인 원장 행: 남아야 하는 데이터'));

  // the owner of a shared space cannot delete the account until it is handed over; nothing was removed by the attempt
  assert.equal(await outcome(spaces.deleteAccount('u_a')), 'invalid');
  assert.ok(await store.space(solo.id));

  // the member's account goes: its memberships end, the space and the other ledgers stay
  await spaces.deleteAccount('u_b');
  assert.equal(await store.membership(t.id, 'u_b'), null);
  assert.equal((await ledger.search(spaceOwner(t.id), {})).total, 1);

  await spaces.remove('u_a', t.id);
  assert.equal(await store.space(t.id), null);
  assert.equal((await store.rows(spaceOwner(t.id))).length, 0);
  assert.deepEqual((await spaces.list('u_a')).map(x => x.id), [PERSONAL, solo.id]);

  await spaces.deleteAccount('u_a');   // owns only a space of one now: it goes with the account
  assert.equal(await store.space(solo.id), null);
});

test('a team space has its own data key: account keys do not open it, and shredding it leaves accounts readable', async () => {
  const env = new Envelope(new LocalKek(randomBytes(32)), new MemoryDekStore());
  const team = spaceOwner('s_' + randomBytes(16).toString('base64url'));
  const sealed = await env.seal(team, 'rows/2026_4.3.1', { task: '팀 행' });
  const mine = await env.seal('u_a', 'rows/2026_4.3.1', { task: '개인 행' });
  assert.notDeepEqual(await env.dek(team), await env.dek('u_a'));
  await assert.rejects(env.open('u_a', 'rows/2026_4.3.1', sealed), 'a team document does not open as the account\'s');
  await env.shred(team);
  assert.deepEqual(await env.open('u_a', 'rows/2026_4.3.1', mine), { task: '개인 행' });
  await assert.rejects(env.open(team, 'rows/2026_4.3.1', sealed), 'after shredding, a new key cannot open the old data');
});
