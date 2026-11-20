// Team spaces over the in-memory store, through the permission table: members write, a guest reads only its projects,
// agents work inside spaces but never govern them, the 10-person cap, leaving, handing over, deleting a space or an
// account, and the personal ledger staying byte for byte what it was. A space's data key is its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { spaceOwner } from '../src/store/types.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { MAX_PEOPLE, PERSONAL, Spaces } from '../src/wbs/spaces.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { Envelope, LocalKek, MemoryDekStore } from '../src/crypto/envelope.js';
import { admit } from './support.js';

/** The LedgerError code a call fails with, or "ok". */
const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const task = (t: string, pkg = '4.3 서비스 개발', area = '4 창업·제품') => ({ package: pkg, area, task: t, start: '2026-11-18', status: '진행 중' as const });
const claude = (uid: string) => ({ uid, clientName: 'Claude' });
const bot = (uid: string, scopes = ['wbs.read', 'wbs.write']) => agent(uid, 'Claude', scopes);
const A = person('u_a'), B = person('u_b'), G = person('u_g'), X = person('u_x');
/** Opens a team space: the owner proposes a charter and every listed member agrees (the charter gate, charter.test.ts). */
async function open(spaces: Spaces, owner: Caller, id: string, ...members: Caller[]) {
  await spaces.proposeCharter(owner, id, ['팀 작업은 기본 공개다.', '에이전트는 제안하고 사람은 승인한다.']);
  for (const m of members) await spaces.consentCharter(m, id, 1, true);
}

test('team space: members write, a guest reads only its projects, outsiders see nothing; personal ledgers untouched', async () => {
  const store = new MemoryStore(), ledger = new Ledger(store), spaces = new Spaces(store);
  await ledger.add(claude('u_a'), task('개인 원장 행: 허브 왕복 검증'));
  const before = await ledger.exportCsv('u_a');

  const s = await spaces.create(A, '  연구실   시범 ');
  assert.match(s.id, /^s_[A-Za-z0-9_-]{22}$/); assert.equal(s.name, '연구실 시범');
  await admit(spaces, A, s.id, 'u_b', 'member');
  await admit(spaces, A, s.id, 'u_g', 'guest', ['2026:4.3']);
  await open(spaces, A, s.id, B);

  // a member's agent writes the team plan in two projects
  const w = (await spaces.view(bot('u_b'), s.id, 'write')).owner;
  assert.equal(w, spaceOwner(s.id));
  assert.equal((await ledger.add(claude('u_b'), task('팀 계획: 공간 모델 설계와 단위 시험'), w)).created.code, '4.3.1');
  assert.equal((await ledger.add(claude('u_b'), task('팀 계획: 헌장 동의 화면 설계', '5.3 기타 소프트웨어 구축', '5 대외·경력'), w)).created.code, '5.3.1');

  // the guest sees its project only: search, a direct get, the export
  const gv = await spaces.view(G, s.id, 'read');
  assert.deepEqual(gv.projects, ['2026:4.3']);
  assert.deepEqual((await ledger.search(gv, {})).rows.map(r => r.code), ['4.3.1']);
  assert.equal(await outcome(ledger.get(gv, '2026', '5.3.1')), 'not_found');
  assert.equal((await ledger.exportCsv(gv)).wbs.includes('헌장'), false);
  assert.equal((await ledger.summary(gv)).leaf_tasks, 1);
  assert.equal((await ledger.search(await spaces.view(B, s.id, 'read'), {})).total, 2, 'a member sees every project');
  assert.equal(await outcome(spaces.view(G, s.id, 'write')), 'forbidden');
  assert.equal(await outcome(spaces.view(X, s.id, 'read')), 'not_found');
  assert.equal(await outcome(spaces.view(X, 'not-a-space', 'read')), 'invalid');
  assert.deepEqual(await spaces.view(X, PERSONAL, 'write'), { owner: 'u_x' });
  assert.deepEqual(await spaces.view(X, undefined, 'read'), { owner: 'u_x' });

  // the personal ledgers did not move
  assert.equal((await ledger.exportCsv('u_a')).wbs, before.wbs);
  assert.equal((await ledger.exportCsv('u_a')).events, before.events);
  assert.equal((await ledger.search('u_b', {})).total, 0);

  // the switcher's list, and who may see the member list
  assert.deepEqual(await spaces.list(G), [
    { id: PERSONAL, kind: 'personal', name: '', role: 'owner' },
    { id: s.id, kind: 'team', name: '연구실 시범', role: 'guest', projects: ['2026:4.3'], charter: { in_force: 1, needs_consent: false, proposal: null } }]);
  assert.deepEqual((await spaces.members(B, s.id)).map(m => `${m.uid}:${m.role}`), ['u_a:owner', 'u_b:member', 'u_g:guest']);
  assert.equal(await outcome(spaces.members(G, s.id)), 'forbidden');
});

