// Wiring: discovery documents, the OAuth server, the MCP endpoint and the REST API, all behind one bearer check.
import express, { type NextFunction, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Store } from './store/types.js';
import type { TokenIssuer } from './auth/tokens.js';
import type { VerifyIdToken } from './auth/identity.js';
import type { JoinHost } from './auth/host.js';
import { oauthRouter, resourceMetadata, serverMetadata, teamOf } from './auth/oauth.js';
import { peopleRouter } from './people.js';
import { Cards } from './wbs/cards.js';
import { Plans } from './wbs/plan.js';
import { Views } from './wbs/views.js';
import { buildMcp } from './mcp.js';
import { openapi, restRouter, type Authed } from './rest.js';
import { Ledger } from './wbs/service.js';
import { Inbox } from './wbs/inbox.js';
import { Spaces } from './wbs/spaces.js';
import { landingPage, pickLang, privacyPage } from './site.js';
import { clientAddress } from './net.js';
import { Briefs } from './wbs/weekly.js';
import { googleScheduler, type VerifyScheduler } from './auth/scheduler.js';

export const VERSION = '0.1.0';

/** `verifyScheduler`: tests stand in for Google's token check; in production it follows HUB_SCHEDULER_SA. */
export function createApp(cfg: Config, store: Store, issuer: TokenIssuer, verifyIdToken: VerifyIdToken, joinHost?: JoinHost, verifyScheduler?: VerifyScheduler) {
  const app = express(), spaces = new Spaces(store), views = new Views(store), plans = new Plans(store, spaces, views), inbox = new Inbox(store), u = cfg.publicUrl;
  const cards = new Cards(store, spaces, views);   // after Plans: both hook into a person leaving a space
  const briefs = new Briefs(store, spaces);
  const ledger = new Ledger(store, (uid, keys) => plans.touched(uid, keys));   // shared copies follow the rows they come from
  app.disable('x-powered-by');
  app.set('trust proxy', 1);   // Cloud Run's front end sets X-Forwarded-For; the rate limiter keys on the caller
  app.use((req, _res, next) => { (req as typeof req & { client?: string }).client = clientAddress(req, cfg.proxySecret); next(); });
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'no-referrer'); next(); });

  // discovery: protected-resource metadata per resource path (RFC 9728) and the authorization server (RFC 8414)
  const prm = (resource: string) => (_req: unknown, res: Response) => { res.json(resourceMetadata(cfg, resource)); };
  app.get('/.well-known/oauth-protected-resource', prm(u));
  app.get('/.well-known/oauth-protected-resource/mcp', prm(`${u}/mcp`));
  app.get('/.well-known/oauth-protected-resource/v1', prm(`${u}/v1`));
  app.get('/.well-known/oauth-protected-resource/mcp/t/:space', (req, res) => {   // a team's own MCP address (3.8)
    const r = `${u}/mcp/t/${req.params.space}`;
    if (!teamOf(cfg, r)) return res.status(404).json({ error: 'not_found' });
    res.json(resourceMetadata(cfg, r));
  });
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (_req, res) => { res.json(serverMetadata(cfg)); });
  app.get('/.well-known/jwks.json', (_req, res) => { res.set('Cache-Control', 'public, max-age=300').json(issuer.jwks()); });
  app.use('/oauth', oauthRouter({ cfg, store, issuer, verifyIdToken, joinHost }));
  app.use('/app', peopleRouter({ cfg, store, issuer, verifyIdToken, spaces, cards }));   // people's own acts, by their own hand

  /** Bearer check for one resource: a valid hub token minted for it (or for the hub as a whole). `path`: mcp, v1, or a
   *  team's own MCP address (mcp/t/<space id>). */
  const bearer = (path: string) => async (req: Authed, res: Response, next: NextFunction) => {
    const challenge = (extra = '') => `Bearer resource_metadata="${u}/.well-known/oauth-protected-resource/${path}", scope="wbs.read wbs.write"${extra}`;
    const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    if (!m) return res.status(401).set('WWW-Authenticate', challenge()).json({ error: 'unauthorized' });
    try {
      const c = await issuer.verify(m[1], [`${u}/${path}`, u]);
      req.actor = { uid: c.uid, clientName: c.clientName || c.clientId };
      req.scopes = c.scopes;
      (req as Authed & { auth?: unknown }).auth = { token: m[1], clientId: c.clientId, scopes: c.scopes, expiresAt: c.exp, resource: new URL(c.resource) };
      next();
    } catch {
      res.status(401).set('WWW-Authenticate', challenge(', error="invalid_token"')).json({ error: 'invalid_token' });
    }
  };

  // MCP over Streamable HTTP, stateless: one server and transport per request, JSON responses. `env`: the team space a
  // team's own address names (3.8) — that connection works in the team's environment; the plain address is personal.
  const serveMcp = (env?: string) => async (req: Authed, res: Response) => {
    const server = buildMcp(ledger, spaces, req.actor!, req.scopes!, VERSION, inbox, plans, views, store, { env, hubUrl: u, briefs });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as never, res, req.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.post('/mcp', bearer('mcp'), express.json({ limit: '1mb' }), serveMcp());
  app.all('/mcp', bearer('mcp'), (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }); });
  const teamPath = (req: Authed & { params: Record<string, string> }, res: Response, next: NextFunction) =>
    teamOf(cfg, `${u}/mcp/t/${req.params.space}`) ? bearer(`mcp/t/${req.params.space}`)(req, res, next) : res.status(404).json({ error: 'not_found' });
  app.post('/mcp/t/:space', teamPath as never, express.json({ limit: '1mb' }), (req: Authed & { params: Record<string, string> }, res: Response) => serveMcp(req.params.space)(req, res));
  app.all('/mcp/t/:space', teamPath as never, (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }); });

  app.use('/v1', bearer('v1'), restRouter(ledger, spaces, inbox, plans, views, store, briefs));

  // the weekly run (4.3): Cloud Scheduler, Monday morning, signed in as its own service account (deploy/terraform/weekly.tf).
  // Unset → no such route, and last week's brief is generated by its first reader instead.
  if (cfg.schedulerSa) {
    const verify = verifyScheduler ?? googleScheduler(cfg.schedulerSa, `${u}/internal/weekly`);
    app.post('/internal/weekly', async (req, res) => {
      const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
      if (!m || !(await verify(m[1]))) return res.status(401).json({ error: 'unauthorized' });
      try { res.json(await briefs.runWeekly()); } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
    });
  }
  app.get('/openapi.json', (_req, res) => { res.json(openapi(cfg, VERSION)); });
  app.get('/healthz', (_req, res) => { res.json({ ok: true, version: VERSION }); });
  // public pages: how to connect each agent, the privacy notice, and directory domain verification
  app.get('/', (req, res) => { res.set('Cache-Control', 'public, max-age=300').type('html').send(landingPage(cfg, pickLang(req.get('accept-language')))); });
  app.get('/privacy', (req, res) => { res.set('Cache-Control', 'public, max-age=300').type('html').send(privacyPage(cfg, pickLang(req.get('accept-language')))); });
  app.get('/.well-known/openai-apps-challenge', (_req, res) => { if (!cfg.openaiChallenge) return res.status(404).end(); res.type('text/plain').send(cfg.openaiChallenge); });
  return app;
}
