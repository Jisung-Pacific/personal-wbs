// The REST face: the same operations for agents that call HTTP functions rather than MCP (custom GPT Actions,
// DeepSeek or Kimi function calling, scripts). Same OAuth tokens, same rules; /openapi.json describes it.
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Ledger, LedgerError, type Actor } from './wbs/service.js';
import type { Inbox } from './wbs/inbox.js';
import { agent } from './wbs/access.js';
import type { Spaces } from './wbs/spaces.js';
import type { Plans } from './wbs/plan.js';
import type { Config } from './config.js';

export type Authed = Request & { actor?: Actor; scopes?: string[] };

function send(res: Response, f: () => Promise<unknown>) {
  f().then(v => res.json(v)).catch(e => {
    if (e instanceof LedgerError) return res.status({ not_found: 404, duplicate: 409, forbidden: 403, consent_required: 403, invalid: 400 }[e.code]).json({ error: e.code, message: e.message, detail: e.detail });
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid', issues: e.issues });
    console.error(e); res.status(500).json({ error: 'server_error' });
  });
}
const need = (scope: string) => (req: Authed, res: Response, next: () => void) =>
  req.scopes?.includes(scope) ? next() : res.status(403).set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`).json({ error: 'insufficient_scope', scope });

export function restRouter(ledger: Ledger, spaces: Spaces, inbox: Inbox, plans?: Plans): Router {
  const r = Router(); r.use(express.json({ limit: '256kb' }));
  const list = (v: unknown) => typeof v === 'string' && v ? v.split(',') : undefined;
  // the token's agent acts for its person; `?space=<id>` picks a team space (the permission table decides), default personal
  const at = (req: Authed, need: 'read' | 'write') =>
    spaces.view(agent(req.actor!.uid, req.actor!.clientName, req.scopes || []), typeof req.query.space === 'string' ? req.query.space : undefined, need);
  r.get('/spaces', need('wbs.read'), (req: Authed, res) => send(res, () => spaces.list(agent(req.actor!.uid, req.actor!.clientName, req.scopes || []))));
  r.get('/charter', need('wbs.read'), (req: Authed, res) => send(res, () => spaces.charter(agent(req.actor!.uid, req.actor!.clientName, req.scopes || []), String(req.query.space || ''))));
  r.get('/rows', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.search(await at(req, 'read'), {
    year: req.query.year as string | undefined, status: list(req.query.status) as never, package: req.query.package as string | undefined,
    q: req.query.q as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined })));
  r.get('/rows/:year/:code', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.get(await at(req, 'read'), String(req.params.year), String(req.params.code))));
  r.get('/packages/:year', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.packages(await at(req, 'read'), String(req.params.year))));
  r.get('/brief', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.brief(await at(req, 'read'), req.query.year as string | undefined)));
  r.get('/summary', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.summary(await at(req, 'read'), req.query.year as string | undefined)));
  r.get('/export', need('wbs.read'), (req: Authed, res) => send(res, async () => ledger.exportCsv(await at(req, 'read'), req.query.order === 'oldest' ? 'oldest' : 'newest')));
  r.post('/rows', need('wbs.write'), (req: Authed, res) => send(res, async () => ledger.add(req.actor!, req.body, (await at(req, 'write')).owner)));
  r.patch('/rows/:year/:code', need('wbs.write'), (req: Authed, res) => send(res, async () => ledger.update(req.actor!, { ...req.body, year: String(req.params.year), code: String(req.params.code) }, (await at(req, 'write')).owner)));
  r.post('/inbox', need('wbs.write'), (req: Authed, res) => send(res, () => inbox.add(req.actor!.uid, req.body)));
  r.get('/inbox', need('wbs.read'), (req: Authed, res) => send(res, () => inbox.list(req.actor!.uid, { status: req.query.status || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined })));
  r.post('/inbox/mark', need('wbs.write'), (req: Authed, res) => send(res, () => inbox.mark(req.actor!.uid, req.body)));
  if (plans) {   // the team plan against the actual work, and sharing one's own rows with it (execution WBS 3.4)
    const who = (req: Authed) => agent(req.actor!.uid, req.actor!.clientName, req.scopes || []);
    const sp = (req: Authed) => String(req.query.space || ''), yr = (req: Authed) => typeof req.query.year === 'string' ? req.query.year : undefined;
    r.get('/plan', need('wbs.read'), (req: Authed, res) => send(res, () => req.query.view === 'items' ? plans.list(who(req), sp(req), yr(req)) : plans.actual(who(req), sp(req), yr(req))));
    r.post('/plan', need('wbs.write'), (req: Authed, res) => send(res, () => plans.put(who(req), sp(req), req.body)));
    r.get('/share', need('wbs.read'), (req: Authed, res) => send(res, () => plans.mine(who(req))));
    r.post('/share', need('wbs.write'), (req: Authed, res) => send(res, () => plans.share(who(req), req.body)));
    r.delete('/share/:year/:code', need('wbs.write'), (req: Authed, res) => send(res, () => plans.unshare(who(req), { year: String(req.params.year), code: String(req.params.code) })));
  }
  return r;
}

/** OpenAPI 3.1 for GPT Actions and other function-calling agents (OAuth: authorization code with PKCE). */
export function openapi(cfg: Config, version: string) {
  const u = cfg.publicUrl, row = { type: 'object', additionalProperties: true };
  const space = { name: 'space', in: 'query', required: false, schema: { type: 'string' }, description: '"personal" (default) or a team space id from /spaces' };
  return {
    openapi: '3.1.0',
    info: { title: 'PP WBS Hub', version, description: 'One work ledger per account, shared by every agent. Search before adding; one concrete result per row.' },
    servers: [{ url: `${u}/v1` }],
    components: { securitySchemes: { oauth: { type: 'oauth2', flows: { authorizationCode: {
      authorizationUrl: `${u}/oauth/authorize`, tokenUrl: `${u}/oauth/token`, refreshUrl: `${u}/oauth/token`,
      scopes: { 'wbs.read': 'Read your work ledger', 'wbs.write': 'Record work in your ledger' } } } } } },
    security: [{ oauth: ['wbs.read', 'wbs.write'] }],
    paths: {
      '/rows': {
        get: { operationId: 'searchRows', summary: 'Search the ledger', parameters: [...['year', 'status', 'package', 'q', 'limit'].map(n => ({ name: n, in: 'query', required: false, schema: { type: n === 'limit' ? 'integer' : 'string' } })), space], responses: { 200: { description: 'Matching rows', content: { 'application/json': { schema: row } } } } },
        post: { operationId: 'addRow', summary: 'Record new work (the hub assigns the code)', parameters: [space], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['package', 'task', 'start', 'status'], properties: {
          package: { type: 'string' }, area: { type: 'string' }, parent: { type: 'string' }, task: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
          status: { type: 'string', enum: ['완료', '진행 중', '대기·심사', '백로그'] }, year: { type: 'string' }, key_result: { type: 'boolean' }, due: { type: 'string' },
          importance: { type: 'string', enum: ['상', '중', '하'] }, size: { type: 'string', enum: ['S', 'M', 'L', 'XL'] }, depends_on: { type: 'string' }, blocker: { type: 'string' },
          goal: { type: 'string' }, evidence: { type: 'string' }, allow_duplicate: { type: 'boolean' } } } } } }, responses: { 200: { description: 'Created' }, 409: { description: 'Near-duplicate; returns the existing rows' } } },
      },
      '/rows/{year}/{code}': {
        get: { operationId: 'getRow', summary: 'One row with steps and history', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, { name: 'code', in: 'path', required: true, schema: { type: 'string' } }, space], responses: { 200: { description: 'Row' } } },
        patch: { operationId: 'updateRow', summary: 'Change status, dates, blocker', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, { name: 'code', in: 'path', required: true, schema: { type: 'string' } }, space],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['완료', '진행 중', '대기·심사', '백로그'] }, end: { type: 'string' }, due: { type: 'string' }, importance: { type: 'string' }, blocker: { type: 'string' }, memo: { type: 'string' }, evidence: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
      },
      '/packages/{year}': { get: { operationId: 'listPackages', summary: 'Packages of a year and the next free codes', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, space], responses: { 200: { description: 'Packages' } } } },
      '/charter': { get: { operationId: 'getCharter', summary: 'A team space\'s charter: the version in force, an open proposal and who has answered, every version so far', parameters: [{ ...space, required: true, description: 'A team space id from /spaces' }], responses: { 200: { description: 'Charter' } } } },
      '/plan': {
        get: { operationId: 'planVsActual', summary: 'A team plan against the work members linked to it (view=items: the plan items with their change log)', parameters: [{ ...space, required: true, description: 'A team space id from /spaces' },
          { name: 'view', in: 'query', required: false, schema: { type: 'string', enum: ['actual', 'items'] } }, { name: 'year', in: 'query', required: false, schema: { type: 'string' } }], responses: { 200: { description: 'Plan vs actual' } } },
        post: { operationId: 'putPlan', summary: 'Add or change team plan items (owners and members; permanent codes, parents first, only given fields change)', parameters: [{ ...space, required: true, description: 'A team space id from /spaces' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { memo: { type: 'string' }, items: { type: 'array', maxItems: 200, items: { type: 'object', required: ['code'], properties: {
            code: { type: 'string' }, year: { type: 'string' }, scope: { type: 'string' }, deliverable: { type: 'string' }, done: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } }, owners: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['완료', '진행 중', '대기·심사', '백로그'] }, start: { type: 'string' }, due: { type: 'string' } } } } } } } } }, responses: { 200: { description: 'Created and changed codes' } } },
      },
      '/share': {
        get: { operationId: 'listShared', summary: 'Your rows linked to team plan items, the fields each shares, and whether the team still receives them', responses: { 200: { description: 'Links' } } },
        post: { operationId: 'shareRow', summary: 'Link a row of your own ledger to a team plan item and choose the fields the team sees (status always)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['year', 'code', 'space', 'plan'], properties: {
          year: { type: 'string' }, code: { type: 'string' }, space: { type: 'string' }, plan: { type: 'string' }, plan_year: { type: 'string' },
          share: { type: 'array', items: { type: 'string', enum: ['status', 'start', 'end', 'last_progress', 'due', 'size', 'blocker', 'task', 'key_result'] } } } } } } }, responses: { 200: { description: 'What the team now sees' } } },
      },
      '/share/{year}/{code}': { delete: { operationId: 'unshareRow', summary: 'Withdraw a row of yours from the team plan it serves', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, { name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Unlinked' } } } },
      '/spaces': { get: { operationId: 'listSpaces', summary: 'The personal space and the team spaces the user belongs to, with the user\'s role; pass a team id as `space` to other calls', responses: { 200: { description: 'Spaces' } } } },
      '/brief': { get: { operationId: 'brief', summary: 'Compact picture for planning and advice: status, flow, focus, open and due work, waiting items, work style, signals', parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'string' } }, space], responses: { 200: { description: 'Brief' } } } },
      '/summary': { get: { operationId: 'summary', summary: 'Counts, open tasks, latest changes', parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'string' } }, space], responses: { 200: { description: 'Summary' } } } },
      '/inbox': {
        post: { operationId: 'addToInbox', summary: 'Drop raw material (a chat, a search, a note) to be turned into rows later', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 100, items: { type: 'object', required: ['kind', 'source', 'at'], properties: {
          kind: { type: 'string', enum: ['chat', 'search', 'note', 'file', 'event', 'record'] }, source: { type: 'string' }, at: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', maxLength: 20000 }, url: { type: 'string' } } } } } } } } }, responses: { 200: { description: 'Stored; existing items unchanged' } } },
        get: { operationId: 'listInbox', summary: 'Items waiting to be turned into rows', parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['new', 'merged', 'skipped'] } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }], responses: { 200: { description: 'Items' } } },
      },
      '/inbox/mark': { post: { operationId: 'markInbox', summary: 'Mark items merged (with the codes they became) or skipped', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ids', 'status'], properties: { ids: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['merged', 'skipped'] }, ref: { type: 'string' } } } } } }, responses: { 200: { description: 'Marked' } } } },
    },
  };
}
