// The hub's own pages for people (/app): a first-party session from sign-in, changes only from the hub's own pages,
// and the people-only acts end to end — make a team, agree to its charter, add a member, answer the twenty questions,
// publish cards and see each other's — while an agent's token opens none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';

async function boot() {
  const store = new MemoryStore(), srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1' } as NodeJS.ProcessEnv), issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier()));
  return { base, store, issuer, close: () => new Promise<void>(r => srv.close(() => r())) };
}
const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
async function signIn(base: string, uid: string) {
  const r = await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) });
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie')!;
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  return c.split(';')[0];
}
const call = (base: string, cookie: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.message || j.error), { status: r.status, body: j });
  return j;
};

test('the session: a sign-in page without one, a cookie only with the page\'s header, and changes only from this origin', async () => {
  const { base, close } = await boot();
  try {
    const p = await fetch(`${base}/app`);
    assert.equal(p.status, 200); assert.match(await p.text(), /개발용 로그인/);
    assert.match(p.headers.get('content-security-policy') || '', /script-src 'nonce-[^']+'.*frame-ancestors 'none'/);
    assert.equal(p.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${base}/app/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: 'dev:u_a' }) })).status, 403, 'no page header, no session');
    assert.equal((await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: 'nope' }) })).status, 401);
    const ck = await signIn(base, 'u_a');
    assert.equal((await fetch(`${base}/app/api/spaces`, { method: 'POST', headers: { ...H, cookie: ck, origin: 'https://evil.example' }, body: '{"name":"x"}' })).status, 403, 'another origin');
    assert.equal((await fetch(`${base}/app/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: '{"name":"x"}' })).status, 403, 'a plain form post');
    assert.equal((await fetch(`${base}/app/api/spaces`, { method: 'POST', headers: H, body: '{"name":"x"}' })).status, 401, 'no session');
    const home = await (await fetch(`${base}/app`, { headers: { cookie: ck } })).text();
    assert.match(home, /내 공간/); assert.match(home, /u_a/);
    assert.equal((await fetch(`${base}/app/logout`, { method: 'POST', headers: { ...H, cookie: ck } })).headers.get('set-cookie')?.includes('Max-Age=0'), true);
  } finally { await close(); }
});

test('people\'s acts end to end: a team, its charter, a member, the questions, two cards seen symmetrically; an agent token opens none', async () => {
  const { base, issuer, close } = await boot();
  try {
    const a = call(base, await signIn(base, 'u_a')), b = call(base, await signIn(base, 'u_b'));
    const s = await a('POST', '/app/api/spaces', { name: '연구실' });
    await a('POST', `/app/api/t/${s.id}/charter/propose`, { lines: ['공유는 필드 단위다.', '카드는 서로 같은 조건으로 본다.'], note: '' });
    await a('POST', `/app/api/t/${s.id}/members`, { uid: 'u_b', role: 'member' });
    // B is in, but the charter in force waits for B's agreement before the team opens to B
    await assert.rejects(b('GET', `/app/api/t/${s.id}/cards`), (e: { status: number }) => e.status === 403);
    await b('POST', `/app/api/t/${s.id}/charter/consent`, { version: 1, agree: true });
    const twenty = (v: number) => Array(20).fill(v);
    const scored = await a('POST', '/app/api/assess', { answers: twenty(4) });
    assert.equal(scored.traits.length, 5);
    await assert.rejects(a('POST', '/app/api/assess', { answers: twenty(4).slice(1) }), (e: { status: number }) => e.status === 400);
    await a('POST', `/app/api/t/${s.id}/card`, { direction: { role: '제품 책임' } });
    await b('POST', '/app/api/assess', { answers: twenty(2) });
    await b('POST', `/app/api/t/${s.id}/card`, { sections: ['C', 'direction'], direction: { grow: '실험 설계' } });
    const seen = await a('GET', `/app/api/t/${s.id}/cards`);
    assert.deepEqual(seen.cards.map((c: { uid: string; traits: { trait: string }[] }) => [c.uid, c.traits.map(t => t.trait)]), [['u_b', ['C']]]);
    const html = await (await fetch(`${base}/app/t/${s.id}`, { headers: { cookie: (await signIn(base, 'u_a')) } })).text();
    assert.match(html, /성향·방향성 카드/); assert.match(html, /실험 설계/); assert.match(html, /추론/); assert.doesNotMatch(html, /팀 평균|순위표/);
    const q = await (await fetch(`${base}/app/assess`, { headers: { cookie: (await signIn(base, 'u_a')) } })).text();
    assert.equal((q.match(/<fieldset class="item">/g) || []).length, 20); assert.match(q, /Donnellan/);
    // an agent's access token is not a session: the pages and their API stay shut
    const at = (await issuer.access('u_a', 'c1', 'Claude', 'wbs.read wbs.write', `${base}/mcp`)).token;
    assert.equal((await fetch(`${base}/app/api/t/${s.id}/cards`, { headers: { 'x-ppwbs': '1', authorization: `Bearer ${at}` } })).status, 401);
    assert.equal((await fetch(`${base}/app/api/t/${s.id}/cards`, { headers: { 'x-ppwbs': '1', cookie: `ppwbs=${at}` } })).status, 401, 'nor passed off as the cookie');
    // B leaves: B's card goes with B
    await b('POST', `/app/api/t/${s.id}/leave`);
    assert.deepEqual((await a('GET', `/app/api/t/${s.id}/cards`)).cards, []);
  } finally { await close(); }
});
