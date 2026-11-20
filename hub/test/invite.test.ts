// Invitations (execution WBS 5.3): a person joins a team only by accepting, by their own hand — a one-time link or an
// invitation addressed to their account — so one account can be in several teams without anyone adding it, and the
// switcher shows every team with what waits there. Agents may read an account's invitations to tell the person, never
// answer them; only the owner invites; a link is used once and only its hash is kept; invitations lapse after 7 days and
// hold seats while open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { LedgerError } from '../src/wbs/service.js';
import { INVITE_DAYS, MAX_PEOPLE, PERSONAL, Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { MasterAgent } from '../src/wbs/master.js';
import { switchList } from '../src/wbs/team.js';
import { agent, person } from '../src/wbs/access.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), C = person('u_c'), X = person('u_x');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('a link invitation: one use, only its hash kept; a member reads the charter and agrees to it on joining', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), s = await spaces.create(A, '연구실');
  await spaces.proposeCharter(A, s.id, ['공유는 필드 단위다.']);   // a space of one adopts it at once
  const inv = await spaces.invite(A, s.id, { role: 'member' });
  assert.match(inv.code!, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([inv.kind, inv.status, inv.role, inv.expires - inv.at], ['link', 'open', 'member', INVITE_DAYS * 864e5]);
  const kept = (await store.invites(s.id))[0];
  assert.equal(kept.hash, sha(inv.code!)); assert.equal(JSON.stringify(kept).includes(inv.code!), false, 'only the hash is stored');
  assert.equal(JSON.stringify(await spaces.invites(A, s.id)).includes(inv.code!), false, 'and the owner\'s record never shows the code again');

  const p = await spaces.preview(B, { code: inv.code! });
  assert.deepEqual([p.space.name, p.role, p.by, p.already, p.charter, p.proposal], ['연구실', 'member', 'u_a', null, { version: 1, lines: ['공유는 필드 단위다.'] }, null]);
  assert.equal(await outcome(spaces.view(B, s.id, 'read')), 'not_found', 'reading an invitation is not being in the team');
  assert.equal(await outcome(spaces.preview(B, { space: s.id, invite: kept.id })), 'not_found', 'a link invitation opens only with its code');
  assert.equal(await outcome(spaces.join(B, { code: inv.code! })), 'consent_required');
  assert.deepEqual(await spaces.join(B, { code: inv.code! }, 1), { space: s.id, name: '연구실', role: 'member' });
  assert.equal(await outcome(spaces.view(B, s.id, 'write')), 'ok', 'in, and through the charter gate at once');
  assert.equal(await outcome(spaces.join(C, { code: inv.code! }, 1)), 'not_found', 'one use');
  assert.equal(await outcome(spaces.preview(C, { code: inv.code! })), 'not_found');
  assert.deepEqual((await spaces.invites(A, s.id)).map(i => [i.status, i.who]), [['joined', 'u_b']]);
  assert.equal(await store.inviteByHash(sha(inv.code!)), null, 'a used link leaves no way back to the space');
  // codes are not guessed or probed: malformed, near and foreign codes all read the same
  const near = inv.code!.slice(0, -1) + (inv.code!.endsWith('A') ? 'B' : 'A');
  for (const code of ['', 'x', near, 'A'.repeat(43)]) assert.equal(await outcome(spaces.preview(C, { code })), 'not_found');
});

