// Sign-in choices follow the project's own providers; a private host API gets a Google ID token in
// X-Serverless-Authorization plus the acquisition channel; a reverse proxy may name the real caller only with the secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { loadConfig, parseProviders } from '../src/config.js';
import { consentPage } from '../src/auth/pages.js';
import { MemoryStore } from '../src/store/memory.js';
import { hostJoiner } from '../src/auth/host.js';
import { clientAddress } from '../src/net.js';
import type { AuthRequest } from '../src/store/types.js';

const web = JSON.stringify({ apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p' });
const pending = { id: 'r1', client_name: 'Claude', scope: 'wbs.read wbs.write', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' } as unknown as AuthRequest;

test('provider list parses ids and labels, and refuses unknown ones', () => {
  assert.deepEqual(parseProviders(undefined).map(p => p.id), ['google', 'password']);
  assert.deepEqual(parseProviders('google,oidc.kakao=카카오,oidc.naver,password'),
    [{ id: 'google', label: 'Google' }, { id: 'oidc.kakao', label: '카카오' }, { id: 'oidc.naver', label: 'naver' }, { id: 'password', label: '이메일' }]);
  assert.throws(() => parseProviders('facebook'), /unknown provider/);
  assert.throws(() => parseProviders(' , '), /names no provider/);
});

test('consent page shows one button per provider, email only when switched on, and no way out of the script', () => {
  const cfg = loadConfig({ HUB_FIREBASE_WEB: web, HUB_AUTH_PROVIDERS: 'google,oidc.kakao=Ka</script>kao' } as NodeJS.ProcessEnv);
  const page = consentPage({ cfg, pending, nonce: 'n' });
  assert.match(page, /data-p="google">Google 계정으로 계속/);
  assert.match(page, /data-p="oidc\.kakao">Ka&lt;\/script&gt;kao 계정으로 계속/);
  assert.doesNotMatch(page, /id="ef"/);
  const scripts = page.split('<script').length - 1, closes = page.split('</script>').length - 1;
  assert.equal(scripts, closes, 'every script element closes exactly once');
  const withMail = consentPage({ cfg: loadConfig({ HUB_FIREBASE_WEB: web, HUB_AUTH_PROVIDERS: 'password' } as NodeJS.ProcessEnv), pending, nonce: 'n' });
  assert.match(withMail, /<details open><summary>이메일로 로그인/);
});

test('a private host gets the service token, the channel and the strict body', async () => {
  const seen: { body: Record<string, unknown>; auth?: string; sauth?: string }[] = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    seen.push({ body: JSON.parse(b), auth: req.headers.authorization, sauth: req.headers['x-serverless-authorization'] as string });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"created":true}'); }); });
  await new Promise<void>(r => s.listen(0, r));
  const url = `http://localhost:${(s.address() as AddressInfo).port}/v1/internal/members/ensure`;
  const cfg = loadConfig({ HUB_HOST_SESSION_URL: url, HUB_HOST_AUTH: 'google-oidc', HUB_HOST_CHANNEL: 'ppwbs' } as NodeJS.ProcessEnv);
  assert.equal(cfg.host.audience, new URL(url).origin);
  const store = new MemoryStore();
  const r = await hostJoiner(cfg.host, store, undefined, fetch, async () => 'google-id-token')('u1', 'firebase-id-token', { timezone: 'Asia/Seoul', locale: 'ko' });
  s.close();
  assert.equal(r, 'joined');
  assert.deepEqual(seen[0].body, { identityToken: 'firebase-id-token', timezone: 'Asia/Seoul', locale: 'ko', channel: 'ppwbs' });
  assert.equal(seen[0].sauth, 'Bearer google-id-token');
  assert.equal(seen[0].auth, undefined, 'Authorization stays free for the host');
  assert.ok(await store.secret('u1', 'host_member'));
  assert.throws(() => loadConfig({ HUB_HOST_AUTH: 'basic' } as NodeJS.ProcessEnv), /none or google-oidc/);
  assert.throws(() => loadConfig({ HUB_HOST_CHANNEL: 'PP WBS' } as NodeJS.ProcessEnv), /HUB_HOST_CHANNEL/);
});

test('a reverse proxy names the caller only when it presents the shared secret', async () => {
  const secret = 'x'.repeat(40), app = express();
  app.set('trust proxy', 1);
  app.get('/', (req, res) => { res.send(clientAddress(req, secret)); });
  const s = app.listen(0); await new Promise(r => s.once('listening', r));
  const base = `http://localhost:${(s.address() as AddressInfo).port}/`;
  const get = (h: Record<string, string>) => fetch(base, { headers: h }).then(r => r.text());
  assert.equal(await get({ 'x-hub-proxy': secret, 'x-hub-client-ip': '203.0.113.7' }), '203.0.113.7');
  assert.notEqual(await get({ 'x-hub-proxy': 'y'.repeat(40), 'x-hub-client-ip': '203.0.113.7' }), '203.0.113.7');
  assert.notEqual(await get({ 'x-hub-proxy': secret, 'x-hub-client-ip': 'not-an-ip' }), 'not-an-ip');
  assert.notEqual(await get({ 'x-hub-client-ip': '203.0.113.7' }), '203.0.113.7');
  s.close();
  assert.throws(() => loadConfig({ HUB_PROXY_SECRET: 'short' } as NodeJS.ProcessEnv), /at least 32/);
});
