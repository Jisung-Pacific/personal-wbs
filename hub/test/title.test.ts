// Display titles (execution WBS 3.9; the strategy's decision 7: "직함은 표시용"): words beside a name that grant
// nothing. Each person sets their own, the owner sets or clears anyone's, agents never do; a title survives role changes
// and a hand-over, goes when the person leaves, and shows on the team screen, in wbs_team and on the hub's team page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { LedgerError } from '../src/wbs/service.js';
import { Spaces, TITLE_MAX } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { teamOverview } from '../src/wbs/team.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { admit, boot, connect } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), G = person('u_g'), X = person('u_x');
const titles = async (spaces: Spaces, who: Caller, id: string) => Object.fromEntries((await spaces.members(who, id)).map(m => [m.uid, m.title ?? null]));

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const s = await spaces.create(A, '창업 팀');
  await admit(spaces, A, s.id, 'u_b', 'member');
  await admit(spaces, A, s.id, 'u_g', 'guest', ['2026:4.3']);
  await spaces.proposeCharter(A, s.id, ['팀 작업은 기본 공개다.', '직함은 표시용이다.']);
  await spaces.consentCharter(B, s.id, 1, true);
  return { store, spaces, plans, id: s.id };
}

test('each person sets their own title; the owner sets or clears anyone\'s; nobody else, and no agent', async () => {
  const { spaces, id } = await team();
  assert.deepEqual(await spaces.setTitle(A, id, 'u_a', '  대표   (공동 창업자) '), { space: id, uid: 'u_a', title: '대표 (공동 창업자)' });
  assert.equal(await outcome(spaces.setTitle(B, id, 'u_b', '공동 창업자')), 'ok');
  assert.equal(await outcome(spaces.setTitle(G, id, 'u_g', '자문')), 'ok', 'a guest names itself too');
  assert.equal(await outcome(spaces.setTitle(B, id, 'u_a', '인턴')), 'forbidden', 'a member does not title others');
  assert.equal(await outcome(spaces.setTitle(G, id, 'u_b', '인턴')), 'forbidden');
  assert.equal(await outcome(spaces.setTitle(X, id, 'u_x', '대표')), 'not_found', 'outsiders are told the space does not exist');
  assert.equal(await outcome(spaces.setTitle(agent('u_b', 'Claude', ['wbs.read', 'wbs.write']), id, 'u_b', 'CTO')), 'forbidden', 'an agent never edits a membership');
  assert.equal(await outcome(spaces.setTitle({ kind: 'team_agent', space: id, client: 'team-master' }, id, 'u_b', 'CTO')), 'forbidden');
  assert.equal(await outcome(spaces.setTitle(A, id, 'u_x', '대표')), 'invalid', 'only people in the space have titles');
  assert.deepEqual(await titles(spaces, A, id), { u_a: '대표 (공동 창업자)', u_b: '공동 창업자', u_g: '자문' });

  assert.equal(await outcome(spaces.setTitle(A, id, 'u_b', '가'.repeat(TITLE_MAX + 1))), 'invalid');
  assert.equal(await outcome(spaces.setTitle(A, id, 'u_b', '가'.repeat(TITLE_MAX))), 'ok', `${TITLE_MAX} characters, counted as characters`);
  assert.equal(await outcome(spaces.setTitle(A, id, 'u_b', 'CTO\u0007')), 'invalid');
  assert.deepEqual(await spaces.setTitle(A, id, 'u_b', '   '), { space: id, uid: 'u_b', title: null }, 'empty clears it');
  assert.equal((await titles(spaces, A, id)).u_b, null);
});

