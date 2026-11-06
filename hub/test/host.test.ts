// Host membership on consent: the verified ID token goes to the host's session endpoint with the browser's time zone and
// language, the host session is kept for the account, the host terms checkbox is required, and a failing host either
// blocks the connection (HUB_HOST_REQUIRED=1) or lets it through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { hostJoiner, cleanTimezone, cleanLocale } from '../src/auth/host.js';
import { createApp } from '../src/app.js';

async function listen(handler: http.RequestListener) {
  const s = http.createServer(handler); await new Promise<void>(r => s.listen(0, r));
  return { url: `http://localhost:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>(r => s.close(() => r())) };
}
async function boot(hostStatus: number, required: boolean) {
  const seen: Record<string, unknown>[] = [];
  const host = await listen((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.push({ ...JSON.parse(b), _appcheck: req.headers['x-firebase-appcheck'] }); res.writeHead(hostStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(hostStatus === 200 ? { accessToken: 'a', refreshToken: 'host-refresh-1' } : { error: 'x' })); }); });
  const store = new MemoryStore(), srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1', HUB_HOST_NAME: 'Host', HUB_HOST_SESSION_URL: host.url + '/v1/auth/session', HUB_HOST_TERMS_URL: 'https://host.example/terms', HUB_HOST_PRIVACY_URL: 'https://host.example/privacy', HUB_HOST_REQUIRED: required ? '1' : '0' } as NodeJS.ProcessEnv);
  const issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier(), hostJoiner(cfg.host, store, async () => 'appcheck-token')));
  return { base, store, seen, close: async () => { await new Promise<void>(r => srv.close(() => r())); await host.close(); } };
}
async function authorize(base: string) {
  const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' }) })).json();
  const ch = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const page = await (await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: ch, code_challenge_method: 'S256', state: 's1' }))).text();
  return { page, req: /name="req" value="([^"]+)"/.exec(page)![1] };
}
const approve = (base: string, fields: Record<string, string>) => fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('consent page names the host, links its terms and asks for agreement', async () => {
  const h = await boot(200, false);
  const { page } = await authorize(h.base);
  assert.match(page, /Host 회원으로 가입/); assert.match(page, /href="https:\/\/host\.example\/terms"/); assert.match(page, /id="agree"/);
  await h.close();
});

test('allow → the host gets the ID token, time zone and language; the host session is kept for the account', async () => {
  const h = await boot(200, false);
  const { req } = await authorize(h.base);
  const r = await approve(h.base, { req, id_token: 'dev:member_1', decision: 'allow', host_ok: '1', tz: 'Asia/Seoul', lang: 'ko-KR' });
  assert.equal(r.status, 302); assert.match(r.headers.get('location')!, /[?&]code=/);
  assert.deepEqual(h.seen[0], { identityToken: 'dev:member_1', timezone: 'Asia/Seoul', locale: 'ko', _appcheck: 'appcheck-token' });
  assert.deepEqual(await h.store.secret('member_1', 'host_session').then(v => (v as { refreshToken: string }).refreshToken), 'host-refresh-1');
  assert.ok(await h.store.secret('member_1', 'host_member'));
  await h.close();
});

test('without the terms checkbox the connection is refused and the host is not called', async () => {
  const h = await boot(200, false);
  const { req } = await authorize(h.base);
  const r = await approve(h.base, { req, id_token: 'dev:member_2', decision: 'allow', tz: 'Asia/Seoul', lang: 'ko' });
  assert.match(r.headers.get('location')!, /error=access_denied/); assert.equal(h.seen.length, 0);
  await h.close();
});

test('a failing host blocks the connection only when it is required', async () => {
  for (const required of [true, false]) {
    const h = await boot(503, required);
    const { req } = await authorize(h.base);
    const loc = (await approve(h.base, { req, id_token: 'dev:member_3', decision: 'allow', host_ok: '1', tz: 'Europe/Paris', lang: 'en-GB' })).headers.get('location')!;
    if (required) assert.match(loc, /error=temporarily_unavailable/); else assert.match(loc, /[?&]code=/);
    assert.equal(await h.store.secret('member_3', 'host_session'), null);
    await h.close();
  }
});

test('time zone and language are cleaned before they reach the host', () => {
  assert.equal(cleanTimezone('Asia/Seoul'), 'Asia/Seoul'); assert.equal(cleanTimezone('../../etc'), 'UTC'); assert.equal(cleanTimezone('Mars/Base'), 'UTC'); assert.equal(cleanTimezone(undefined), 'UTC');
  assert.equal(cleanLocale('ko-KR'), 'ko'); assert.equal(cleanLocale('en-US'), 'en'); assert.equal(cleanLocale('zh-CN'), 'en');
});
