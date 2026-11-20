// The MCP face of the hub. A fresh server per request (stateless Streamable HTTP), built for the signed-in account and the
// scopes its token carries: a client sees only the tools it may call. Tool texts are written for agents — what each tool
// is for, when to use it, and the ledger's rules — so every agent logs work the same way.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AddInput, Ledger, LedgerError, SearchInput, UpdateInput, type Actor } from './wbs/service.js';
import { InboxAddInput, InboxListInput, InboxMarkInput, type Inbox } from './wbs/inbox.js';
import { agent, type Caller } from './wbs/access.js';
import type { Spaces } from './wbs/spaces.js';
import type { Store } from './store/types.js';
import { IntentInput, PlanItemInput, ShareInput, type Plans } from './wbs/plan.js';
import { ViewsInput, type Views } from './wbs/views.js';
import { switchList, teamOverview } from './wbs/team.js';
import type { Briefs } from './wbs/weekly.js';
import { ProposeInput, ReportInput, type MasterAgent } from './wbs/master.js';

export const INSTRUCTIONS = `PP WBS Hub keeps one person's work ledger: every year of their work as atomic rows (one concrete deliverable, decision or event per row, dated from its source), shared by every agent they use.
- Before adding, search (wbs_search) for the same work; extend an existing task with a dated step (wbs_add with parent) or a status change (wbs_update) instead of a near-duplicate row.
- Use wbs_packages to pick the package; codes are allocated by the hub (next free number) and never change.
- Write the task text in the user's language, concrete, with numbers; one result per row, never a summary of several.
- Dates are YYYY-MM-DD (YYYY-MM when only the month is known). Status: 완료, 진행 중, 대기·심사 (waiting on others), 백로그 (parked by the user).
- Leave out: amounts of pay, scholarships, prizes, personal transfers, property and equity; health; relationships; bank details; other people's personal handles.
- Planning, advising or reviewing: call wbs_brief first and drill down only where it points (wbs_search, wbs_get); do not page through the ledger.
- Record work silently in the background when the user finishes something concrete; mention it only if they ask.
- The inbox holds raw material captured where no agent could write (chats on other AI sites, searches, notes). When asked to process it, read wbs_inbox_list, turn what is concrete work into rows with the rules above, and mark every item merged (with the codes) or skipped.
- A team space has a plan (its project WBS): read it against the actual work with wbs_plan, write it with wbs_plan_put. Record a person's own work in their personal ledger and link it to a plan item with wbs_share; only the fields they choose reach the team, and wbs_views shows the person who read them.
- Every tool works on the user's personal ledger unless you pass space: a team space id from wbs_spaces, for the team's plan and work. Write personal work to the personal ledger and team plan items to the team space. A guest sees only its assigned projects; people, not agents, manage a space's members. A team space opens to a member once they have agreed to its charter (wbs_charter); agreeing and proposing changes are for the user to do, so tell them when a proposal waits for their answer.
- One account can be in several teams. wbs_spaces says per team what waits for the user (charter answers, proposals to decide, reports to approve) and lists invitations to other teams (kind invite). People join a team only by accepting an invitation themselves on the hub (accept_url); tell the user, never answer it for them.`;

/** What changes when the connection is a team's own address (execution WBS 3.8): the team is the default, and the
 *  person's work still lands in their own ledger, linked to the team's plan. */