test('an account invitation: only that account answers; an agent reads it for the person but never answers; decline and revoke close it', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), s = await spaces.create(A, '연구실');
  const g = await spaces.invite(A, s.id, { role: 'guest', projects: ['2026:4.3', '2026:4.3'], for: 'u_c' });
  assert.deepEqual([g.code, g.kind, g.for, g.projects], [undefined, 'account', 'u_c', ['2026:4.3']]);
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'guest', for: 'u_c' })), 'duplicate', 'one open invitation per account');
  const ref = { space: s.id, invite: g.id };
  assert.equal(await outcome(spaces.preview(X, ref)), 'not_found', 'another account cannot open it');
  assert.equal(await outcome(spaces.join(X, ref)), 'not_found');
  assert.deepEqual((await spaces.received(C)).map(r => [r.space, r.name, r.role, r.projects, r.by]), [[s.id, '연구실', 'guest', ['2026:4.3'], 'u_a']]);
  assert.deepEqual(await spaces.received(X), []);
  const bot = agent('u_c', 'Claude', ['wbs.read', 'wbs.write']);
  assert.equal((await spaces.received(bot)).length, 1, 'the person\'s agent can tell them');
  for (const p of [spaces.preview(bot, ref), spaces.join(bot, ref), spaces.decline(bot, ref)]) assert.equal(await outcome(p), 'forbidden', 'answering is the person\'s own act');
  assert.equal(await outcome(spaces.received(agent('u_c', 'Claude', ['wbs.write']))), 'forbidden');
  assert.deepEqual(await spaces.received({ kind: 'team_agent', space: s.id, client: 'team-master' }), []);

  // no charter needed: a guest joins with its projects
  assert.equal((await spaces.preview(C, ref)).charter, null);
  await spaces.join(C, ref);
  const m = (await store.membership(s.id, 'u_c'))!;
  assert.deepEqual([m.role, m.by, m.projects], ['guest', 'u_a', ['2026:4.3']]);
  assert.deepEqual(await spaces.received(C), [], 'answered: no longer waiting');

  // declined, revoked: closed for good, and kept in the owner's record
  const d = await spaces.invite(A, s.id, { role: 'member', for: 'u_b' });
  assert.deepEqual(await spaces.decline(B, { space: s.id, invite: d.id }), { declined: d.id });
  assert.equal(await outcome(spaces.join(B, { space: s.id, invite: d.id })), 'not_found');
  const r = await spaces.invite(A, s.id, { role: 'member', for: 'u_b' });   // asked again
  assert.equal(await outcome(spaces.revoke(B, s.id, r.id)), 'not_found', 'not in the team: told nothing');
  assert.deepEqual(await spaces.revoke(A, s.id, r.id), { revoked: r.id });
  assert.equal(await outcome(spaces.revoke(A, s.id, r.id)), 'not_found');
  assert.equal(await outcome(spaces.join(B, { space: s.id, invite: r.id })), 'not_found');
  assert.deepEqual((await spaces.invites(A, s.id)).map(i => i.status).sort(), ['declined', 'joined', 'revoked']);

  // only the owner invites, a person by hand; nobody already in is invited or joins twice
  assert.equal(await outcome(spaces.invite(C, s.id, { role: 'member' })), 'forbidden');
  assert.equal(await outcome(spaces.invites(C, s.id)), 'forbidden');
  assert.equal(await outcome(spaces.invite(agent('u_a', 'Claude', ['wbs.read', 'wbs.write']), s.id, { role: 'member' })), 'forbidden');
  assert.equal(await outcome(spaces.invite(X, s.id, { role: 'member' })), 'not_found');
  for (const who of ['u_c', 'u_a']) assert.equal(await outcome(spaces.invite(A, s.id, { role: 'member', for: who })), 'invalid');
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'member', projects: ['2026:4.3'] })), 'invalid', 'members see every project');
  const l = await spaces.invite(A, s.id, { role: 'member' });
  assert.equal((await spaces.preview(C, { code: l.code! })).already, 'guest');
  assert.equal(await outcome(spaces.join(C, { code: l.code! })), 'invalid');
  assert.equal((await spaces.invites(A, s.id)).find(i => i.id === l.id)!.status, 'open', 'a refused join does not use the link up');
});

test('lapsing and seats: an invitation expires after 7 days and stops holding a seat; a full team refuses a join', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), s = await spaces.create(A, '연구실');
  const inv = await spaces.invite(A, s.id, { role: 'member', for: 'u_b' }), real = Date.now;
  for (let i = 2; i < MAX_PEOPLE; i++) await spaces.invite(A, s.id, { role: 'guest', for: `u_${i}` });   // 1 person + 9 open invitations
  assert.equal(await outcome(spaces.invite(A, s.id, { role: 'member' })), 'invalid', 'open invitations hold seats');
  try {
    Date.now = () => real() + INVITE_DAYS * 864e5 + 1000;
    assert.equal(await outcome(spaces.join(B, { space: s.id, invite: inv.id })), 'not_found', 'lapsed');
    assert.deepEqual(await spaces.received(B), []);
    assert.ok((await spaces.invites(A, s.id)).every(i => i.status === 'expired'));
    const fresh = await spaces.invite(A, s.id, { role: 'member' });   // lapsed ones free their seats
    for (let i = 0; i < MAX_PEOPLE - 1; i++) await store.putMember(s.id, { uid: `u_full${i}`, role: 'guest', since: 0, by: 'u_a', projects: [] });   // filled meanwhile
    assert.equal(await outcome(spaces.join(C, { code: fresh.code! })), 'invalid', 'a full team refuses');
    assert.equal((await spaces.invites(A, s.id)).find(i => i.id === fresh.id)!.status, 'open');
  } finally { Date.now = real; }
});