test('agents work inside spaces but never govern them; scopes narrow what they do; a team agent only reads its space', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store);
  assert.equal(await outcome(spaces.create(bot('u_a'), '에이전트가 만든 팀')), 'forbidden');
  const s = await spaces.create(A, '내 팀');
  await admit(spaces, A, s.id, 'u_b', 'member');
  await open(spaces, A, s.id, B);
  for (const p of [spaces.setMember(bot('u_a'), s.id, 'u_b', 'guest', []), spaces.invite(bot('u_a'), s.id, { role: 'member', for: 'u_c' }), spaces.transfer(bot('u_a'), s.id, 'u_b'),
    spaces.remove(bot('u_a'), s.id), spaces.removeMember(bot('u_b'), s.id, 'u_b')]) assert.equal(await outcome(p), 'forbidden');
  assert.equal(await outcome(spaces.view(bot('u_b', ['wbs.read']), s.id, 'write')), 'forbidden');
  assert.equal(await outcome(spaces.view(bot('u_b', ['wbs.read']), s.id, 'read')), 'ok');
  assert.equal(await outcome(spaces.view(bot('u_b', []), PERSONAL, 'read')), 'forbidden');
  assert.equal(await outcome(spaces.members(bot('u_b', ['wbs.read']), s.id)), 'ok');
  assert.equal(await outcome(spaces.list(bot('u_b', ['wbs.write']))), 'forbidden');

  const T: Caller = { kind: 'team_agent', space: s.id, client: 'team-master' };
  assert.equal(await outcome(spaces.view(T, s.id, 'read')), 'ok');
  assert.equal(await outcome(spaces.view(T, s.id, 'write')), 'forbidden');
  assert.equal(await outcome(spaces.view(T, PERSONAL, 'read')), 'not_found');
  assert.equal(await outcome(spaces.members(T, s.id)), 'forbidden');
  const other = await spaces.create(B, '다른 팀');
  await open(spaces, B, other.id);
  assert.equal(await outcome(spaces.view(T, other.id, 'read')), 'not_found');
  assert.deepEqual((await spaces.list(T)).map(x => x.role), ['delegate']);
});