export const TEAM_INSTRUCTIONS = (space: string) => `
This connection is a team environment: the team space ${space} (wbs_spaces marks it this_connection). Here:
- Without space, reading tools (wbs_brief, wbs_search, wbs_get, wbs_packages, wbs_summary, wbs_export, wbs_plan, wbs_team, wbs_charter, wbs_views) work on this team.
- Record the user's work with wbs_add and change it with wbs_update, without space: the row goes to the user's own ledger and is linked to this team's plan, so the team sees only the charter's default fields (title, status, dates, links). Pass plan (a plan item code from wbs_plan view items) when you know the item. Without it the hub links the item it matches with confidence; otherwise the row waits unlinked (status pending, with suggestions) and nothing reaches the team until you ask the user and call wbs_share with the plan.
- The user's personal ledger is not readable from this connection; the rows linked to this team are listed by wbs_shared. To record a team-level entry that belongs to no one person, pass space with this team's id.`;
/** The team master agent's connection (4.5): the team's delegate, reading the team summary and proposing. */
export const TEAM_AGENT_INSTRUCTIONS = (space: string) => `
You are the master agent of the team space ${space}, delegated by its owner. You act for the team, not for any person.
- Read the team summary only: wbs_team (plan against actual work without names, intent alignment in counts, the weekly brief), wbs_weekly, wbs_plan, wbs_charter. You cannot read anyone's ledger, cards or view logs.
- You recommend; people decide. Change nothing directly: wbs_propose kind "plan" proposes plan item changes with why (the accountable person, A, of each touched item approves on the hub), kind "report" drafts the weekly report for an ended week (the owner approves it before the team sees it). wbs_proposals shows how your proposals and reports were decided.
- The weekly report is about the work: what moved, what is stuck and why, what is at risk in the next seven days, which intents drift, and what to decide. Never name, rank, rate or compare people, and never assign work to a person.
- A good rhythm: on Monday after the brief (wbs_weekly) draft the report for last week, and propose at most a few plan changes it calls for.
- The owner can stop you at any time; then every call is refused.`;
const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => {
  if (e instanceof LedgerError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, detail: e.detail }) }] };
  if (e instanceof z.ZodError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid', issues: e.issues }) }] };
  throw e;
};
const run = async (f: () => Promise<unknown>) => { try { return ok(await f()); } catch (e) { return fail(e); } };

/** `env`: the team space when the connection came through that team's own address (3.8); `hubUrl` gives each team its
 *  connector address in wbs_spaces. */
export interface McpOptions { env?: string; hubUrl?: string; briefs?: Briefs; master?: MasterAgent; teamAgent?: { space: string; client: string; clientId: string } }

