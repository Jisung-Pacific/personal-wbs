// The team screen in one call (execution WBS 3.6): what a page or an agent shows when someone switches to a team space —
// the space and the caller's role, the charter's state, the members (for those who may see them), the plan against the
// actual work, the caller's own rows shared there, and who read them. Every part follows the permission table: a guest
// gets its projects' plan without the charter or the member list; the team's agent gets the plan and the charter.
import type { Store } from '../store/types.js';
import { LedgerError } from './service.js';
import { callerUid, decide, type Caller } from './access.js';
import type { Spaces } from './spaces.js';
import type { Plans } from './plan.js';
import type { Views } from './views.js';
import type { Briefs } from './weekly.js';

export async function teamOverview(store: Store, spaces: Spaces, plans: Plans, views: Views | undefined, caller: Caller, space: string, briefs?: Briefs) {
  const e = await spaces.enter(caller, space, 'plan.read');
  const s = await store.space(space);
  if (!s) throw new LedgerError('not_found', 'No such space');
  const may = (a: Parameters<typeof decide>[2]) => decide(caller, e.relation, a).allow;
  const uid = callerUid(caller);
  const [charter, members, plan] = await Promise.all([
    may('charter.read') ? spaces.charter(caller, space) : Promise.resolve(null),
    may('members.read') ? spaces.members(caller, space) : Promise.resolve(null),
    plans.actual(caller, space),
  ]);
  const mine = uid ? (await plans.mine(caller)).filter(l => l.space === space) : [];
  const seen = uid && views ? await views.mine(caller, { space, days: 30 }) : null;
  const { space: _s, ...pva } = plan;
  const alignment = e.relation === 'guest' ? null : await plans.align(caller, space).then(({ space: _x, ...a }) => a);
  // last week's team brief (4.3): about the work only; guests do not get the whole team's picture
  const weekly = briefs && may('brief.read') ? await briefs.weekly(caller, space).then(({ space: _w, generated: _g, ...b }) => b) : null;
  return {
    space: { id: s.id, name: s.name, role: e.relation, ...(e.projects ? { projects: e.projects } : {}) },
    charter: charter && { in_force: charter.in_force?.version ?? null,   // getting here means the caller agreed to it (the gate)
      proposal: charter.proposal ? { version: charter.proposal.version,
        needs_my_answer: !!uid && Array.isArray(charter.proposal.waiting) && (charter.proposal.waiting as string[]).includes(uid) } : null },
    members: members && members.map(m => ({ uid: m.uid, role: m.role, since: m.since, ...(m.projects ? { projects: m.projects } : {}) })),
    plan: pva,
    alignment,
    weekly,
    my_shared: mine,
    my_views: seen && { totals: seen.totals, lines: seen.lines },
  };
}
