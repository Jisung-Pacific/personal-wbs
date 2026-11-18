// The MCP face of the hub. A fresh server per request (stateless Streamable HTTP), built for the signed-in account and the
// scopes its token carries: a client sees only the tools it may call. Tool texts are written for agents — what each tool
// is for, when to use it, and the ledger's rules — so every agent logs work the same way.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AddInput, Ledger, LedgerError, SearchInput, UpdateInput, type Actor } from './wbs/service.js';
import { InboxAddInput, InboxListInput, InboxMarkInput, type Inbox } from './wbs/inbox.js';
import { agent } from './wbs/access.js';
import type { Spaces } from './wbs/spaces.js';

export const INSTRUCTIONS = `PP WBS Hub keeps one person's work ledger: every year of their work as atomic rows (one concrete deliverable, decision or event per row, dated from its source), shared by every agent they use.
- Before adding, search (wbs_search) for the same work; extend an existing task with a dated step (wbs_add with parent) or a status change (wbs_update) instead of a near-duplicate row.
- Use wbs_packages to pick the package; codes are allocated by the hub (next free number) and never change.
- Write the task text in the user's language, concrete, with numbers; one result per row, never a summary of several.
- Dates are YYYY-MM-DD (YYYY-MM when only the month is known). Status: 완료, 진행 중, 대기·심사 (waiting on others), 백로그 (parked by the user).
- Leave out: amounts of pay, scholarships, prizes, personal transfers, property and equity; health; relationships; bank details; other people's personal handles.
- Planning, advising or reviewing: call wbs_brief first and drill down only where it points (wbs_search, wbs_get); do not page through the ledger.
- Record work silently in the background when the user finishes something concrete; mention it only if they ask.
- The inbox holds raw material captured where no agent could write (chats on other AI sites, searches, notes). When asked to process it, read wbs_inbox_list, turn what is concrete work into rows with the rules above, and mark every item merged (with the codes) or skipped.
- Every tool works on the user's personal ledger unless you pass space: a team space id from wbs_spaces, for the team's plan and work. Write personal work to the personal ledger and team plan items to the team space. A guest sees only its assigned projects; people, not agents, manage a space's members.`;

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => {
  if (e instanceof LedgerError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, detail: e.detail }) }] };
  if (e instanceof z.ZodError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid', issues: e.issues }) }] };
  throw e;
};
const run = async (f: () => Promise<unknown>) => { try { return ok(await f()); } catch (e) { return fail(e); } };

export function buildMcp(ledger: Ledger, spaces: Spaces, actor: Actor, scopes: string[], version: string, inbox?: Inbox): McpServer {
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
