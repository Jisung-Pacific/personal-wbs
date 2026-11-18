// The MCP face of the hub. A fresh server per request (stateless Streamable HTTP), built for the signed-in account and the
// scopes its token carries: a client sees only the tools it may call. Tool texts are written for agents — what each tool
// is for, when to use it, and the ledger's rules — so every agent logs work the same way.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AddInput, Ledger, LedgerError, SearchInput, UpdateInput, type Actor } from './wbs/service.js';
import { InboxAddInput, InboxListInput, InboxMarkInput, type Inbox } from './wbs/inbox.js';
import { agent } from './wbs/access.js';
import type { Spaces } from './wbs/spaces.js';
import type { Store } from './store/types.js';
import { PlanItemInput, ShareInput, type Plans } from './wbs/plan.js';
import { ViewsInput, type Views } from './wbs/views.js';
import { teamOverview } from './wbs/team.js';

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
- Every tool works on the user's personal ledger unless you pass space: a team space id from wbs_spaces, for the team's plan and work. Write personal work to the personal ledger and team plan items to the team space. A guest sees only its assigned projects; people, not agents, manage a space's members. A team space opens to a member once they have agreed to its charter (wbs_charter); agreeing and proposing changes are for the user to do, so tell them when a proposal waits for their answer.`;

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => {
  if (e instanceof LedgerError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, detail: e.detail }) }] };
  if (e instanceof z.ZodError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid', issues: e.issues }) }] };
  throw e;
};
const run = async (f: () => Promise<unknown>) => { try { return ok(await f()); } catch (e) { return fail(e); } };

