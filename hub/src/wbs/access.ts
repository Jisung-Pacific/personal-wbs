// The permission table. Who may do what is decided from relation tuples, Zanzibar-style: the stored tuple
// (account, role, space) gives a relation, and the table below names the relations that grant each action. Agents
// never hold relations of their own: an agent signed in by a person acts with that person's relation, narrowed by the
// scopes the person granted, and never governs a space (inviting, billing, the charter, handing over, deleting, leaving
// stay with people). An agent the team itself delegates (the team master agent, execution WBS 4.5) reads the team's
// plan, work and cards, and writes nothing.
//
// Roles follow the strategy document's role table: one owner (invites and billing), equal members (the same as the
// owner apart from inviting and billing), guests (the plan and work of the projects they are assigned, nothing else),
// and nobody ever sees another person's personal space.

/** A caller: a person in a first-party session, an agent a person signed in (OAuth), or an agent a team delegated. */
export type Caller =
  | { kind: 'person'; uid: string }
  | { kind: 'agent'; uid: string; client: string; scopes: string[] }
  | { kind: 'team_agent'; space: string; client: string; clientId?: string };

/** The relation a caller holds to one space (or 'owner' to its own personal space; 'delegate' only for team agents). */
export type Relation = 'owner' | 'member' | 'guest' | 'delegate' | 'none';

export type Action =
  | 'space.see' | 'plan.read' | 'plan.write' | 'members.read' | 'members.manage' | 'billing.manage'
  | 'charter.read' | 'charter.propose' | 'charter.consent' | 'cards.read' | 'cards.publish' | 'cards.mode' | 'space.transfer' | 'space.delete' | 'space.leave'
  | 'work.share' | 'brief.read' | 'plan.propose' | 'proposal.decide' | 'agent.manage';

/** Per action: the relations that grant it, and the scope an agent acting for a person needs (null: people only). */
export const TABLE: Readonly<Record<Action, { by: readonly Relation[]; agent: 'wbs.read' | 'wbs.write' | null }>> = {
  'space.see':       { by: ['owner', 'member', 'guest', 'delegate'], agent: 'wbs.read' },
  'plan.read':       { by: ['owner', 'member', 'guest', 'delegate'], agent: 'wbs.read' },   // a guest: assigned projects only
  'plan.write':      { by: ['owner', 'member'], agent: 'wbs.write' },
  'members.read':    { by: ['owner', 'member'], agent: 'wbs.read' },
  'members.manage':  { by: ['owner'], agent: null },   // invite (joining is the invited person's own act), remove, change a role, assign a guest's projects
  'billing.manage':  { by: ['owner'], agent: null },
  'charter.read':    { by: ['owner', 'member', 'delegate'], agent: 'wbs.read' },
  'charter.propose': { by: ['owner', 'member'], agent: null },
  'charter.consent': { by: ['owner', 'member'], agent: null },   // agreeing is a person's own act
  'cards.read':      { by: ['owner', 'member', 'delegate'], agent: null },   // work-style and direction cards (4.2)
  'cards.publish':   { by: ['owner', 'member'], agent: null },   // one's own card, by one's own hand
  'cards.mode':      { by: ['owner'], agent: null },   // employee mode: the team runs without cards
  'brief.read':      { by: ['owner', 'member', 'delegate'], agent: 'wbs.read' },   // the weekly team brief (4.3): the whole team's work
  'plan.propose':    { by: ['delegate'], agent: null },   // the team master agent (4.5) proposes plan changes and weekly reports
  'proposal.decide': { by: ['owner', 'member'], agent: null },   // approving is a person's own act (the item's A; the owner for reports)
  'agent.manage':    { by: ['owner'], agent: null },   // delegating and stopping the team master agent
  'space.transfer':  { by: ['owner'], agent: null },
  'space.delete':    { by: ['owner'], agent: null },
  'space.leave':     { by: ['member', 'guest'], agent: null },   // the owner hands the space over first
  'work.share':      { by: ['owner', 'member'], agent: 'wbs.write' },   // link one's own rows to the team plan, field by field
};

export interface Decision { allow: boolean; code?: 'not_found' | 'forbidden'; why: string }

/** The decision for one caller, relation and action. No relation answers not_found, so a space's existence is never
 *  disclosed to someone outside it; every other refusal is forbidden and says why. */
export function decide(caller: Caller, relation: Relation, action: Action): Decision {
  if (relation === 'none') return { allow: false, code: 'not_found', why: 'not in this space' };
  if ((caller.kind === 'team_agent') !== (relation === 'delegate')) return { allow: false, code: 'forbidden', why: 'only a team-delegated agent holds the delegate relation' };
  const rule = TABLE[action];
  if (!rule.by.includes(relation)) return { allow: false, code: 'forbidden', why: `a ${relation} cannot ${action}` };
  if (caller.kind === 'agent') {
    if (!rule.agent) return { allow: false, code: 'forbidden', why: `${action} is for people, not agents` };
    if (!caller.scopes.includes(rule.agent)) return { allow: false, code: 'forbidden', why: `${action} needs the ${rule.agent} scope` };
  }
  return { allow: true, why: 'allowed' };
}

/** The account a person or person-signed agent acts as; a team agent acts as nobody. */
export const callerUid = (c: Caller): string | null => c.kind === 'team_agent' ? null : c.uid;
export const person = (uid: string): Caller => ({ kind: 'person', uid });
export const agent = (uid: string, client: string, scopes: string[]): Caller => ({ kind: 'agent', uid, client, scopes });
