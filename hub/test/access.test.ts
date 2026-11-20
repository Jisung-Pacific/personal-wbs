// The permission table against its specification. SPEC is written out here from the strategy document's role table
// (owner: everything incl. inviting and billing; member: the same apart from inviting and billing; guest: its projects'
// plan and work; team agent: plan, work and cards to read; nobody: another person's space) — not derived from the code —
// and every caller kind × relation × action is checked against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, decide, type Action, type Caller, type Relation } from '../src/wbs/access.js';

const SPEC = `
action           owner member guest delegate
space.see        Y     Y      Y     Y
plan.read        Y     Y      Y     Y
plan.write       Y     Y      N     N
members.read     Y     Y      N     N
members.manage   Y     N      N     N
charter.read     Y     Y      N     Y
charter.consent  Y     Y      N     N
billing.manage   Y     N      N     N
charter.propose  Y     Y      N     N
cards.read       Y     Y      N     Y
cards.publish    Y     Y      N     N
cards.mode       Y     N      N     N
brief.read       Y     Y      N     Y
plan.propose     N     N      N     Y
proposal.decide  Y     Y      N     N
agent.manage     Y     N      N     N
space.transfer   Y     N      N     N
space.delete     Y     N      N     N
space.leave      N     Y      Y     N
work.share       Y     Y      N     N`;
/** What an agent signed in by a person may do, and the scope it needs; every other action is for people only. */
const AGENT: Partial<Record<Action, string>> = { 'space.see': 'wbs.read', 'plan.read': 'wbs.read', 'members.read': 'wbs.read', 'charter.read': 'wbs.read', 'plan.write': 'wbs.write', 'work.share': 'wbs.write', 'brief.read': 'wbs.read' };

const [head, ...lines] = SPEC.trim().split('\n').map(l => l.trim().split(/\s+/));
const cols = head.slice(1) as Relation[];
const spec = new Map(lines.map(([a, ...v]) => [a as Action, Object.fromEntries(cols.map((c, i) => [c, v[i] === 'Y'])) as Record<Relation, boolean>]));
const person: Caller = { kind: 'person', uid: 'u_p' };
const teamAgent: Caller = { kind: 'team_agent', space: 's_x', client: 'team-master' };
const agentWith = (scopes: string[]): Caller => ({ kind: 'agent', uid: 'u_p', client: 'Claude', scopes });

test('the table covers exactly the specified actions', () => {
  assert.deepEqual(Object.keys(TABLE).sort(), [...spec.keys()].sort());
});

test('people: each relation gets exactly what the specification grants; outsiders get not_found', () => {
  let n = 0;
  for (const [action, row] of spec) for (const rel of ['owner', 'member', 'guest'] as const) {
    const d = decide(person, rel, action); n++;
    assert.equal(d.allow, row[rel], `person ${rel} ${action}`);
    if (!d.allow) assert.equal(d.code, 'forbidden', `person ${rel} ${action}`);
  }
  for (const action of spec.keys()) { const d = decide(person, 'none', action); n++; assert.deepEqual([d.allow, d.code], [false, 'not_found']); }
  assert.equal(n, spec.size * 4);
});

test('agents act within the person\'s relation and the granted scopes, and never govern', () => {
  const grants = [[], ['wbs.read'], ['wbs.write'], ['wbs.read', 'wbs.write']];
  for (const scopes of grants) for (const [action, row] of spec) for (const rel of ['owner', 'member', 'guest'] as const) {
    const need = AGENT[action], expect = row[rel] && !!need && scopes.includes(need);
    assert.equal(decide(agentWith(scopes), rel, action).allow, expect, `agent [${scopes}] ${rel} ${action}`);
  }
  // with both scopes an agent still cannot do any people-only action, even for the owner
  for (const action of spec.keys()) if (!AGENT[action]) assert.equal(decide(agentWith(['wbs.read', 'wbs.write']), 'owner', action).allow, false, action);
});

test('a team-delegated agent reads the plan, work and cards of its space and nothing else; the relation cannot be borrowed', () => {
  for (const [action, row] of spec) assert.equal(decide(teamAgent, 'delegate', action).allow, row.delegate, `team agent ${action}`);
  for (const action of spec.keys()) {
    assert.equal(decide(teamAgent, 'member', action).allow, false, 'a team agent never acts as a member');
    assert.equal(decide(person, 'delegate', action).allow, false, 'a person never holds the delegate relation');
    assert.equal(decide(teamAgent, 'none', action).code, 'not_found');
  }
});
