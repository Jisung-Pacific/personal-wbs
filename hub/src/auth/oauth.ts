// OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Gemini, Grok, CLIs) and REST callers (GPT Actions).
// Follows the MCP authorization spec: protected-resource metadata (RFC 9728), server metadata (RFC 8414), PKCE S256 only,
// resource indicators (RFC 8707), dynamic client registration (RFC 7591) and client ID metadata documents (the way Claude's
// "published identity" registers, preferred). Users sign in with the product's Firebase Auth accounts on the consent page.
import express, { Router, type Request, type Response } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SCOPES, DEFAULT_SCOPE, type Config } from '../config.js';
import type { OAuthClient, Store } from '../store/types.js';
import { random, sha256, pkceOk, type TokenIssuer } from './tokens.js';
import type { VerifyIdToken } from './identity.js';
import { consentPage, errorPage } from './pages.js';
import { cleanLocale, cleanTimezone, type JoinHost } from './host.js';

export interface OAuthDeps { cfg: Config; store: Store; issuer: TokenIssuer; verifyIdToken: VerifyIdToken; fetchImpl?: typeof fetch; joinHost?: JoinHost }

const REQUEST_TTL = 10 * 60e3, CODE_TTL = 5 * 60e3;

/** The resources a token may be minted for: the MCP endpoint, the REST API, or the hub as a whole. */
export const resourcesOf = (cfg: Config) => [`${cfg.publicUrl}/mcp`, `${cfg.publicUrl}/v1`, cfg.publicUrl];

