// The REST face: the same operations for agents that call HTTP functions rather than MCP (custom GPT Actions,
// DeepSeek or Kimi function calling, scripts). Same OAuth tokens, same rules; /openapi.json describes it.
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Ledger, LedgerError, type Actor } from './wbs/service.js';
import type { Inbox } from './wbs/inbox.js';
import type { Config } from './config.js';

export type Authed = Request & { actor?: Actor; scopes?: string[] };

function send(res: Response, f: () => Promise<unknown>) {
  f().then(v => res.json(v)).catch(e => {
    if (e instanceof LedgerError) return res.status(e.code === 'not_found' ? 404 : e.code === 'duplicate' ? 409 : 400).json({ error: e.code, message: e.message, detail: e.detail });
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid', issues: e.issues });
    console.error(e); res.status(500).json({ error: 'server_error' });
  });
}
const need = (scope: string) => (req: Authed, res: Response, next: () => void) =>
  req.scopes?.includes(scope) ? next() : res.status(403).set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`).json({ error: 'insufficient_scope', scope });

export function restRouter(ledger: Ledger, inbox: Inbox): Router {
  const r = Router(); r.use(express.json({ limit: '256kb' }));
  const list = (v: unknown) => typeof v === 'string' && v ? v.split(',') : undefined;
  r.get('/rows', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.search(req.actor!.uid, {
    year: req.query.year as string | undefined, status: list(req.query.status) as never, package: req.query.package as string | undefined,
    q: req.query.q as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined })));
  r.get('/rows/:year/:code', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.get(req.actor!.uid, String(req.params.year), String(req.params.code))));
  r.get('/packages/:year', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.packages(req.actor!.uid, String(req.params.year))));
  r.get('/brief', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.brief(req.actor!.uid, req.query.year as string | undefined)));
  r.get('/summary', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.summary(req.actor!.uid, req.query.year as string | undefined)));
  r.get('/export', need('wbs.read'), (req: Authed, res) => send(res, () => ledger.exportCsv(req.actor!.uid)));
  r.post('/rows', need('wbs.write'), (req: Authed, res) => send(res, () => ledger.add(req.actor!, req.body)));
  r.patch('/rows/:year/:code', need('wbs.write'), (req: Authed, res) => send(res, () => ledger.update(req.actor!, { ...req.body, year: String(req.params.year), code: String(req.params.code) })));
  r.post('/inbox', need('wbs.write'), (req: Authed, res) => send(res, () => inbox.add(req.actor!.uid, req.body)));
  r.get('/inbox', need('wbs.read'), (req: Authed, res) => send(res, () => inbox.list(req.actor!.uid, { status: req.query.status || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined })));
  r.post('/inbox/mark', need('wbs.write'), (req: Authed, res) => send(res, () => inbox.mark(req.actor!.uid, req.body)));
  return r;
}

/** OpenAPI 3.1 for GPT Actions and other function-calling agents (OAuth: authorization code with PKCE). */
export function openapi(cfg: Config, version: string) {
  const u = cfg.publicUrl, row = { type: 'object', additionalProperties: true };
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
        get: { operationId: 'searchRows', summary: 'Search the ledger', parameters: ['year', 'status', 'package', 'q', 'limit'].map(n => ({ name: n, in: 'query', required: false, schema: { type: n === 'limit' ? 'integer' : 'string' } })), responses: { 200: { description: 'Matching rows', content: { 'application/json': { schema: row } } } } },
        post: { operationId: 'addRow', summary: 'Record new work (the hub assigns the code)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['package', 'task', 'start', 'status'], properties: {
          package: { type: 'string' }, area: { type: 'string' }, parent: { type: 'string' }, task: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
          status: { type: 'string', enum: ['완료', '진행 중', '대기·심사', '백로그'] }, year: { type: 'string' }, key_result: { type: 'boolean' }, due: { type: 'string' },
          importance: { type: 'string', enum: ['상', '중', '하'] }, size: { type: 'string', enum: ['S', 'M', 'L', 'XL'] }, depends_on: { type: 'string' }, blocker: { type: 'string' },
          goal: { type: 'string' }, evidence: { type: 'string' }, allow_duplicate: { type: 'boolean' } } } } } }, responses: { 200: { description: 'Created' }, 409: { description: 'Near-duplicate; returns the existing rows' } } },
      },
      '/rows/{year}/{code}': {
        get: { operationId: 'getRow', summary: 'One row with steps and history', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, { name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Row' } } },
        patch: { operationId: 'updateRow', summary: 'Change status, dates, blocker', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }, { name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['완료', '진행 중', '대기·심사', '백로그'] }, end: { type: 'string' }, due: { type: 'string' }, importance: { type: 'string' }, blocker: { type: 'string' }, memo: { type: 'string' }, evidence: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
      },
      '/packages/{year}': { get: { operationId: 'listPackages', summary: 'Packages of a year and the next free codes', parameters: [{ name: 'year', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Packages' } } } },
      '/brief': { get: { operationId: 'brief', summary: 'Compact picture for planning and advice: status, flow, focus, open and due work, waiting items, work style, signals', parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'string' } }], responses: { 200: { description: 'Brief' } } } },
      '/summary': { get: { operationId: 'summary', summary: 'Counts, open tasks, latest changes', parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'string' } }], responses: { 200: { description: 'Summary' } } } },
      '/inbox': {
        post: { operationId: 'addToInbox', summary: 'Drop raw material (a chat, a search, a note) to be turned into rows later', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 100, items: { type: 'object', required: ['kind', 'source', 'at'], properties: {
          kind: { type: 'string', enum: ['chat', 'search', 'note', 'file', 'event', 'record'] }, source: { type: 'string' }, at: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', maxLength: 20000 }, url: { type: 'string' } } } } } } } } }, responses: { 200: { description: 'Stored; existing items unchanged' } } },
        get: { operationId: 'listInbox', summary: 'Items waiting to be turned into rows', parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['new', 'merged', 'skipped'] } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }], responses: { 200: { description: 'Items' } } },
      },
      '/inbox/mark': { post: { operationId: 'markInbox', summary: 'Mark items merged (with the codes they became) or skipped', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ids', 'status'], properties: { ids: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['merged', 'skipped'] }, ref: { type: 'string' } } } } } }, responses: { 200: { description: 'Marked' } } } },
    },
  };
}