export function buildMcp(ledger: Ledger, spaces: Spaces, actor: Actor, scopes: string[], version: string, inbox?: Inbox, plans?: Plans, views?: Views, ledgerStore?: Store, opts: McpOptions = {}): McpServer {
  if (opts.teamAgent) return buildTeamAgentMcp(spaces, scopes, version, plans!, views, ledgerStore!, opts);
  const env = opts.env;
  const server = new McpServer({ name: 'ppwbs-hub', title: 'PP WBS Hub', version }, { instructions: INSTRUCTIONS + (env ? TEAM_INSTRUCTIONS(env) : '') });
  const read = scopes.includes('wbs.read'), write = scopes.includes('wbs.write');
  const ro = { readOnlyHint: true, openWorldHint: false } as const;
  // the agent acts for the signed-in person within the granted scopes; the permission table decides each space call
  const caller = agent(actor.uid, actor.clientName, scopes);
  const space = { space: z.string().optional().describe(env ? 'This team (default) or another team space id from wbs_spaces; the personal ledger is not readable from a team connection'
    : '"personal" (default) or a team space id from wbs_spaces') };
  /** The space a call works on: the one given, else the connection's team, else the personal ledger. A team connection
   *  never reads the personal ledger (what is linked to the team is in wbs_shared). */
  const at = async (s: string | undefined, need: 'read' | 'write') => {
    const target = s ?? env;
    if (env && need === 'read' && (!target || target === 'personal')) throw new LedgerError('forbidden', 'A team connection does not read the personal ledger; the rows linked to this team are listed by wbs_shared');
    return spaces.view(caller, target, need);
  };
  // tools that always work on a team space: required on a personal connection, this team by default on a team one
  const teamSpace = env ? z.string().optional().describe('A team space id; defaults to this connection\'s team') : z.string().describe('A team space id from wbs_spaces');
  const sp = (s: string | undefined) => s ?? env ?? '';

  if (read) {
    server.registerTool('wbs_search', {
      title: 'Search the work ledger',
      description: 'Find rows by year, status, package code or words in the task. Use before adding work to avoid duplicates, and to answer questions about what the user did or is doing.',
      inputSchema: { ...SearchInput.shape, ...space }, annotations: ro,
    }, async a => run(async () => ledger.search(await at(a.space, 'read'), a)));

    server.registerTool('wbs_spaces', {
      title: 'List the spaces',
      description: 'The personal space and every team space the user belongs to, with the user\'s role (owner, member, guest; a guest also gets its projects). Pass a team space id as `space` to the other tools to work in that team\'s plan. For a team the user owns or is a member of, waiting counts what is theirs to do there: charter (agree to the version in force or answer a proposal), decide (plan proposals), drafts (weekly reports to approve), total. Each team carries connector_url, its own MCP address: added as a connector (for example once by a team\'s Claude organisation), it opens that team\'s environment, where work is recorded for the team automatically. this_connection marks the space this connection works in. Entries of kind invite are invitations to other teams waiting for the user (space, invite, name, role, expires): not spaces yet; the user accepts or declines them on the hub at accept_url.',
      inputSchema: {}, annotations: ro,
    }, async () => run(async () => (await switchList(spaces, caller, opts.master, opts.hubUrl)).map(x => x.kind === 'invite' ? x : ({ ...x,
      ...(x.kind === 'team' && opts.hubUrl && x.role !== 'guest' ? { connector_url: `${opts.hubUrl}/mcp/t/${x.id}` } : {}),
      ...((env ? x.id === env : x.kind === 'personal') ? { this_connection: true } : {}) }))));

    server.registerTool('wbs_charter', {
      title: 'Read a team space\'s charter',
      description: 'The charter of a team space (at most 9 lines): the version in force, an open proposal with who has agreed and who still has to answer, and every version so far. A member enters the space only after agreeing to the version in force; agreeing and proposing are done by the user, not by agents.',
      inputSchema: { space: teamSpace }, annotations: ro,
    }, async a => run(() => spaces.charter(caller, sp(a.space))));
    if (plans) server.registerTool('wbs_plan', {
      title: 'Read a team plan against the actual work',
      description: 'The team space\'s plan (its project WBS: scope, deliverable, done criterion, prerequisites, owners, planned dates) set against the work members linked to it from their own ledgers: per item the shared rows, how many are done, the state and dates they show, days late against the due date, and flags (late, in progress with no work, plan done with work open, work done with the plan open, work started on a parked item, waiting). view "items" gives the plan items with their change log instead; view "alignment" sets the team\'s intents (why, what, how, ranked) against where the shared work actually goes: per intent its plan items and work share, flags (no plan, no work, less work than a lower-ranked intent), plan items serving no intent, and per person (owners and members see each other\'s, symmetrically). Members see who did the work; guests see their projects only and no alignment.',
      inputSchema: { space: teamSpace, view: z.enum(['actual', 'items', 'alignment']).optional().describe('actual (default): plan vs actual; items: the plan items; alignment: intents vs work'), year: z.string().regex(/^\d{4}$/).optional() },
      annotations: ro,
    }, async a => run(() => a.view === 'items' ? plans.list(caller, sp(a.space), a.year) : a.view === 'alignment' ? plans.align(caller, sp(a.space)) : plans.actual(caller, sp(a.space), a.year)));
    if (plans) server.registerTool('wbs_shared', {
      title: 'List what you share with teams',
      description: 'Your rows that are linked to team plan items: which plan item each serves, which fields the team sees, and whether the team still receives them. pending: recorded through a team connection and waiting for its plan item (nothing reaches the team yet). On a team connection, only the rows of that team.',
      inputSchema: {}, annotations: ro,
    }, async () => run(() => plans.mine(caller, env)));
    if (plans && ledgerStore) server.registerTool('wbs_team', {
      title: 'Open a team space',
      description: 'Everything a team screen shows, in one call: the space and the user\'s role, the charter in force and any open proposal, the members with their display titles (owners and members only; a title grants nothing, the role does), the plan against the actual work (as wbs_plan), the user\'s own rows shared there, and who read them in the last 30 days. Use it when the user switches to a team or asks how the team is doing.',
      inputSchema: { space: teamSpace }, annotations: ro,
    }, async a => run(async () => {
      const t = await teamOverview(ledgerStore!, spaces, plans, views, caller, sp(a.space), opts.briefs, opts.master);   // its address only for those who may connect it
      return { ...t, ...(opts.hubUrl && t.space.role !== 'guest' ? { connector_url: `${opts.hubUrl}/mcp/t/${t.space.id}` } : {}) };
    }));
    const briefs = opts.briefs;
    if (briefs) server.registerTool('wbs_weekly', {
      title: 'Read the team\'s weekly brief',
      description: 'A team\'s weekly brief (owners, members and the team\'s agent): progress in the week, bottlenecks, risks for the next seven days, the intents, and what falls due next — about the work only, never naming or comparing people. Default: the last week that has ended (generated Monday morning and then kept, so the whole team reads the same text); pass week (YYYY-Www) for an earlier one, or the current week for a live view that is not kept. Pass its lines to the team as they are.',
      inputSchema: { space: teamSpace, week: z.string().regex(/^\d{4}-W\d{2}$/).optional().describe('ISO week, e.g. 2026-W47') }, annotations: ro,
    }, async a => run(() => briefs.weekly(caller, sp(a.space), a.week)));
    if (briefs) server.registerTool('wbs_coach', {
      title: 'Coach the user on their own work',
      description: 'Personal coaching for the user alone: their pace against their own past weeks (never anyone else\'s), what is overdue, due within seven days or stalled, the work style their rows show, and their part in each team (plan items they own, rows waiting for a plan item). Speak to the user only; never put it in a team brief or show it to others.'
        + (env ? ' On this team connection it covers only the rows linked to this team.' : ''),
      inputSchema: {}, annotations: ro,
    }, async () => run(() => briefs.coach(caller, env)));
    if (views) server.registerTool('wbs_views', {
      title: 'See who viewed your shared rows',
      description: 'Who read team content carrying the user\'s shared rows: which person (and through which agent) or the team\'s agent, in which team space, how many of the user\'s rows, and when (first and last time each day, how often). Only the user sees this; their own reads are not listed. Days are kept 180 days.',
      inputSchema: ViewsInput.shape, annotations: ro,
    }, async a => run(() => views.mine(caller, env ? { ...a, space: a.space ?? env } : a)));

    server.registerTool('wbs_get', {
      title: 'Open one ledger row',
      description: 'One row with its dated steps and its change history.',
      inputSchema: { year: z.string().regex(/^\d{4}$/), code: z.string().regex(/^\d+(\.\d+)+$/), ...space }, annotations: ro,
    }, async a => run(async () => ledger.get(await at(a.space, 'read'), a.year, a.code)));

    server.registerTool('wbs_packages', {
      title: 'List packages of a year',
      description: 'The packages (work streams) of one year with their area, goal, open tasks and the next free code. Pick the package here before wbs_add.',
      inputSchema: { year: z.string().regex(/^\d{4}$/), ...space }, annotations: ro,
    }, async a => run(async () => ledger.packages(await at(a.space, 'read'), a.year)));

    server.registerTool('wbs_brief', {
      title: 'Brief for planning and advice',
      description: 'Start here to plan, advise or review: one compact picture of the ledger — status counts, six-month flow, where the effort went, open, overdue and soon-due work, what waits on others, work-style indicators (pace, time to finish, work in progress, weekday rhythm, area mix) and the signals worth acting on. In a team space it also sets the team\'s intents against where the shared work goes (alignment; owners and members). About a thousand tokens; then drill down with wbs_search or wbs_get.',
      inputSchema: { year: z.string().regex(/^\d{4}$/).optional().describe('Year for the counts; defaults to the current year (flows and work style use the last 90 days)'), ...space }, annotations: ro,
    }, async a => run(async () => {   // a team space's brief also sets the team's intents against the work (4.1)
      const b = await ledger.brief(await at(a.space, 'read'), a.year), target = a.space ?? env;
      if (!plans || !target || target === 'personal') return b;
      try { return { ...b, alignment: await plans.align(caller, target) }; } catch (e) { if (e instanceof LedgerError) return b; throw e; }
    }));

    server.registerTool('wbs_summary', {
      title: 'Summarize the ledger',
      description: 'Task counts by year and status, the most recently active open tasks and the latest changes.',
      inputSchema: { year: z.string().regex(/^\d{4}$/).optional(), ...space }, annotations: ro,
    }, async a => run(async () => ledger.summary(await at(a.space, 'read'), a.year)));

    server.registerTool('wbs_export', {
      title: 'Export the whole ledger as CSV',
      description: 'The full wbs.csv and events.csv (hundreds of KB). For dashboards and backups; do not call it to answer a question in conversation — use wbs_search or wbs_summary.',
      inputSchema: { order: z.enum(['newest', 'oldest']).optional().describe('Year order of the wbs.csv rows: newest first (default) or oldest first'), ...space },
      annotations: ro,
    }, async a => run(async () => ledger.exportCsv(await at(a.space, 'read'), a.order)));

    if (inbox && !env) server.registerTool('wbs_inbox_list', {   // the inbox is personal raw material: not on a team connection
      title: 'Read the inbox',
      description: 'Raw material captured where no agent could write the ledger (chats on other AI sites, searches, notes), newest first. Turn what is concrete work into rows, then mark each item with wbs_inbox_mark.',
      inputSchema: InboxListInput.shape, annotations: ro,
    }, async a => run(() => inbox.list(actor.uid, a)));
  }

  if (write) {
    // on a team connection, work without space is the user's own row, linked to this team's plan (3.8)
    const TEAM_ADD = {
      plan: z.string().regex(/^\d+(\.\d+){0,3}$/).optional().describe('The plan item of this team the work serves (wbs_plan view items); omit to let the hub match one'),
      plan_year: z.string().regex(/^\d{4}$/).optional().describe('The plan year; defaults to the row\'s year'),
    };
    const addShape = { ...AddInput.shape, ...space, ...TEAM_ADD };
    if (!(env && plans)) { delete (addShape as Partial<typeof addShape>).plan; delete (addShape as Partial<typeof addShape>).plan_year; }   // only a team connection links
    const own = async () => (await spaces.view(caller, 'personal', 'write')).owner;
    server.registerTool('wbs_add', {
      title: 'Record new work',
      description: 'Add one concrete deliverable, decision or event. The hub assigns the code: the next task in the package, or the next dated step under `parent`. Refuses a near-duplicate of an existing task and returns it; then update that task or add a step under it.'
        + (env ? ' On this team connection, without space the row is the user\'s own and is linked to this team\'s plan (see team in the result: linked, or pending with suggestions).' : ''),
      inputSchema: addShape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ space: s, plan, plan_year, ...a }) => run(async () => {
      if (!env || !plans || s !== undefined) return ledger.add(actor, a, (await at(s, 'write')).owner);
      await spaces.enter(caller, env, 'work.share');   // recording for the team is for its owners and members
      const r = await ledger.add(actor, a, await own());
      return { ...r, team: await plans.recordFor(caller, env, r.created, plan, plan_year) };
    }));

    server.registerTool('wbs_update', {
      title: 'Update a task',
      description: 'Change status, end date, due date, importance or blocker of an existing row. The change and its memo go into the history; the task text is never rewritten (record a new result as a step with wbs_add).'
        + (env ? ' On this team connection, without space it changes the user\'s own rows linked to this team (the team\'s copy follows).' : ''),
      inputSchema: { ...UpdateInput.shape, ...space }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ space: s, ...a }) => run(async () => {
      if (!env || !plans || s !== undefined) return ledger.update(actor, a, (await at(s, 'write')).owner);
      const l = await plans.linkOf(caller, a.year, a.code);
      if (!l || l.space !== env) throw new LedgerError('forbidden', 'On a team connection, rows of your own ledger can be changed only when they are linked to this team; pass space for a team-level row');
      return ledger.update(actor, a, await own());
    }));
    if (plans) server.registerTool('wbs_plan_put', {
      title: 'Write a team plan',
      description: 'Add items to a team space\'s plan or change them (owners and members). Codes are the plan\'s own (1, 1.1, 1.1.1) and permanent; a child needs its parent; give only the fields that change; park an item with status 백로그 instead of deleting it. Up to 200 items per call, applied in code order. intents sets the team\'s intents (why, what, how; at most five active, ranked; retire rather than delete), written before the items, which point at them with intent.',
      inputSchema: { space: teamSpace, items: z.array(PlanItemInput).max(200).optional(), intents: z.array(IntentInput).max(10).optional(), memo: z.string().max(300).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ space: s, ...a }) => run(() => plans.put(caller, sp(s), a)));
    if (plans) server.registerTool('wbs_share', {
      title: 'Share a row of yours with a team plan',
      description: 'Link one row of the user\'s own ledger to a team plan item and choose which of its fields the team sees (status always; default title, status, start, end, due, last_progress, links; add goal, blocker, evidence or task only when the user wants them shared). The team\'s copy follows the row from then on. stop: true withdraws it. Work is recorded in the personal ledger first (wbs_add), then shared.',
      inputSchema: { ...ShareInput.partial({ space: true, plan: true }).shape, stop: z.boolean().optional().describe('Withdraw the row from the team') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ stop, ...a }) => run(() => stop ? plans.unshare(caller, a) : plans.share(caller, { ...a, space: a.space ?? env } as never)));

    if (inbox && !env) {
      server.registerTool('wbs_inbox_add', {
        title: 'Drop raw material into the inbox',
        description: 'Keep something to be turned into rows later: a chat transcript, a search, a note, an exported record. Sending the same item twice changes nothing. Prefer wbs_add when the work is already clear.',
        inputSchema: InboxAddInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async a => run(() => inbox.add(actor.uid, a)));
      server.registerTool('wbs_inbox_mark', {
        title: 'Mark inbox items processed',
        description: 'After processing: merged (give the ledger codes in ref) or skipped (not work, or already recorded). Processed items are deleted 30 days later.',
        inputSchema: InboxMarkInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async a => run(() => inbox.mark(actor.uid, a)));
    }
  }
  return server;
}

