// Public pages: the connect page shows this deployment's MCP address and a working Cursor link; the privacy notice
// carries the Limited Use statement; the OpenAI domain challenge is served only when configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';

test('connect page, privacy notice and the domain challenge', async () => {
  const srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1', HUB_SUPPORT_EMAIL: 'help@example.com', HUB_OPENAI_APPS_CHALLENGE: 'tok-123', HUB_HOST_NAME: 'Host', HUB_HOST_SESSION_URL: 'http://localhost:1/s' } as NodeJS.ProcessEnv);
  srv.on('request', createApp(cfg, new MemoryStore(), await TokenIssuer.create(cfg.publicUrl, 3600), devVerifier()));
  const ko = await (await fetch(base + '/', { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } })).text();
  assert.match(ko, new RegExp(`${base}/mcp`)); assert.match(ko, /연결하기/);
  const cfgB64 = /config=([A-Za-z0-9+/=]+)/.exec(ko)![1];
  assert.deepEqual(JSON.parse(Buffer.from(cfgB64, 'base64').toString()), { url: `${base}/mcp` });
  const en = await (await fetch(base + '/', { headers: { 'accept-language': 'en-US' } })).text(); assert.match(en, /Connect/);
  const pv = await (await fetch(base + '/privacy', { headers: { 'accept-language': 'en' } })).text();
  assert.match(pv, /Limited Use requirements/); assert.match(pv, /Host member/); assert.match(pv, /help@example\.com/);
  const ch = await fetch(base + '/.well-known/openai-apps-challenge'); assert.equal(await ch.text(), 'tok-123'); assert.match(ch.headers.get('content-type')!, /text\/plain/);
  await new Promise<void>(r => srv.close(() => r()));
});