export function serverMetadata(cfg: Config) {
  const u = cfg.publicUrl;
  return {
    issuer: u,
    authorization_endpoint: `${u}/oauth/authorize`,
    token_endpoint: `${u}/oauth/token`,
    registration_endpoint: `${u}/oauth/register`,
    revocation_endpoint: `${u}/oauth/revoke`,
    jwks_uri: `${u}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: Object.keys(SCOPES),
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
export const resourceMetadata = (cfg: Config, resource: string) => ({
  resource, authorization_servers: [cfg.publicUrl], scopes_supported: Object.keys(SCOPES),
  bearer_methods_supported: ['header'], resource_name: 'PP WBS Hub', resource_documentation: `${cfg.publicUrl}/`,
});

// ---------------------------------------------------------------- redirect URIs
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** https anywhere; http only on loopback (native and CLI apps, RFC 8252); private-use schemes like com.example.app:/cb. */
export function redirectAllowed(uri: string): boolean {
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return /^[a-z][a-z0-9+-]*\.[a-z0-9+.-]+:$/.test(u.protocol);   // reverse-domain private-use scheme
}
/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
  return registered.some(r => { try { const v = new URL(r); return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search; } catch { return false; } });
}

// ---------------------------------------------------------------- client ID metadata documents
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

const cimdCache = new Map<string, { client: OAuthClient; until: number }>();
/** Fetches and checks a client's metadata document. Guards the fetch: public addresses only, no redirects, 64 KB, 5 s. */
async function cimdClient(url: string, deps: OAuthDeps): Promise<OAuthClient> {
  const hit = cimdCache.get(url); if (hit && hit.until > Date.now()) return hit.client;
  const u = new URL(url);
  const local = deps.cfg.devLogin && u.protocol === 'http:' && LOOPBACK.has(u.hostname);   // tests and local runs
  if (!local) {
    if (u.protocol !== 'https:' || u.pathname === '/' || u.hash || u.username) throw new Error('client_id must be an https URL with a path');
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateAddress(a.address))) throw new Error('client_id host resolves to a private address');
  }
  const res = await (deps.fetchImpl || fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`client metadata ${res.status}`);
  const text = await res.text(); if (text.length > 64 * 1024) throw new Error('client metadata too large');
  const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string };
  if (doc.client_id !== url) throw new Error('client metadata client_id does not match its URL');
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every(redirectAllowed)) throw new Error('client metadata redirect_uris invalid');
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') throw new Error('only public clients (token_endpoint_auth_method none) are supported');
  const client: OAuthClient = { client_id: url, client_name: String(doc.client_name || u.hostname).slice(0, 100), redirect_uris: doc.redirect_uris, kind: 'cimd', created_at: Date.now() };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  cimdCache.set(url, { client, until: Date.now() + Math.min(maxAge, 86400) * 1000 });
  return client;
}

async function resolveClient(id: string, deps: OAuthDeps): Promise<OAuthClient | null> {
  if (/^https?:\/\//.test(id)) return cimdClient(id, deps);
  return deps.store.client(id);
}

// ---------------------------------------------------------------- small helpers
const hits = new Map<string, { n: number; reset: number }>();
/** Fixed-window limiter per client address; enough to blunt registration and token spraying. */
function limited(req: Request, bucket: string, max: number): boolean {
  const k = `${bucket}|${req.ip}`, now = Date.now(), h = hits.get(k);
  if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + 60e3 }); return false; }
  return ++h.n > max;
}
const oauthError = (res: Response, status: number, error: string, description?: string) =>
  res.status(status).set('Cache-Control', 'no-store').json({ error, ...(description ? { error_description: description } : {}) });
function redirectWith(res: Response, uri: string, params: Record<string, string>) {
  const u = new URL(uri); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}
/** Requested scopes, known ones only; empty request → the default set. */
function scopesOf(raw: string | undefined): string | null {
  const asked = (raw || DEFAULT_SCOPE).split(/\s+/).filter(Boolean);
  return asked.every(s => s in SCOPES) ? [...new Set(asked)].join(' ') : null;
}

// ---------------------------------------------------------------- router
export function oauthRouter(deps: OAuthDeps): Router {
  const { cfg, store, issuer } = deps, r = Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' }), json = express.json({ limit: '32kb' });

  // RFC 7591 dynamic client registration (public clients only: PKCE is the proof, there is no secret)
  r.post('/register', json, async (req, res) => {
    if (limited(req, 'register', 20)) return oauthError(res, 429, 'slow_down');
    const b = req.body || {}, uris: unknown = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(u => typeof u === 'string' && redirectAllowed(u))) return oauthError(res, 400, 'invalid_redirect_uri', 'https, loopback http or a private-use scheme');
    const method = String(b.token_endpoint_auth_method || 'none');
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return oauthError(res, 400, 'invalid_client_metadata', 'token_endpoint_auth_method: none, client_secret_post or client_secret_basic');
    const secret = method === 'none' ? '' : 's_' + random(32);   // shown once, stored only as a hash
    const client: OAuthClient = { client_id: 'c_' + random(18), client_name: String(b.client_name || 'MCP client').slice(0, 100), redirect_uris: uris as string[], kind: 'dcr', created_at: Date.now(), ...(secret ? { secret_hash: sha256(secret) } : {}) };
    await store.putClient(client);
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: client.client_id, client_id_issued_at: Math.floor(client.created_at / 1000), client_name: client.client_name, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      redirect_uris: client.redirect_uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  });

  // authorization endpoint: validate everything, park the request server-side, show sign-in + consent
  r.get('/authorize', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    let client: OAuthClient | null = null;
    try { client = q.client_id ? await resolveClient(q.client_id, deps) : null; } catch (e) { return res.status(400).type('html').send(errorPage('클라이언트를 확인하지 못했습니다', String((e as Error).message))); }
    if (!client) return res.status(400).type('html').send(errorPage('알 수 없는 클라이언트', 'client_id가 등록되어 있지 않습니다.'));
    if (!q.redirect_uri || !redirectMatches(client.redirect_uris, q.redirect_uri)) return res.status(400).type('html').send(errorPage('허용되지 않은 돌아갈 주소', 'redirect_uri가 클라이언트 등록과 다릅니다.'));
    // from here on, errors go back to the client
    const back = (error: string, description: string) => redirectWith(res, q.redirect_uri!, { error, error_description: description, state: q.state || '', iss: cfg.publicUrl });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (q.code_challenge ? q.code_challenge_method !== 'S256' : !client.secret_hash) return back('invalid_request', 'PKCE with S256 is required');
    const scope = scopesOf(q.scope); if (!scope) return back('invalid_scope', 'unknown scope');
    const resource = q.resource || `${cfg.publicUrl}/mcp`;
    if (!resourcesOf(cfg).includes(resource.replace(/\/$/, ''))) return back('invalid_target', 'unknown resource');
    const pending = { id: random(24), client_id: client.client_id, client_name: client.client_name, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge || '',
      scope, resource: resource.replace(/\/$/, ''), state: q.state || '', expires_at: Date.now() + REQUEST_TTL };
    await store.putRequest(pending);
    const nonce = random(16);
    res.set('Content-Security-Policy', consentCsp(cfg, nonce, pending.redirect_uri)).set('X-Frame-Options', 'DENY').set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
      .type('html').send(consentPage({ cfg, pending, nonce }));
  });

  // the consent form posts here with the Firebase ID token of whoever signed in
  r.post('/approve', form, async (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    const pending = b.req ? await store.takeRequest(b.req) : null;   // single use: a replayed form gets nothing
    if (!pending) return res.status(400).type('html').send(errorPage('요청이 만료되었습니다', '처음부터 다시 연결해 주세요.'));
    const back = (p: Record<string, string>) => redirectWith(res, pending.redirect_uri, { ...p, state: pending.state, iss: cfg.publicUrl });
    if (b.decision !== 'allow') return back({ error: 'access_denied', error_description: 'the user declined' });
    let uid: string;
    try { uid = (await deps.verifyIdToken(String(b.id_token || ''))).uid; } catch { return back({ error: 'access_denied', error_description: 'sign-in could not be verified' }); }
    if (cfg.host.sessionUrl && deps.joinHost) {   // the connection also makes the person a member of the host product
      if (b.host_ok !== '1') return back({ error: 'access_denied', error_description: 'the host terms were not accepted' });
      const joined = await deps.joinHost(uid, String(b.id_token), { timezone: cleanTimezone(b.tz), locale: cleanLocale(b.lang) });
      if (joined === 'failed' && cfg.host.required) return back({ error: 'temporarily_unavailable', error_description: 'joining the host product failed; try again' });
    }
    const code = random(32);
    await store.putCode({ hash: sha256(code), client_id: pending.client_id, client_name: pending.client_name, redirect_uri: pending.redirect_uri, code_challenge: pending.code_challenge,
      scope: pending.scope, resource: pending.resource, uid, expires_at: Date.now() + CODE_TTL });
    back({ code });
  });

  // token endpoint: code + PKCE → tokens; refresh with rotation and reuse detection
  r.post('/token', form, json, async (req, res) => {
    if (limited(req, 'token', 60)) return oauthError(res, 429, 'slow_down');
    const b = { ...(req.body || {}) } as Record<string, string | undefined>;
    const basic = /^Basic (.+)$/i.exec(req.get('authorization') || '');
    if (basic) { const [id, sec] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent); b.client_id = id; b.client_secret = sec; }
    const client = b.client_id && !/^https?:\/\//.test(b.client_id) ? await store.client(b.client_id) : null;
    if (client?.secret_hash && (!b.client_secret || sha256(b.client_secret) !== client.secret_hash)) return oauthError(res, 401, 'invalid_client', 'client authentication failed');
    if (b.grant_type === 'authorization_code') {
      const c = b.code ? await store.takeCode(sha256(b.code)) : null;
      if (!c) return oauthError(res, 400, 'invalid_grant', 'code is invalid, used or expired');
      if (c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'client or redirect_uri mismatch');
      if (c.code_challenge ? !b.code_verifier || !pkceOk(b.code_verifier, c.code_challenge) : !client?.secret_hash) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      if (b.resource && b.resource.replace(/\/$/, '') !== c.resource) return oauthError(res, 400, 'invalid_target', 'resource differs from the authorization');
      return res.set('Cache-Control', 'no-store').json(await issue(c.uid, c.client_id, c.client_name, c.scope, c.resource, random(12)));
    }
    if (b.grant_type === 'refresh_token') {
      const rec = b.refresh_token ? await store.useRefresh(sha256(b.refresh_token)) : null;
      if (!rec || rec.expires_at < Date.now()) return oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or expired');
      if (rec.used) { await store.revokeFamily(rec.family); return oauthError(res, 400, 'invalid_grant', 'refresh token reuse; the grant is revoked'); }
      if (rec.client_id !== b.client_id) return oauthError(res, 400, 'invalid_grant', 'client mismatch');
      const scope = b.scope ? b.scope.split(' ').filter(s => rec.scope.split(' ').includes(s)).join(' ') : rec.scope;   // may narrow, never widen
      const resource = b.resource ? b.resource.replace(/\/$/, '') : rec.resource;
      if (!resourcesOf(cfg).includes(resource)) return oauthError(res, 400, 'invalid_target');
      return res.set('Cache-Control', 'no-store').json(await issue(rec.uid, rec.client_id, rec.client_name, scope || rec.scope, resource, rec.family));
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  });

  // RFC 7009: revoking a refresh token ends the whole grant; access tokens simply expire
  r.post('/revoke', form, json, async (req, res) => {
    const t = String((req.body || {}).token || '');
    if (t) { const rec = await store.useRefresh(sha256(t)); if (rec) await store.revokeFamily(rec.family); }
    res.status(200).end();
  });

  async function issue(uid: string, clientId: string, clientName: string, scope: string, resource: string, family: string) {
    const { token, expiresIn } = await issuer.access(uid, clientId, clientName, scope, resource);
    const refresh = random(32);
    await store.putRefresh({ hash: sha256(refresh), family, client_id: clientId, client_name: clientName, uid, scope, resource, expires_at: Date.now() + cfg.refreshTtl * 1000, used: false });
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope };
  }
  return r;
}

/** The consent page may load Firebase Auth and talk to Google's identity endpoints, nothing else. Its form may lead only
 *  to the hub and, through the hub's redirect, to the client's registered redirect (browsers check form-action on redirects). */
function consentCsp(cfg: Config, nonce: string, redirectUri: string): string {
  const authDomain = cfg.firebaseWeb ? `https://${cfg.firebaseWeb.authDomain}` : '';
  const u = new URL(redirectUri), target = /^https?:$/.test(u.protocol) ? u.origin : u.protocol;
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com`, `style-src 'nonce-${nonce}'`,
    "img-src data: https://www.gstatic.com https://lh3.googleusercontent.com",
    'connect-src https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com',
    `frame-src ${authDomain} https://accounts.google.com`.trim(), `form-action 'self' ${target}`, "frame-ancestors 'none'", "base-uri 'none'",
  ].join('; ');
}
