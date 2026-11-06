// The MCP face of the hub. A fresh server per request (stateless Streamable HTTP), built for the signed-in account and the
// scopes its token carries: a client sees only the tools it may call. Tool texts are written for agents — what each tool
// is for, when to use it, and the ledger's rules — so every agent logs work the same way.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AddInput, Ledger, LedgerError, SearchInput, UpdateInput, type Actor } from './wbs/service.js';

export const INSTRUCTIONS = `PP WBS Hub keeps one person's work ledger: every year of their work as atomic rows (one concrete deliverable, decision or event per row, dated from its source), shared by every agent they use.
- Before adding, search (wbs_search) for the same work; extend an existing task with a dated step (wbs_add with parent) or a status change (wbs_update) instead of a near-duplicate row.
- Use wbs_packages to pick the package; codes are allocated by the hub (next free number) and never change.
- Write the task text in the user's language, concrete, with numbers; one result per row, never a summary of several.
- Dates are YYYY-MM-DD (YYYY-MM when only the month is known). Status: 완료, 진행 중, 대기·심사 (waiting on others), 백로그 (parked by the user).
- Leave out: amounts of pay, scholarships, prizes, personal transfers, property and equity; health; relationships; bank details; other people's personal handles.
- Record work silently in the background when the user finishes something concrete; mention it only if they ask.`;

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => {
  if (e instanceof LedgerError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, detail: e.detail }) }] };
  if (e instanceof z.ZodError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid', issues: e.issues }) }] };
  throw e;
};
const run = async (f: () => Promise<unknown>) => { try { return ok(await f()); } catch (e) { return fail(e); } };

export function buildMcp(ledger: Ledger, actor: Actor, scopes: string[], version: string): McpServer {
  const server = new McpServer({ name: 'ppwbs-hub', title: 'PP WBS Hub', version }, { instructions: INSTRUCTIONS });
  const read = scopes.includes('wbs.read'), write = scopes.includes('wbs.write');
  const ro = { readOnlyHint: true, openWorldHint: false } as const;

  if (read) {
    server.registerTool('wbs_search', {
      title: 'Search the work ledger',
      description: 'Find rows by year, status, package code or words in the task. Use before adding work to avoid duplicates, and to answer questions about what the user did or is doing.',
      inputSchema: SearchInput.shape, annotations: ro,
    }, async a => run(() => ledger.search(actor.uid, a)));

    server.registerTool('wbs_get', {
      title: 'Open one ledger row',
      description: 'One row with its dated steps and its change history.',
      inputSchema: { year: z.string().regex(/^\d{4}$/), code: z.string().regex(/^\d+(\.\d+)+$/) }, annotations: ro,
    }, async a => run(() => ledger.get(actor.uid, a.year, a.code)));

    server.registerTool('wbs_packages', {
      title: 'List packages of a year',
      description: 'The packages (work streams) of one year with their area, goal, open tasks and the next free code. Pick the package here before wbs_add.',
      inputSchema: { year: z.string().regex(/^\d{4}$/) }, annotations: ro,
    }, async a => run(() => ledger.packages(actor.uid, a.year)));

    server.registerTool('wbs_summary', {
      title: 'Summarize the ledger',
      description: 'Task counts by year and status, the most recently active open tasks and the latest changes.',
      inputSchema: { year: z.string().regex(/^\d{4}$/).optional() }, annotations: ro,
    }, async a => run(() => ledger.summary(actor.uid, a.year)));

    server.registerTool('wbs_export', {
      title: 'Export the whole ledger as CSV',
      description: 'The full wbs.csv and events.csv (hundreds of KB). For dashboards and backups; do not call it to answer a question in conversation — use wbs_search or wbs_summary.',
      inputSchema: {}, annotations: ro,
    }, async () => run(() => ledger.exportCsv(actor.uid)));
  }

  if (write) {
    server.registerTool('wbs_add', {
      title: 'Record new work',
      description: 'Add one concrete deliverable, decision or event. The hub assigns the code: the next task in the package, or the next dated step under `parent`. Refuses a near-duplicate of an existing task and returns it; then update that task or add a step under it.',
      inputSchema: AddInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async a => run(() => ledger.add(actor, a)));

    server.registerTool('wbs_update', {
      title: 'Update a task',
      description: 'Change status, end date, due date, importance or blocker of an existing row. The change and its memo go into the history; the task text is never rewritten (record a new result as a step with wbs_add).',
      inputSchema: UpdateInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async a => run(() => ledger.update(actor, a)));
  }
  return server;
}
