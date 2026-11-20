// The hub's own pages for people (/app): a first-party session from sign-in, changes only from the hub's own pages,
// and the people-only acts end to end — make a team, agree to its charter, invite a member who accepts by hand, answer
// the twenty questions, publish cards and see each other's — while an agent's token opens none of it; and one account
// in three teams (execution WBS 5.3): a link and two account invitations answered on the hub, and the pages between them.
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
    // B joins by an account invitation: reads it with the charter in force and agrees to that charter on joining
    const inv = await a('POST', `/app/api/t/${s.id}/invites`, { role: 'member', for: 'u_b' });
    assert.equal(inv.code, undefined, 'an account invitation carries no code');
    await assert.rejects(a('POST', `/app/api/t/${s.id}/members`, { uid: 'u_c', role: 'member' }), (e: { status: number }) => e.status === 400, 'nobody is added without saying yes');
    const read = await b('POST', '/app/api/invites/preview', { space: s.id, invite: inv.id });
    assert.deepEqual([read.space.name, read.role, read.charter.version, read.by_name], ['연구실', 'member', 1, '계정 u_a']);
    await assert.rejects(b('GET', `/app/api/t/${s.id}/cards`), (e: { status: number }) => e.status === 404, 'not in the team before accepting');
    await assert.rejects(b('POST', '/app/api/join', { space: s.id, invite: inv.id }),
      (e: { status: number; body: { error: string; detail: { version: number } } }) => e.status === 403 && e.body.error === 'consent_required' && e.body.detail.version === 1);
    assert.deepEqual(await b('POST', '/app/api/join', { space: s.id, invite: inv.id, agree: 1 }), { space: s.id, name: '연구실', role: 'member' });
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

test('one account, three teams on the hub pages: a link and account invitations answered by hand, a nav between the teams', async () => {
  const { base, close } = await boot();
  try {
    const page = async (cookie: string, path: string) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); assert.equal(r.status, 200); return r.text(); };
    const [ck1, ck2, ck3, ckj, ckx] = await Promise.all(['u_o1', 'u_o2', 'u_o3', 'u_j', 'u_x'].map(u => signIn(base, u)));
    const [o1, o2, o3, j, x] = [ck1, ck2, ck3, ckj, ckx].map(c => call(base, c));
    const t = await Promise.all([[o1, '연구실'], [o2, '창업 팀'], [o3, '공동 연구']].map(async ([o, n]) => {
      const sp = await (o as typeof o1)('POST', '/app/api/spaces', { name: n }); await (o as typeof o1)('POST', `/app/api/t/${sp.id}/charter/propose`, { lines: ['공유는 필드 단위다.'], note: '' }); return sp; }));
    // a link from the first team: the code is shown once and goes after '#', so the server never sees it in a URL
    const link = await o1('POST', `/app/api/t/${t[0].id}/invites`, { role: 'member' });
    assert.match(link.code, /^[A-Za-z0-9_-]{43}$/);
    const owner1 = await page(ck1, `/app/t/${t[0].id}`);
    assert.match(owner1, /초대 링크 만들기/); assert.match(owner1, /location\.origin \+ '\/app\/join#'/); assert.doesNotMatch(owner1, new RegExp(link.code));
    const jp = await page(ckj, '/app/join');
    assert.match(jp, /팀 초대/); assert.match(jp, /location\.hash/);
    assert.equal((await j('POST', '/app/api/invites/preview', { code: link.code })).charter.version, 1);
    await j('POST', '/app/api/join', { code: link.code, agree: 1 });
    await assert.rejects(x('POST', '/app/api/join', { code: link.code, agree: 1 }), (e: { status: number }) => e.status === 404, 'a link is used once');
    // account invitations from the other two: waiting on J's home, each opened on its own page
    const a2 = await o2('POST', `/app/api/t/${t[1].id}/invites`, { role: 'member', for: 'u_j' });
    const a3 = await o3('POST', `/app/api/t/${t[2].id}/invites`, { role: 'guest', projects: ['2026:2.1'], for: 'u_j' });
    let home = await page(ckj, '/app');
    assert.match(home, /받은 초대 <small>2건<\/small>/); assert.match(home, new RegExp(`/app/i/${t[1].id}/${a2.id}`)); assert.match(home, /창업 팀/);
    assert.match(await page(ckj, `/app/i/${t[2].id}/${a3.id}`), /팀 초대/);
    await assert.rejects(x('POST', '/app/api/invites/preview', { space: t[1].id, invite: a2.id }), (e: { status: number }) => e.status === 404, 'not for this account');
    assert.match(await page(ck2, `/app/t/${t[1].id}`), /계정 <code>u_j<\/code>/, 'the owner sees the account id typed, not a name, until it is accepted');
    await j('POST', '/app/api/join', { space: t[1].id, invite: a2.id, agree: 1 });
    await j('POST', '/app/api/join', { space: t[2].id, invite: a3.id });
    home = await page(ckj, '/app');
    assert.doesNotMatch(home, /받은 초대 <small>/);
    for (const sp of t) assert.match(home, new RegExp(`/app/t/${sp.id}`));
    // the team page lists every team of the account, the current one marked
    const tp = await page(ckj, `/app/t/${t[1].id}`);
    assert.equal((tp.match(/<nav class="teams"[\s\S]*?<\/nav>/)![0].match(/<li>/g) || []).length, 3);
    assert.match(tp, new RegExp(`href="/app/t/${t[1].id}" aria-current="page"`));
    assert.doesNotMatch(tp, /id="inv"/, 'only the owner invites');
    // the owners' records: joined by J
    assert.deepEqual((await o2('GET', `/app/api/t/${t[1].id}/invites`)).map((i: { status: string; for: string }) => [i.status, i.for]), [['joined', 'u_j']]);
    // leaving one team keeps the other two
    await j('POST', `/app/api/t/${t[1].id}/leave`);
    home = await page(ckj, '/app');
    assert.doesNotMatch(home, new RegExp(`/app/t/${t[1].id}`)); assert.match(home, new RegExp(`/app/t/${t[0].id}`)); assert.match(home, new RegExp(`/app/t/${t[2].id}`));
  } finally { await close(); }
});