test('one account, three teams: each joined by hand, listed with its role and what waits there; leaving one keeps the others', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces), master = new MasterAgent(store, spaces, plans);
  const O1 = person('u_o1'), O2 = person('u_o2'), O3 = person('u_o3'), J = person('u_j');
  const t1 = await spaces.create(O1, '연구실'), t2 = await spaces.create(O2, '창업 팀'), t3 = await spaces.create(O3, '공동 연구');
  for (const [o, t] of [[O1, t1], [O2, t2], [O3, t3]] as const) await spaces.proposeCharter(o, t.id, ['에이전트는 제안하고 사람은 승인한다.']);
  // a link from the first, an account invitation from the second, a guest invitation from the third
  const l1 = await spaces.invite(O1, t1.id, { role: 'member' });
  const a2 = await spaces.invite(O2, t2.id, { role: 'member', for: 'u_j' });
  const a3 = await spaces.invite(O3, t3.id, { role: 'guest', projects: ['2026:2.1'], for: 'u_j' });
  assert.deepEqual((await switchList(spaces, J, master, 'https://hub.example')).map(x => x.kind === 'invite' ? `invite:${x.name}:${x.role}:${x.accept_url}` : x.kind),
    ['personal', `invite:창업 팀:member:https://hub.example/app/i/${t2.id}/${a2.id}`, `invite:공동 연구:guest:https://hub.example/app/i/${t3.id}/${a3.id}`],
    'before: the personal space and two invitations to answer (a link waits with whoever holds it)');
  await spaces.join(J, { code: l1.code! }, 1);
  await spaces.join(J, { space: t2.id, invite: a2.id }, 1);
  await spaces.join(J, { space: t3.id, invite: a3.id });
  // a plan change in the first team waits for J's decision (J is A of item 1)
  await plans.put(O1, t1.id, { items: [{ code: '1', scope: '출시 준비', status: '진행 중', accountable: 'u_j' }] });
  await master.propose({ kind: 'team_agent', space: t1.id, client: 'Claude', clientId: 'c1' }, t1.id, { items: [{ code: '1', status: '완료' }], why: '출시 준비 행이 모두 끝났다는 제안' });
  await spaces.proposeCharter(O2, t2.id, ['에이전트는 제안하고 사람은 승인한다.', '열람은 본인에게 보인다.'], '둘째 줄 추가');
  const list = await switchList(spaces, J, master);
  assert.deepEqual(list.map(x => x.kind === 'team' ? [x.name, x.role, (x as { waiting?: { total: number } }).waiting?.total ?? null] : [x.kind]),
    [['personal'], ['연구실', 'member', 1], ['창업 팀', 'member', 1], ['공동 연구', 'guest', null]], 'one proposal to decide, one charter proposal to answer, nothing for a guest');
  assert.deepEqual((list[1] as unknown as { waiting: unknown }).waiting, { charter: 0, decide: 1, drafts: 0, total: 1 });
  assert.deepEqual((list[2] as unknown as { waiting: unknown }).waiting, { charter: 1, decide: 0, drafts: 0, total: 1 });
  // each team opens on its own terms, and none shows another's
  for (const t of [t1, t2]) assert.equal((await spaces.view(J, t.id, 'write')).owner, `spaces/${t.id}`);
  assert.deepEqual(await spaces.view(J, t3.id, 'read'), { owner: `spaces/${t3.id}`, projects: ['2026:2.1'] });
  assert.equal(await outcome(spaces.view(J, t3.id, 'write')), 'forbidden');
  assert.deepEqual(await spaces.view(J, PERSONAL, 'write'), { owner: 'u_j' }, 'the personal space stays the account\'s own');
  // leaving one team leaves the other two as they were
  await spaces.removeMember(J, t2.id, 'u_j');
  assert.deepEqual((await spaces.list(J)).map(x => x.name || x.kind), ['personal', '연구실', '공동 연구']);
  assert.equal(await outcome(spaces.view(J, t2.id, 'read')), 'not_found');
  assert.equal(await outcome(spaces.view(J, t1.id, 'read')), 'ok');
});

test('deleting a space takes its invitations; deleting an account drops what waits for it', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), s = await spaces.create(A, '연구실');
  const l = await spaces.invite(A, s.id, { role: 'member' }), a = await spaces.invite(A, s.id, { role: 'member', for: 'u_b' });
  await spaces.remove(A, s.id);
  assert.equal(await store.inviteByHash(sha(l.code!)), null);
  assert.deepEqual(await store.invitesFor('u_b'), []);
  assert.equal(await outcome(spaces.join(B, { space: s.id, invite: a.id })), 'not_found');
  const t = await spaces.create(A, '둘째 팀'); await spaces.invite(A, t.id, { role: 'member', for: 'u_c' });
  await spaces.deleteAccount('u_c');
  assert.deepEqual(await store.invitesFor('u_c'), []);
  await admit(spaces, A, t.id, 'u_b', 'member');
  assert.equal((await store.membership(t.id, 'u_b'))!.role, 'member');
});