test('a title grants nothing, survives role changes and a hand-over, and goes when the person leaves', async () => {
  const { spaces, id } = await team();
  await spaces.setTitle(B, id, 'u_b', '대표');
  assert.equal(await outcome(spaces.invite(B, id, { role: 'member' })), 'forbidden', 'titled 대표, still a member');
  assert.equal(await outcome(spaces.setMember(B, id, 'u_g', 'member')), 'forbidden');
  await spaces.setMember(A, id, 'u_b', 'guest', ['2026:4.3']);
  await spaces.setMember(A, id, 'u_b', 'member');
  assert.equal((await titles(spaces, A, id)).u_b, '대표', 'kept through guest and back');
  await spaces.setTitle(A, id, 'u_a', '창업자');
  await spaces.transfer(A, id, 'u_b');
  assert.deepEqual(await titles(spaces, B, id), { u_b: '대표', u_a: '창업자', u_g: null }, 'kept through the hand-over');
  await spaces.removeMember(A, id, 'u_a');
  const inv = await spaces.invite(B, id, { role: 'member', for: 'u_a' });
  await spaces.join(A, { space: id, invite: inv.id }, 1);
  assert.equal((await titles(spaces, B, id)).u_a, null, 'coming back starts without the old title');
});

test('the team screen and wbs_team carry titles for owners and members; a guest sees no member list', async () => {
  const { store, spaces, plans, id } = await team();
  await spaces.setTitle(A, id, 'u_a', '대표');
  const b = await teamOverview(store, spaces, plans, undefined, B, id);
  assert.deepEqual(b.members!.map(m => `${m.uid}:${m.role}:${m.title ?? ''}`), ['u_a:owner:대표', 'u_b:member:', 'u_g:guest:']);
  assert.equal((await teamOverview(store, spaces, plans, undefined, G, id)).members, null);
});

test('the hub\'s team page: the title beside the name, one\'s own form, the owner\'s form for others; agents cannot', async () => {
  const { base, store, close } = await boot();
  try {
    const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
    const sign = async (uid: string) => (await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) })).headers.get('set-cookie')!.split(';')[0];
    const as = (cookie: string) => (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const o = as(await sign('u_o')), m = as(await sign('u_m'));
    const t = await (await o('POST', '/app/api/spaces', { name: '연구실' })).json();
    const inv = await (await o('POST', `/app/api/t/${t.id}/invites`, { role: 'member', for: 'u_m' })).json();
    assert.equal((await m('POST', '/app/api/join', { space: t.id, invite: inv.id })).status, 200);

    assert.equal((await o('POST', `/app/api/t/${t.id}/title`, { title: '지도교수' })).status, 200);
    assert.equal((await m('POST', `/app/api/t/${t.id}/title`, { title: '박사과정' })).status, 200);
    assert.equal((await m('POST', `/app/api/t/${t.id}/title`, { uid: 'u_o', title: '조교' })).status, 403);
    assert.equal((await o('POST', `/app/api/t/${t.id}/title`, { uid: 'u_m', title: '박사과정 2년차' })).status, 200);
    assert.equal((await store.membership(t.id, 'u_m'))?.title, '박사과정 2년차');

    const owner = await (await o('GET', `/app/t/${t.id}`)).text();
    assert.match(owner, /<span class="ttl">지도교수<\/span>/); assert.match(owner, /<span class="ttl">박사과정 2년차<\/span>/);
    assert.match(owner, /구성원 직함/); assert.match(owner, /data-title="박사과정 2년차"/);
    const member = await (await m('GET', `/app/t/${t.id}`)).text();
    assert.match(member, /내 직함/); assert.doesNotMatch(member, /구성원 직함/);
    assert.match(member, /id="ttv"[^>]*value="박사과정 2년차"/);

    const conn = await connect(base, { uid: 'u_m' });
    const viaAgent = await fetch(`${base}/app/api/t/${t.id}/title`, { method: 'POST', headers: { ...H, authorization: `Bearer ${conn.access_token}` }, body: JSON.stringify({ title: 'CEO' }) });
    assert.equal(viaAgent.status, 401, 'the people API takes no agent token');
  } finally { await close(); }
});
