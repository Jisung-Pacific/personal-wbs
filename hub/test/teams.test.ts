// One account, three teams (execution WBS 5.3), end to end against the real app: invitations wait in wbs_spaces (with
// the hub page that answers them) until the person accepts on the hub; then one agent connection moves between the three
// teams, each opening on its own terms (role, members, charter, what waits there), writing only where it is pointed.
// Its own file, so its client registrations do not count against the other end-to-end tests' rate limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spaces } from '../src/wbs/spaces.js';
import { person } from '../src/wbs/access.js';
import { boot, connect, json, mcp } from './support.js';

test('one account, three teams (execution WBS 5.3): invitations wait in wbs_spaces until the person accepts on the hub; then the agent moves between the three, each on its own terms', async () => {
  const { base, store, close } = await boot();
  try {
    const spaces = new Spaces(store), J = person('u_j');
    const t = await Promise.all(['연구실', '창업 팀', '공동 연구'].map(async (n, i) => {
      const o = person(`u_o${i + 1}`), s = await spaces.create(o, n); await spaces.proposeCharter(o, s.id, ['공유는 필드 단위다.']); return { ...s, o }; }));
    const inv = [];
    for (const [i, role] of (['member', 'member', 'guest'] as const).entries()) inv.push(await spaces.invite(t[i].o, t[i].id, { role, ...(role === 'guest' ? { projects: ['2026:4.3'] } : {}), for: 'u_j' }));
    const c = await mcp(base, (await connect(base, { uid: 'u_j', clientName: 'Claude' })).access_token);
    // before: three invitations waiting for the person, each with the hub page that answers it; no team to work in yet
    const before = json(await c.callTool({ name: 'wbs_spaces', arguments: {} }));
    assert.deepEqual(before.map((x: { kind: string; name?: string; role?: string; accept_url?: string }) => [x.kind, x.name ?? '', x.role ?? '', !!x.accept_url]),
      [['personal', '', 'owner', false], ['invite', '연구실', 'member', true], ['invite', '창업 팀', 'member', true], ['invite', '공동 연구', 'guest', true]]);
    assert.equal(before[1].accept_url, `${base}/app/i/${t[0].id}/${inv[0].id}`);
    assert.equal(before.filter((x: { this_connection?: boolean }) => x.this_connection).length, 1, 'only the personal space is this connection');
    const no = await c.callTool({ name: 'wbs_team', arguments: { space: t[0].id } });
    assert.equal(no.isError, true); assert.equal(json(no).error, 'not_found', 'an invitation is not membership');
    assert.ok(!(await c.listTools()).tools.some(x => /join|accept|invite/.test(x.name)), 'no tool answers an invitation: the person does, on the hub');
    for (let i = 0; i < 3; i++) await spaces.join(J, { space: t[i].id, invite: inv[i].id }, i < 2 ? 1 : undefined);
    await spaces.proposeCharter(t[1].o, t[1].id, ['공유는 필드 단위다.', '열람은 본인에게 보인다.']);   // a decision waits in the second team
    const after = json(await c.callTool({ name: 'wbs_spaces', arguments: {} }));
    assert.deepEqual(after.map((x: { kind: string; name: string; role: string; waiting?: { total: number } }) => [x.kind, x.name, x.role, x.waiting?.total ?? null]),
      [['personal', '', 'owner', null], ['team', '연구실', 'member', 0], ['team', '창업 팀', 'member', 1], ['team', '공동 연구', 'guest', null]]);
    assert.ok(after[1].connector_url && after[2].connector_url && !after[3].connector_url, 'a guest gets no team address');
    // switching: each team opens with its own role, members and charter state
    const opened = [];
    for (const s of t) opened.push(json(await c.callTool({ name: 'wbs_team', arguments: { space: s.id } })));
    assert.deepEqual(opened.map(o => [o.space.name, o.space.role, o.members ? o.members.length : null]), [['연구실', 'member', 2], ['창업 팀', 'member', 2], ['공동 연구', 'guest', null]]);
    assert.equal(opened[1].charter.proposal.needs_my_answer, true);
    // writing goes where it is pointed, and nowhere else
    json(await c.callTool({ name: 'wbs_plan_put', arguments: { space: t[0].id, items: [{ year: '2026', code: '1', scope: '연구실 계획' }] } }));
    assert.deepEqual(await Promise.all(t.map(async s => (await store.plan(s.id)).length)), [1, 0, 0]);
    const gw = await c.callTool({ name: 'wbs_plan_put', arguments: { space: t[2].id, items: [{ year: '2026', code: '1', scope: '게스트는 쓰지 못함' }] } });
    assert.equal(gw.isError, true); assert.equal(json(gw).error, 'forbidden');
    // REST lists the same spaces
    const ro = await connect(base, { uid: 'u_j', resource: `${base}/v1`, scope: 'wbs.read', clientName: 'ChatGPT Actions' });
    const rs = await (await fetch(`${base}/v1/spaces`, { headers: { authorization: `Bearer ${ro.access_token}` } })).json();
    assert.deepEqual(rs.map((x: { kind: string; name: string }) => x.name || x.kind), ['personal', '연구실', '창업 팀', '공동 연구']);
    // leaving one team leaves the other two
    await spaces.removeMember(J, t[1].id, 'u_j');
    assert.deepEqual(json(await c.callTool({ name: 'wbs_spaces', arguments: {} })).map((x: { name: string; kind: string }) => x.name || x.kind), ['personal', '연구실', '공동 연구']);
    await c.close();
  } finally { await close(); }
});
