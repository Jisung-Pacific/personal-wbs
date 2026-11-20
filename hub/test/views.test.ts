// The view log (execution WBS 3.5) as the charter sets it: a person sees who read their shared rows and when — people
// in their role, the agent they read through, the team's own agent — and nobody else sees it. A person's own reads are
// not noted, and nothing is written for someone who has left the space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Views } from '../src/wbs/views.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), G = person('u_g');
const Y = todayKst().slice(0, 4), today = todayKst();

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));
  const s = await spaces.create(A, '시범 팀');
  await admit(spaces, A, s.id, 'u_b', 'member'); await admit(spaces, A, s.id, 'u_g', 'guest', [`${Y}:1.1`]);
  await spaces.proposeCharter(A, s.id, ['열람은 본인에게 보인다.']); await spaces.consentCharter(B, s.id, 1, true);
  await plans.put(A, s.id, { items: [{ code: '1', year: Y, scope: '팀 계획', status: '진행 중' }, { code: '1.1', year: Y, scope: '저장소', status: '진행 중' }] });
  const add = async (who: string, task: string) => (await ledger.add({ uid: who, clientName: 'Claude' }, { package: '5.3 소프트웨어', area: '5 대외·경력', task, start: `${Y}-01-06`, status: '진행 중' })).created;
  const b1 = await add('u_b', '저장소 구현'), b2 = await add('u_b', '권한 표 갱신'), a1 = await add('u_a', '계획 화면');
  await plans.share(B, { year: b1.year, code: b1.code, space: s.id, plan: '1.1' });
  await plans.share(B, { year: b2.year, code: b2.code, space: s.id, plan: '1' });
  await plans.share(A, { year: a1.year, code: a1.code, space: s.id, plan: '1.1' });
  return { store, spaces, plans, views, id: s.id };
}

test('a read of the plan against the work is noted for every other person whose rows it carried', async () => {
  const { plans, views, id } = await team();
  await plans.actual(A, id);
  await plans.actual(A, id);
  const b = await views.mine(B);
  assert.equal(b.log.length, 1); assert.equal(b.log[0].date, today);
  const e = b.log[0].entries[0];
  assert.deepEqual([e.viewer, e.kind, e.role, e.space, e.what, e.rows, e.count], ['u_a', 'person', 'owner', id, 'work', 2, 2]);
  assert.equal(e.space_name, '시범 팀');
  assert.match(b.lines[0], new RegExp(`^${today} \\d\\d:\\d\\d(–\\d\\d:\\d\\d)? u_a\\(소유자\\) · 시범 팀 · 계획 대비 실적에서 내 행 2개 · 2회$`));
  assert.deepEqual((await views.mine(A)).log, [], 'nobody else read A\'s rows; A\'s own reads are not noted');
});

test('who read: a guest with its project only, an agent acting for a person, the team\'s agent', async () => {
  const { plans, views, id } = await team();
  await plans.actual(G, id);   // the guest sees project 1.1: B's row there and A's
  await plans.actual(agent('u_a', 'ChatGPT', ['wbs.read']), id);
  await plans.actual({ kind: 'team_agent', space: id, client: 'team-master' } as Caller, id);
  await plans.actual(B, id);
  const b = await views.mine(B), by = (k: string) => b.log[0].entries.find(e => `${e.kind}|${e.viewer}` === k)!;
  assert.deepEqual([by('person|u_g').role, by('person|u_g').rows], ['guest', 1], 'the guest\'s read carried only the row in its project');
  assert.deepEqual([by('agent|u_a').client, by('agent|u_a').rows], ['ChatGPT', 2]);
  assert.deepEqual([by('team_agent|').client, by('team_agent|').role], ['team-master', 'delegate']);
  assert.ok(b.lines.some(l => l.includes('u_a(소유자) · ChatGPT 경유')) && b.lines.some(l => l.includes('팀 에이전트 team-master')));
  assert.deepEqual(b.totals, { reads: 3, readers: 3 });
  const a = await views.mine(A);
  assert.deepEqual(a.log[0].entries.map(e => `${e.kind}|${e.viewer}`).sort(), ['person|u_b', 'person|u_g', 'team_agent|'], 'A\'s log has its own readers');
  assert.equal(await outcome(views.mine({ kind: 'team_agent', space: id, client: 'team-master' } as Caller)), 'forbidden');
});

test('a person who left gets no new entries; the log keeps 180 days and filters by days and space', async () => {
  const { plans, views, spaces, store, id } = await team();
  await plans.actual(A, id);
  await spaces.removeMember(B, id, 'u_b');   // B leaves: B's copies stay frozen with the team
  await plans.actual(A, id); await plans.actual(G, id);
  const b = await views.mine(B);
  assert.equal(b.log[0].entries.length, 1); assert.equal(b.log[0].entries[0].count, 1, 'reads after leaving are not written to B');
  assert.equal(b.log[0].entries[0].space_name, '(떠난 공간)');
  // an old day: visible within the window asked for, not outside it
  const old = new Date(Date.parse(today + 'T00:00:00Z') - 40 * 864e5).toISOString().slice(0, 10);
  await store.logViews('u_b', old, [{ viewer: 'u_a', kind: 'person', client: '', role: 'owner', space: id, what: 'work', rows: 1, count: 1, first: 1, last: 1 }], 0);
  assert.equal((await views.mine(B)).log.length, 1, 'default: the last 30 days');
  assert.equal((await views.mine(B, { days: 60 })).log.length, 2);
  assert.equal((await views.mine(B, { days: 60, space: 's_other_space_id_000000' })).log.length, 0);
  await assert.rejects(views.mine(B, { days: 181 }), 'at most 180 days are kept');
});

test('the team screen in one call: role, charter, members, plan vs actual, my shared rows and who read them', async () => {
  const { teamOverview } = await import('../src/wbs/team.js');
  const { plans, views, spaces, store, id } = await team();
  await plans.actual(A, id);   // A reads: B's log gets an entry
  const b = await teamOverview(store, spaces, plans, views, B, id);
  assert.deepEqual([b.space.name, b.space.role, b.charter!.in_force, b.charter!.proposal], ['시범 팀', 'member', 1, null]);
  assert.deepEqual(b.members!.map(m => `${m.uid}:${m.role}`), ['u_a:owner', 'u_b:member', 'u_g:guest']);
  assert.equal(b.plan.items.length, 2); assert.equal(b.my_shared.length, 2);
  assert.equal(b.my_views!.lines.length, 1); assert.match(b.my_views!.lines[0], /u_a\(소유자\)/);
  await spaces.proposeCharter(A, id, ['열람은 본인에게 보인다.', '떠날 때는 나눈다.']);
  assert.deepEqual((await teamOverview(store, spaces, plans, views, B, id)).charter!.proposal, { version: 2, needs_my_answer: true });
  const g = await teamOverview(store, spaces, plans, views, G, id);
  assert.deepEqual([g.charter, g.members, g.space.projects, g.plan.items.map(i => i.code)], [null, null, [`${Y}:1.1`], ['1.1']], 'a guest: its project, no charter or members');
  assert.equal(await outcome(teamOverview(store, spaces, plans, views, person('u_x'), id)), 'not_found');
});