test('team space: only the owner manages; guests get projects; the owner leaves only after handing over; at most 10 people', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store);
  const s = await spaces.create(A, '내 팀');
  await admit(spaces, A, s.id, 'u_b', 'member');
  assert.equal(await outcome(spaces.invite(B, s.id, { role: 'member', for: 'u_c' })), 'forbidden');
  assert.equal(await outcome(spaces.setMember(B, s.id, 'u_b', 'guest', [])), 'forbidden');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u_c', 'member')), 'invalid', 'nobody is added: people join by an invitation');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u_a', 'member')), 'invalid');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u/evil', 'member')), 'invalid');
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'guest', projects: ['4.3'], for: 'u_g' })), 'invalid', 'a project is "YYYY:<code>"');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u_b', 'member', ['2026:4.3'])), 'invalid', 'members see every project');
  assert.equal(await outcome(spaces.removeMember(A, s.id, 'u_a')), 'invalid');
  assert.equal(await outcome(spaces.removeMember(B, s.id, 'u_a')), 'forbidden');
  assert.equal(await outcome(spaces.transfer(A, s.id, 'u_nobody')), 'invalid');

  // a guest's projects are kept across a call that leaves them out, and dropped when it becomes a member
  await admit(spaces, A, s.id, 'u_g', 'guest', ['2026:4.3', '2026:4.3', '2025:1.2']);
  assert.deepEqual((await store.membership(s.id, 'u_g'))!.projects, ['2025:1.2', '2026:4.3']);
  await spaces.setMember(A, s.id, 'u_g', 'guest');
  assert.deepEqual((await store.membership(s.id, 'u_g'))!.projects, ['2025:1.2', '2026:4.3']);
  await spaces.setMember(A, s.id, 'u_g', 'member');
  assert.equal((await store.membership(s.id, 'u_g'))!.projects, undefined);

  // at most 10 people, and an open invitation holds a seat until it is used, revoked or lapses
  for (let i = 4; i < MAX_PEOPLE; i++) await admit(spaces, A, s.id, `u_${i}`, 'guest', []);
  const link = await spaces.invite(A, s.id, { role: 'member' });
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'member', for: 'u_11' })), 'invalid', 'nine people and an open link fill the space');
  await spaces.revoke(A, s.id, link.id);
  await admit(spaces, A, s.id, `u_${MAX_PEOPLE}`, 'guest', []);
  assert.equal((await store.members(s.id)).length, MAX_PEOPLE);
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'member', for: 'u_11' })), 'invalid');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u_4', 'member')), 'ok', 'a role change is not a new person');

  // a member leaves on their own and loses access at once
  assert.equal(await outcome(spaces.removeMember(person('u_4'), s.id, 'u_4')), 'ok');
  assert.equal(await outcome(spaces.view(person('u_4'), s.id, 'read')), 'not_found');

  // handing over: the new owner manages, the old owner stays as a member and may now leave
  assert.equal(await outcome(spaces.transfer(A, s.id, 'u_5')), 'invalid', 'a guest cannot take over');
  await spaces.transfer(A, s.id, 'u_b');
  assert.equal((await store.space(s.id))!.owner, 'u_b');
  assert.equal((await store.membership(s.id, 'u_a'))!.role, 'member');
  assert.equal(await outcome(spaces.setMember(A, s.id, 'u_c', 'member')), 'forbidden');
  assert.equal(await outcome(spaces.removeMember(A, s.id, 'u_a')), 'ok');
});

test('deleting a space removes its ledger and memberships; deleting an account ends memberships under the ownership rule', async () => {
  const store = new MemoryStore(), ledger = new Ledger(store), spaces = new Spaces(store);
  const t = await spaces.create(A, '팀'), solo = await spaces.create(A, '혼자 쓰는 공간');
  await admit(spaces, A, t.id, 'u_b', 'member');
  await open(spaces, A, t.id, B);
  await ledger.add(claude('u_a'), task('팀 원장 행: 삭제될 데이터'), (await spaces.view(A, t.id, 'write')).owner);
  await ledger.add(claude('u_b'), task('개인 원장 행: 남아야 하는 데이터'));

  // the owner of a shared space cannot delete the account until it is handed over; nothing was removed by the attempt
  assert.equal(await outcome(spaces.deleteAccount('u_a')), 'invalid');
  assert.ok(await store.space(solo.id));

  // the member's account goes: its memberships end, the space and the other ledgers stay
  await spaces.deleteAccount('u_b');
  assert.equal(await store.membership(t.id, 'u_b'), null);
  assert.equal((await ledger.search(spaceOwner(t.id), {})).total, 1);

  await spaces.remove(A, t.id);
  assert.equal(await store.space(t.id), null);
  assert.equal((await store.rows(spaceOwner(t.id))).length, 0);
  assert.deepEqual((await spaces.list(A)).map(x => x.id), [PERSONAL, solo.id]);

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