/** The team master agent's server (4.5): the team summary to read and proposals to make, nothing else. */
function buildTeamAgentMcp(spaces: Spaces, scopes: string[], version: string, plans: Plans, views: Views | undefined, store: Store, opts: McpOptions): McpServer {
  const ta = opts.teamAgent!, space = ta.space, master = opts.master!, briefs = opts.briefs;
  const server = new McpServer({ name: 'ppwbs-hub', title: 'PP WBS Hub · team master agent', version }, { instructions: TEAM_AGENT_INSTRUCTIONS(space) });
  const caller: Caller = { kind: 'team_agent', space, client: ta.client, clientId: ta.clientId };
  const ro = { readOnlyHint: true, openWorldHint: false } as const;
  server.registerTool('wbs_team', {
    title: 'Read the team summary',
    description: 'The team as its delegate sees it: the charter in force, the plan against the actual work (counts, no names), intent alignment in counts, last week\'s brief with its approved report, and how your proposals stand.',
    inputSchema: {}, annotations: ro,
  }, async () => run(() => teamOverview(store, spaces, plans, views, caller, space, briefs, master)));
  if (briefs) server.registerTool('wbs_weekly', {
    title: 'Read the weekly brief',
    description: 'The team\'s weekly brief (default: the last week that has ended; generated Monday morning): progress, bottlenecks with reasons, shared blockers, risks within seven days, drifting intents, what falls due. The basis for the weekly report you draft.',
    inputSchema: { week: z.string().regex(/^\d{4}-W\d{2}$/).optional() }, annotations: ro,
  }, async a => run(() => briefs.weekly(caller, space, a.week)));
  server.registerTool('wbs_plan', {
    title: 'Read the team plan',
    description: 'The plan against the actual work (default), its items with their change log (view items), or the intents against where the work goes (view alignment), without names.',
    inputSchema: { view: z.enum(['actual', 'items', 'alignment']).optional(), year: z.string().regex(/^\d{4}$/).optional() }, annotations: ro,
  }, async a => run(() => a.view === 'items' ? plans.list(caller, space, a.year) : a.view === 'alignment' ? plans.align(caller, space) : plans.actual(caller, space, a.year)));
  server.registerTool('wbs_charter', {
    title: 'Read the team charter', description: 'The charter in force and any open proposal.', inputSchema: {}, annotations: ro,
  }, async () => run(() => spaces.charter(caller, space)));
  server.registerTool('wbs_proposals', {
    title: 'See how your proposals were decided',
    description: 'Your plan proposals (open, applied, declined, stale, withdrawn) with the changes each makes and how many people decide it, and your weekly reports with their status and the owner\'s note.',
    inputSchema: {}, annotations: ro,
  }, async () => run(() => master.list(caller, space)));
  if (scopes.includes('wbs.write')) server.registerTool('wbs_propose', {
    title: 'Propose a plan change or draft the weekly report',
    description: 'kind "plan": plan item changes or new items (wbs_plan_put\'s item shape, without A) with why; checked now and applied only when the accountable person of every item approves on the hub. kind "report": the weekly report for an ended week (default last week), about the work only — it names no one — with up to five recommendations; the owner approves it before the team sees it, and a new draft replaces an undecided one. You change nothing directly.',
    inputSchema: { kind: z.enum(['plan', 'report']), items: ProposeInput.shape.items.optional(), why: ProposeInput.shape.why.optional(), refs: ProposeInput.shape.refs,
      week: ReportInput.shape.week, text: ReportInput.shape.text.optional(), recommendations: ReportInput.shape.recommendations },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ kind, items, why, refs, week, text, recommendations }) => run(() => kind === 'plan'
    ? master.propose(caller, space, { items: items ?? [], why: why ?? '', refs })
    : master.proposeReport(caller, space, { week, text: text ?? '', recommendations })));
  return server;
}