export function buildMcp(ledger: Ledger, spaces: Spaces, actor: Actor, scopes: string[], version: string, inbox?: Inbox, plans?: Plans, views?: Views, ledgerStore?: Store): McpServer {
  const server = new McpServer({ name: 'ppwbs-hub', title: 'PP WBS Hub', version }, { instructions: INSTRUCTIONS });
  const read = scopes.includes('wbs.read'), write = scopes.includes('wbs.write');
  const ro = { readOnlyHint: true, openWorldHint: false } as const;
  // the agent acts for the signed-in person within the granted scopes; the permission table decides each space call
  const caller = agent(actor.uid, actor.clientName, scopes);
  const space = { space: z.string().optional().describe('"personal" (default) or a team space id from wbs_spaces') };
  const at = (s: string | undefined, need: 'read' | 'write') => spaces.view(caller, s, need);

  if (read) {
    server.registerTool('wbs_search', {
      title: 'Search the work ledger',
      description: 'Find rows by year, status, package code or words in the task. Use before adding work to avoid duplicates, and to answer questions about what the user did or is doing.',
      inputSchema: { ...SearchInput.shape, ...space }, annotations: ro,
    }, async a => run(async () => ledger.search(await at(a.space, 'read'), a)));

    server.registerTool('wbs_spaces', {
      title: 'List the spaces',
      description: 'The personal space and every team space the user belongs to, with the user\'s role (owner, member, guest; a guest also gets its projects). Pass a team space id as `space` to the other tools to work in that team\'s plan.',
      inputSchema: {}, annotations: ro,
    }, async () => run(() => spaces.list(caller)));

    server.registerTool('wbs_charter', {
      title: 'Read a team space\'s charter',
      description: 'The charter of a team space (at most 9 lines): the version in force, an open proposal with who has agreed and who still has to answer, and every version so far. A member enters the space only after agreeing to the version in force; agreeing and proposing are done by the user, not by agents.',
      inputSchema: { space: z.string().describe('A team space id from wbs_spaces') }, annotations: ro,
    }, async a => run(() => spaces.charter(caller, a.space)));
    if (plans) server.registerTool('wbs_plan', {
      title: 'Read a team plan against the actual work',
      description: 'The team space\'s plan (its project WBS: scope, deliverable, done criterion, prerequisites, owners, planned dates) set against the work members linked to it from their own ledgers: per item the shared rows, how many are done, the state and dates they show, days late against the due date, and flags (late, in progress with no work, plan done with work open, work done with the plan open, work started on a parked item, waiting). view "items" gives the plan items with their change log instead. Members see who did the work; guests see their projects only.',
      inputSchema: { space: z.string().describe('A team space id from wbs_spaces'), view: z.enum(['actual', 'items']).optional().describe('actual (default): plan vs actual; items: the plan items'), year: z.string().regex(/^\d{4}$/).optional() },
      annotations: ro,
    }, async a => run(() => a.view === 'items' ? plans.list(caller, a.space, a.year) : plans.actual(caller, a.space, a.year)));
    if (plans) server.registerTool('wbs_shared', {
      title: 'List what you share with teams',
      description: 'Your rows that are linked to team plan items: which plan item each serves, which fields the team sees, and whether the team still receives them.',
      inputSchema: {}, annotations: ro,
    }, async () => run(() => plans.mine(caller)));
    if (plans && ledgerStore) server.registerTool('wbs_team', {
      title: 'Open a team space',
      description: 'Everything a team screen shows, in one call: the space and the user\'s role, the charter in force and any open proposal, the members (owners and members only), the plan against the actual work (as wbs_plan), the user\'s own rows shared there, and who read them in the last 30 days. Use it when the user switches to a team or asks how the team is doing.',
      inputSchema: { space: z.string().describe('A team space id from wbs_spaces') }, annotations: ro,
    }, async a => run(() => teamOverview(ledgerStore!, spaces, plans, views, caller, a.space)));
    if (views) server.registerTool('wbs_views', {
      title: 'See who viewed your shared rows',
      description: 'Who read team content carrying the user\'s shared rows: which person (and through which agent) or the team\'s agent, in which team space, how many of the user\'s rows, and when (first and last time each day, how often). Only the user sees this; their own reads are not listed. Days are kept 180 days.',
      inputSchema: ViewsInput.shape, annotations: ro,
    }, async a => run(() => views.mine(caller, a)));

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
      description: 'Start here to plan, advise or review: one compact picture of the ledger — status counts, six-month flow, where the effort went, open, overdue and soon-due work, what waits on others, work-style indicators (pace, time to finish, work in progress, weekday rhythm, area mix) and the signals worth acting on. About a thousand tokens; then drill down with wbs_search or wbs_get.',
      inputSchema: { year: z.string().regex(/^\d{4}$/).optional().describe('Year for the counts; defaults to the current year (flows and work style use the last 90 days)'), ...space }, annotations: ro,
    }, async a => run(async () => ledger.brief(await at(a.space, 'read'), a.year)));

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

    if (inbox) server.registerTool('wbs_inbox_list', {
      title: 'Read the inbox',
      description: 'Raw material captured where no agent could write the ledger (chats on other AI sites, searches, notes), newest first. Turn what is concrete work into rows, then mark each item with wbs_inbox_mark.',
      inputSchema: InboxListInput.shape, annotations: ro,
    }, async a => run(() => inbox.list(actor.uid, a)));
  }

  if (write) {
    server.registerTool('wbs_add', {
      title: 'Record new work',
      description: 'Add one concrete deliverable, decision or event. The hub assigns the code: the next task in the package, or the next dated step under `parent`. Refuses a near-duplicate of an existing task and returns it; then update that task or add a step under it.',
      inputSchema: { ...AddInput.shape, ...space }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ space: s, ...a }) => run(async () => ledger.add(actor, a, (await at(s, 'write')).owner)));

    server.registerTool('wbs_update', {
      title: 'Update a task',
      description: 'Change status, end date, due date, importance or blocker of an existing row. The change and its memo go into the history; the task text is never rewritten (record a new result as a step with wbs_add).',
      inputSchema: { ...UpdateInput.shape, ...space }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ space: s, ...a }) => run(async () => ledger.update(actor, a, (await at(s, 'write')).owner)));
    if (plans) server.registerTool('wbs_plan_put', {
      title: 'Write a team plan',
      description: 'Add items to a team space\'s plan or change them (owners and members). Codes are the plan\'s own (1, 1.1, 1.1.1) and permanent; a child needs its parent; give only the fields that change; park an item with status 백로그 instead of deleting it. Up to 200 items per call, applied in code order.',
      inputSchema: { space: z.string().describe('A team space id from wbs_spaces'), items: z.array(PlanItemInput).min(1).max(200), memo: z.string().max(300).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ space: s, ...a }) => run(() => plans.put(caller, s, a)));
    if (plans) server.registerTool('wbs_share', {
      title: 'Share a row of yours with a team plan',
      description: 'Link one row of the user\'s own ledger to a team plan item and choose which of its fields the team sees (status always; default status, start, end, last_progress; add task only when the user wants the text shared). The team\'s copy follows the row from then on. stop: true withdraws it. Work is recorded in the personal ledger first (wbs_add), then shared.',
      inputSchema: { ...ShareInput.partial({ space: true, plan: true }).shape, stop: z.boolean().optional().describe('Withdraw the row from the team') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ stop, ...a }) => run(() => stop ? plans.unshare(caller, a) : plans.share(caller, a as never)));

    if (inbox) {
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
