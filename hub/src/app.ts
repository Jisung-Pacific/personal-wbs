// Wiring: discovery documents, the OAuth server, the MCP endpoint and the REST API, all behind one bearer check.
import express, { type NextFunction, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Store } from './store/types.js';
import type { TokenIssuer } from './auth/tokens.js';
import type { VerifyIdToken } from './auth/identity.js';
import type { JoinHost } from './auth/host.js';
import { oauthRouter, resourceMetadata, serverMetadata } from './auth/oauth.js';
import { buildMcp } from './mcp.js';
import { openapi, restRouter, type Authed } from './rest.js';
import { Ledger } from './wbs/service.js';
import { Inbox } from './wbs/inbox.js';

export const VERSION = '0.1.0';

export function createApp(cfg: Config, store: Store, issuer: TokenIssuer, verifyIdToken: VerifyIdToken, joinHost?: JoinHost) {
  const app = express(), ledger = new Ledger(store), inbox = new Inbox(store), u = cfg.publicUrl;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);   // Cloud Run's front end sets X-Forwarded-For; the rate limiter keys on the caller
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'no-referrer'); next(); });

  // discovery: protected-resource metadata per resource path (RFC 9728) and the authorization server (RFC 8414)
  const prm = (resource: string) => (_req: unknown, res: Response) => { res.json(resourceMetadata(cfg, resource)); };
  app.get('/.well-known/oauth-protected-resource', prm(u));
  app.get('/.well-known/oauth-protected-resource/mcp', prm(`${u}/mcp`));
  app.get('/.well-known/oauth-protected-resource/v1', prm(`${u}/v1`));
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (_req, res) => { res.json(serverMetadata(cfg)); });
  app.get('/.well-known/jwks.json', (_req, res) => { res.set('Cache-Control', 'public, max-age=300').json(issuer.jwks()); });
  app.use('/oauth', oauthRouter({ cfg, store, issuer, verifyIdToken, joinHost }));

  /** Bearer check for one resource: a valid hub token minted for it (or for the hub as a whole). */
  const bearer = (path: 'mcp' | 'v1') => async (req: Authed, res: Response, next: NextFunction) => {
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

  // MCP over Streamable HTTP, stateless: one server and transport per request, JSON responses
  app.post('/mcp', bearer('mcp'), express.json({ limit: '1mb' }), async (req: Authed, res) => {
    const server = buildMcp(ledger, req.actor!, req.scopes!, VERSION, inbox);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as never, res, req.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp', bearer('mcp'), (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }); });

  app.use('/v1', bearer('v1'), restRouter(ledger, inbox));
  app.get('/openapi.json', (_req, res) => { res.json(openapi(cfg, VERSION)); });
  app.get('/healthz', (_req, res) => { res.json({ ok: true, version: VERSION }); });
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PP WBS Hub</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px"><h1>PP WBS Hub</h1>
<p>한 계정에 하나의 작업 원장. 어떤 에이전트에서든 같은 원장에 기록하고 읽습니다.</p>
<ul><li>MCP 서버: <code>${u}/mcp</code> (Claude·ChatGPT·Gemini 등에 커스텀 커넥터로 추가)</li><li>REST·OpenAPI: <code>${u}/openapi.json</code></li></ul></body></html>`);
  });
  return app;
}
