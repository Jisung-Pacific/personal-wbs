// Test support. People join a team only by accepting an invitation (execution WBS 5.3), so the tests staff a space the
// way people do: the owner invites the account, the person reads the invitation and accepts it — a member agreeing to
// the charter in force when there is one. And the end-to-end helpers: the real app on a free port over the memory store,
// and an agent's connection to it as a client and a person would make one (registration, consent, PKCE, tokens).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';
import { person, type Caller } from '../src/wbs/access.js';
import type { Spaces } from '../src/wbs/spaces.js';

/** The owner invites `uid` as a member or a guest (with its projects) and the person joins. */
export async function admit(spaces: Spaces, owner: Caller, id: string, uid: string, role: 'member' | 'guest', projects?: string[]) {
  const inv = await spaces.invite(owner, id, { role, projects, for: uid }), ref = { space: id, invite: inv.id };
  const seen = await spaces.preview(person(uid), ref);
  return spaces.join(person(uid), ref, seen.charter?.version);
}

export async function boot() {
  const store = new MemoryStore();
  const srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1' } as NodeJS.ProcessEnv);
  const issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier()));
  return { base, store, close: () => new Promise<void>(r => srv.close(() => r())) };
}
export const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Registration → consent → code → tokens, as a client and a person would do it. */
export async function connect(base: string, opts: { uid: string; scope?: string; resource?: string; clientName?: string; clientId?: string; redirect?: string }) {
  const redirect = opts.redirect || 'http://localhost:9999/cb';
  let clientId = opts.clientId;
  if (!clientId) {
    const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: opts.clientName || 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
    assert.equal(reg.status, 201); clientId = (await reg.json()).client_id as string;
  }
  const { v, c } = pkce(), resource = opts.resource || `${base}/mcp`;
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: c, code_challenge_method: 'S256', scope: opts.scope || 'wbs.read wbs.write', state: 'st8', resource });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const req = /name="req" value="([^"]+)"/.exec(await page.text())![1];
  const ok = await fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, id_token: `dev:${opts.uid}`, decision: 'allow' }) });
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location')!);
  assert.equal(back.searchParams.get('state'), 'st8'); assert.equal(back.searchParams.get('iss'), base);
  const code = back.searchParams.get('code')!;
  const tok = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: v, resource }) });
  assert.equal(tok.status, 200, await tok.clone().text());
  return { clientId, code, verifier: v, redirect, ...(await tok.json()) as { access_token: string; refresh_token: string; scope: string } };
}
export async function mcp(base: string, token: string, path = '/mcp') {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
export const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);
