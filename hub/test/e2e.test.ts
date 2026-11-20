// End to end against the real app (memory store, dev sign-in): discovery, registration (DCR and a metadata document),
// consent, PKCE, refresh rotation with reuse detection, the MCP tools through the official SDK client, the REST API,
// per-account isolation, scope-limited tool lists, and a byte-exact round trip of the real ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { TokenIssuer } from '../src/auth/tokens.js';
import { devVerifier } from '../src/auth/identity.js';
import { createApp } from '../src/app.js';
import { Ledger } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { person } from '../src/wbs/access.js';

const LEDGER = process.env.HUB_TEST_LEDGER || '';   // a real wbs.csv to round-trip (optional)
const EVENTS = process.env.HUB_TEST_EVENTS || '';

async function boot() {
  const store = new MemoryStore();
  const srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1' } as NodeJS.ProcessEnv);
  const issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier()));
  return { base, store, close: () => new Promise<void>(r => srv.close(() => r())) };
}
const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Registration → consent → code → tokens, as a client and a person would do it. */
async function connect(base: string, opts: { uid: string; scope?: string; resource?: string; clientName?: string; clientId?: string; redirect?: string }) {
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
async function mcp(base: string, token: string, path = '/mcp') {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

test('discovery and the 401 challenge', async () => {
  const { base, close } = await boot();
  try {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`); assert.deepEqual(prm.authorization_servers, [base]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert.equal(as.client_id_metadata_document_supported, true);
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    assert.match(bad.headers.get('www-authenticate') || '', /invalid_token/);
  } finally { await close(); }
});

test('OAuth: PKCE, single-use codes, redirect checks, refresh rotation and reuse detection', async () => {
  const { base, close } = await boot();
  try {
    const t = await connect(base, { uid: 'u_a' });
    const again = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: t.code, redirect_uri: t.redirect, client_id: t.clientId, code_verifier: t.verifier }) });
    assert.equal((await again.json()).error, 'invalid_grant', 'a code works once');
    const wrong = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: t.clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`);
    assert.equal(wrong.status, 400, 'an unregistered redirect is refused without redirecting');
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: t.clientId, redirect_uri: t.redirect })}`, { redirect: 'manual' });
    assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
    const r1 = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }) })).json();
    assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== t.refresh_token, 'refresh rotates');
    const reuse = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }) })).json();
    assert.equal(reuse.error, 'invalid_grant', 'an old refresh token is refused');
    const after = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: t.clientId }) })).json();
    assert.equal(after.error, 'invalid_grant', 'reuse revokes the whole grant');
    const denied = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: t.clientId, redirect_uri: t.redirect, code_challenge: pkce().c, code_challenge_method: 'S256', state: 's' })}`);
    const req = /name="req" value="([^"]+)"/.exec(await denied.text())![1];
    const no = await fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, decision: 'deny' }) });
    assert.equal(new URL(no.headers.get('location')!).searchParams.get('error'), 'access_denied');
  } finally { await close(); }
});

test('client ID metadata document (the way Claude registers)', async () => {
  const { base, close } = await boot();
  const doc = http.createServer(); await new Promise<void>(r => doc.listen(0, r));
  const url = `http://localhost:${(doc.address() as AddressInfo).port}/client.json`;
  doc.on('request', (_q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ client_id: url, client_name: 'Claude', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' })); });
  try {
    const t = await connect(base, { uid: 'u_c', clientId: url });
    const c = await mcp(base, t.access_token);
    assert.ok((await c.listTools()).tools.length >= 7); await c.close();
  } finally { await close(); await new Promise<void>(r => doc.close(() => r())); }
});

test('MCP tools: add, duplicate guard, steps, update, isolation, scope-limited tools', async () => {
  const { base, close } = await boot();
  try {
    const t = await connect(base, { uid: 'u_j', clientName: 'Claude' });
    const c = await mcp(base, t.access_token);
    const names = (await c.listTools()).tools.map(x => x.name).sort();
    assert.deepEqual(names, ['wbs_add', 'wbs_brief', 'wbs_charter', 'wbs_coach', 'wbs_export', 'wbs_get', 'wbs_inbox_add', 'wbs_inbox_list', 'wbs_inbox_mark', 'wbs_packages', 'wbs_plan', 'wbs_plan_put', 'wbs_search', 'wbs_share', 'wbs_shared', 'wbs_spaces', 'wbs_summary', 'wbs_team', 'wbs_update', 'wbs_views', 'wbs_weekly']);
    // a new package needs its area; then tasks take the next free code
    const a1 = json(await c.callTool({ name: 'wbs_add', arguments: { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: 'PP WBS 허브 MCP 서버와 OAuth 인가 서버 구현', start: '2026-11-06', status: '진행 중', evidence: 'cc:test' } }));
    assert.equal(a1.created.code, '5.3.1'); assert.equal(a1.created.source, 'Claude');
    const a2 = json(await c.callTool({ name: 'wbs_add', arguments: { package: '5.3', task: '공개 패키지 문서 정리', start: '2026-11-06', status: '완료' } }));
    assert.equal(a2.created.code, '5.3.2'); assert.equal(a2.created.end, '2026-11-06');
    const dup = await c.callTool({ name: 'wbs_add', arguments: { package: '5.3', task: 'PP WBS 허브 MCP 서버와 OAuth 인가 서버 구현 마무리', start: '2026-11-07', status: '진행 중' } });
    assert.equal(dup.isError, true); assert.equal(json(dup).error, 'duplicate');
    const s1 = json(await c.callTool({ name: 'wbs_add', arguments: { package: '5.3', parent: '5.3.1', task: '로컬 종단 테스트 통과', start: '2026-11-06', status: '완료' } }));
    assert.equal(s1.created.code, '5.3.1.1'); assert.equal(s1.created.level, '4');
    const u1 = json(await c.callTool({ name: 'wbs_update', arguments: { year: '2026', code: '5.3.1', status: '대기·심사', blocker: '외부 심사·승인: 배포 승인', memo: '배포 대기' } }));
    assert.equal(u1.updated.status, '대기·심사');
    const g = json(await c.callTool({ name: 'wbs_get', arguments: { year: '2026', code: '5.3.1' } }));
    assert.equal(g.steps.length, 1); assert.deepEqual(g.history.map((e: { event: string }) => e.event), ['생성', '상태']);
    const bad = await c.callTool({ name: 'wbs_add', arguments: { package: '5.3', task: '날짜 형식 확인용', start: '6 Nov', status: '완료' } });
    assert.equal(bad.isError, true);
    const ex = json(await c.callTool({ name: 'wbs_export', arguments: { order: 'oldest' } }));
    assert.ok(ex.wbs.includes('5.3.1.1') && ex.events.includes('5.3.1'));
    assert.equal((await c.callTool({ name: 'wbs_export', arguments: { order: 'sideways' } })).isError, true);
    await c.close();
    // another account sees an empty ledger
    const o = await connect(base, { uid: 'u_other', clientName: 'ChatGPT' });
    const oc = await mcp(base, o.access_token);
    assert.equal(json(await oc.callTool({ name: 'wbs_search', arguments: {} })).total, 0); await oc.close();
    // a read-only grant shows no write tools
    const r = await connect(base, { uid: 'u_j', scope: 'wbs.read', clientName: 'Gemini' });
    const rc = await mcp(base, r.access_token);
    const ro = (await rc.listTools()).tools.map(x => x.name);
    assert.ok(!ro.includes('wbs_add') && !ro.includes('wbs_inbox_add') && !ro.includes('wbs_inbox_mark') && ro.includes('wbs_inbox_list'));
    assert.ok(ro.includes('wbs_plan') && ro.includes('wbs_shared') && ro.includes('wbs_views') && !ro.includes('wbs_plan_put') && !ro.includes('wbs_share')); await rc.close();
  } finally { await close(); }
});

test('REST: audience binding, search, duplicate 409, scope check', async () => {
  const { base, close } = await boot();
  try {
    const m = await connect(base, { uid: 'u_r' });
    const cross = await fetch(`${base}/v1/summary`, { headers: { authorization: `Bearer ${m.access_token}` } });
    assert.equal(cross.status, 401, 'a token minted for /mcp does not open /v1');
    const t = await connect(base, { uid: 'u_r', resource: `${base}/v1`, clientName: 'ChatGPT Actions' });
    const h = { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' };
    const add = await (await fetch(`${base}/v1/rows`, { method: 'POST', headers: h, body: JSON.stringify({ area: '4 창업·제품', package: '4.3 서비스 개발', task: '엔진 플러그인 연결 설계', start: '2026-11-06', status: '진행 중' }) })).json();
    assert.equal(add.created.code, '4.3.1'); assert.equal(add.created.source, 'GPT');
    const dup = await fetch(`${base}/v1/rows`, { method: 'POST', headers: h, body: JSON.stringify({ package: '4.3', task: '엔진 플러그인 연결 설계 초안', start: '2026-11-06', status: '진행 중' }) });
    assert.equal(dup.status, 409);
    const found = await (await fetch(`${base}/v1/rows?q=${encodeURIComponent('플러그인')}`, { headers: h })).json();
    assert.equal(found.total, 1);
    const ex = await (await fetch(`${base}/v1/export?order=oldest`, { headers: h })).json();
    assert.ok(ex.wbs.startsWith('﻿연도,WBS,') && ex.wbs.includes('4.3.1'));
    const ro = await connect(base, { uid: 'u_r', resource: `${base}/v1`, scope: 'wbs.read' });
    const w = await fetch(`${base}/v1/rows`, { method: 'POST', headers: { authorization: `Bearer ${ro.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(w.status, 403);
  } finally { await close(); }
});

test('team space over MCP and REST: agents list it, write and read its plan; a guest sees its project; outsiders see nothing', async () => {
  const { base, store, close } = await boot();
  try {
    const spaces = new Spaces(store), s = await spaces.create(person('u_j'), '연구실');   // people create and staff spaces
    await spaces.setMember(person('u_j'), s.id, 'u_g', 'guest', ['2026:4.3']);
    const c = await mcp(base, (await connect(base, { uid: 'u_j', clientName: 'Claude' })).access_token);
    // closed until a charter is in force; the owner alone is everyone who must agree, so proposing opens it
    const shut = await c.callTool({ name: 'wbs_search', arguments: { space: s.id } });
    assert.equal(shut.isError, true); assert.equal(json(shut).error, 'consent_required');
    await spaces.proposeCharter(person('u_j'), s.id, ['팀 작업은 기본 공개다.', '에이전트는 제안하고 사람은 승인한다.']);
    const ch = json(await c.callTool({ name: 'wbs_charter', arguments: { space: s.id } }));
    assert.equal(ch.open, true); assert.equal(ch.in_force.version, 1); assert.equal(ch.in_force.lines.length, 2);
    assert.deepEqual(json(await c.callTool({ name: 'wbs_spaces', arguments: {} })).map((x: { id: string; role: string }) => `${x.id === s.id ? 'team' : x.id}:${x.role}`), ['personal:owner', 'team:owner']);
    const t1 = json(await c.callTool({ name: 'wbs_add', arguments: { space: s.id, area: '4 창업·제품', package: '4.3 서비스 개발', task: '팀 계획: 허브 공간 전환 API', start: '2026-11-18', status: '진행 중' } }));
    const t2 = json(await c.callTool({ name: 'wbs_add', arguments: { space: s.id, area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '팀 계획: 헌장 동의 기록', start: '2026-11-18', status: '진행 중' } }));
    assert.deepEqual([t1.created.code, t2.created.code], ['4.3.1', '5.3.1']);
    assert.equal(json(await c.callTool({ name: 'wbs_search', arguments: {} })).total, 0, 'the personal ledger got nothing');
    assert.equal(json(await c.callTool({ name: 'wbs_search', arguments: { space: s.id } })).total, 2);
    const u = json(await c.callTool({ name: 'wbs_update', arguments: { space: s.id, year: '2026', code: '5.3.1', status: '완료' } }));
    assert.equal(u.updated.status, '완료');
    await c.close();
    // the guest's agent: its project only, no writing
    const g = await mcp(base, (await connect(base, { uid: 'u_g', clientName: 'ChatGPT' })).access_token);
    assert.deepEqual(json(await g.callTool({ name: 'wbs_search', arguments: { space: s.id } })).rows.map((r: { code: string }) => r.code), ['4.3.1']);
    const gw = await g.callTool({ name: 'wbs_add', arguments: { space: s.id, package: '4.3', task: '게스트가 쓰려는 계획 항목', start: '2026-11-18', status: '진행 중' } });
    assert.equal(gw.isError, true); assert.equal(json(gw).error, 'forbidden');
    await g.close();
    // an outsider is told nothing exists
    const x = await mcp(base, (await connect(base, { uid: 'u_x', clientName: 'Gemini' })).access_token);
    const xr = await x.callTool({ name: 'wbs_get', arguments: { space: s.id, year: '2026', code: '4.3.1' } });
    assert.equal(xr.isError, true); assert.equal(json(xr).error, 'not_found');
    await x.close();
    // REST: the same space by query parameter; a read grant is stopped by its scope, a guest by the table
    const ro = await connect(base, { uid: 'u_j', resource: `${base}/v1`, scope: 'wbs.read', clientName: 'ChatGPT Actions' });
    const h = { authorization: `Bearer ${ro.access_token}`, 'content-type': 'application/json' };
    assert.equal((await (await fetch(`${base}/v1/spaces`, { headers: h })).json()).length, 2);
    assert.equal((await (await fetch(`${base}/v1/rows?space=${s.id}`, { headers: h })).json()).total, 2);
    assert.equal((await fetch(`${base}/v1/rows?space=${s.id}`, { method: 'POST', headers: h, body: '{}' })).status, 403);
    const gr = await connect(base, { uid: 'u_g', resource: `${base}/v1`, clientName: 'ChatGPT Actions' });
    const gp = await fetch(`${base}/v1/rows?space=${s.id}`, { method: 'POST', headers: { authorization: `Bearer ${gr.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ package: '4.3', task: '게스트가 REST로 쓰려는 계획 항목', start: '2026-11-18', status: '진행 중' }) });
    assert.equal(gp.status, 403); assert.equal((await gp.json()).error, 'forbidden');
  } finally { await close(); }
});

test('team intents over MCP and REST: written with the plan, set against the shared work in the plan view, the brief and the team screen; not for guests', async () => {
  const { base, store, close } = await boot();
  try {
    const spaces = new Spaces(store), s = await spaces.create(person('u_j'), '연구실');
    await spaces.setMember(person('u_j'), s.id, 'u_m', 'member');
    await spaces.setMember(person('u_j'), s.id, 'u_g', 'guest', ['2026:4.3']);
    await spaces.proposeCharter(person('u_j'), s.id, ['공유는 필드 단위다.']);
    await spaces.consentCharter(person('u_m'), s.id, 1, true);
    const c = await mcp(base, (await connect(base, { uid: 'u_j', clientName: 'Claude' })).access_token);
    const w = json(await c.callTool({ name: 'wbs_plan_put', arguments: { space: s.id, intents: [{ why: '팀 작업을 한 원장에서 본다', how: '필드 단위 공유' }, { why: '마감을 지킨다' }] } }));
    assert.deepEqual(w.intents.created, ['i1', 'i2']);
    json(await c.callTool({ name: 'wbs_plan_put', arguments: { space: s.id, items: [
      { year: '2026', code: '4', scope: '제품', intent: 'i1' }, { year: '2026', code: '4.3', scope: '서비스 개발' }, { year: '2026', code: '5', scope: '일정', intent: 'i2' }] } }));
    const r = json(await c.callTool({ name: 'wbs_add', arguments: { area: '4 창업·제품', package: '4.3 서비스 개발', task: '공간 전환 API 구현', start: '2026-11-18', status: '진행 중' } }));
    json(await c.callTool({ name: 'wbs_share', arguments: { year: '2026', code: r.created.code, space: s.id, plan: '4.3' } }));
    const a = json(await c.callTool({ name: 'wbs_plan', arguments: { space: s.id, view: 'alignment' } }));
    assert.deepEqual(a.intents.map((i: { id: string; work: number; share: number; people: string[]; flags: string[] }) => [i.id, i.work, i.share, i.people, i.flags]),
      [['i1', 1, 1, ['u_j'], []], ['i2', 0, 0, [], ['no_work']]]);
    assert.ok(a.lines[0].startsWith('1순위 팀 작업을 한 원장에서 본다'));
    const b = json(await c.callTool({ name: 'wbs_brief', arguments: { space: s.id } }));
    assert.deepEqual(b.alignment.intents.map((i: { id: string }) => i.id), ['i1', 'i2'], 'the team brief carries the alignment');
    assert.equal('alignment' in json(await c.callTool({ name: 'wbs_brief', arguments: {} })), false, 'the personal brief does not');
    const team = json(await c.callTool({ name: 'wbs_team', arguments: { space: s.id } }));
    assert.equal(team.alignment.total_work, 1);
    // the weekly brief (4.3): in the team screen and on its own, the same text; coaching for the person alone
    const wk = json(await c.callTool({ name: 'wbs_weekly', arguments: { space: s.id } }));
    assert.deepEqual(team.weekly.lines, wk.lines); assert.match(wk.lines[0], /^진척: /);
    assert.match(json(await c.callTool({ name: 'wbs_coach', arguments: {} })).note, /본인에게만/);
    await c.close();
    // a guest's agent: no alignment anywhere, and the brief still answers
    const g = await mcp(base, (await connect(base, { uid: 'u_g', clientName: 'ChatGPT' })).access_token);
    const ga = await g.callTool({ name: 'wbs_plan', arguments: { space: s.id, view: 'alignment' } });
    assert.equal(ga.isError, true); assert.equal(json(ga).error, 'forbidden');
    assert.equal('alignment' in json(await g.callTool({ name: 'wbs_brief', arguments: { space: s.id } })), false);
    const gt = json(await g.callTool({ name: 'wbs_team', arguments: { space: s.id } }));
    assert.equal(gt.alignment, null); assert.equal(gt.weekly, null, 'guests get no weekly brief');
    const gw = await g.callTool({ name: 'wbs_weekly', arguments: { space: s.id } });
    assert.equal(gw.isError, true); assert.equal(json(gw).error, 'forbidden');
    await g.close();
    // REST: the same views by query parameter
    const t = await connect(base, { uid: 'u_m', resource: `${base}/v1`, scope: 'wbs.read', clientName: 'ChatGPT Actions' });
    const h = { authorization: `Bearer ${t.access_token}` };
    const ra = await (await fetch(`${base}/v1/plan?space=${s.id}&view=alignment`, { headers: h })).json();
    assert.deepEqual(ra.by_person, [{ uid: 'u_j', rows: 1, by_intent: { i1: 1, i2: 0 }, off_intent: 0 }]);
    assert.equal((await (await fetch(`${base}/v1/brief?space=${s.id}`, { headers: h })).json()).alignment.total_work, 1);
  } finally { await close(); }
});

test('the real ledger round-trips byte for byte', { skip: !LEDGER }, async () => {
  const store = new MemoryStore(), ledger = new Ledger(store);
  const wbs = readFileSync(LEDGER, 'utf8'), events = EVENTS ? readFileSync(EVENTS, 'utf8') : undefined;
  const n = await ledger.importCsv('u_x', wbs, events);
  assert.ok(n.rows > 700);
  const out = await ledger.exportCsv('u_x', n.order);
  assert.equal(out.wbs, wbs, 'wbs.csv identical after import → export');
  if (events) assert.equal(out.events, events, 'events.csv identical');
  const p = await ledger.packages('u_x', '2026');
  assert.ok(p.some(x => x.package.startsWith('5.3 ')));
});

test('a ledger kept oldest year first round-trips in its own order; the default export and search are newest first', async () => {
  const ledger = new Ledger(new MemoryStore());
  // header + rows oldest year first, 1.10 after 1.9; quoted cells (comma, quote, line break) must come back as written
  const head = '연도,WBS,레벨,대분류,중분류,상위 작업,작업·산출물,시작일,종료일,일자(원문),시작월,상태,핵심성과,출처,마감일,중요도,크기,선행,막힘 사유,최근 진행일,목표,근거';
  const row = (y: string, c: string, task: string) =>
    `${y},${c},3,1 연구,1.1 논문,,${task},${y}-01-02,,${y}-01-02,${y}-01,완료,,Claude,,,,,,,,`;
  const wbs = '﻿' + [head,
    row('2025', '1.1.2', '"쉼표, 따옴표 ""인용"" 포함"'),
    row('2026', '1.1.9', '아홉 번째 작업'),
    row('2026', '1.1.10', '"열 번째 작업\r\n둘째 줄"'),
  ].join('\r\n') + '\r\n';
  const n = await ledger.importCsv('u_o', wbs);
  assert.equal(n.order, 'oldest');
  assert.equal((await ledger.exportCsv('u_o', n.order)).wbs, wbs, 'export in the file\'s order reproduces it byte for byte');
  const years = (await ledger.exportCsv('u_o')).wbs.split('\r\n').slice(1, -1).map(l => l.slice(0, 4)).filter(y => /^\d{4}$/.test(y));
  assert.deepEqual(years, ['2026', '2026', '2025'], 'default export: newest year first');
  const s = await ledger.search('u_o', {});
  assert.deepEqual(s.rows.map(r => `${r.year} ${r.code}`), ['2026 1.1.9', '2026 1.1.10', '2025 1.1.2']);
});

test('confidential client (GPT Actions style): secret instead of PKCE, wrong secret refused', async () => {
  const { base, close } = await boot();
  try {
    const redirect = 'https://chat.openai.com/aip/g-test/oauth/callback';
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT Actions', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_basic' }) })).json();
    assert.ok(reg.client_secret, 'the secret is shown once');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'wbs.read', state: 'g', resource: `${base}/v1` });
    const page = await fetch(`${base}/oauth/authorize?${q}`);
    assert.equal(page.status, 200);
    const req = /name="req" value="([^"]+)"/.exec(await page.text())![1];
    const ok = await fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, id_token: 'dev:u_g', decision: 'allow' }) });
    const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
    const wrong = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${reg.client_id}:nope`).toString('base64') }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect }) });
    assert.equal(wrong.status, 401);
    // the code was not consumed by the failed attempt (client auth happens first), so the right secret still works
    const tok = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString('base64') }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect }) });
    assert.equal(tok.status, 200, await tok.clone().text());
    const t = await tok.json();
    const rows = await fetch(`${base}/v1/rows`, { headers: { authorization: `Bearer ${t.access_token}` } });
    assert.equal(rows.status, 200);
  } finally { await close(); }
});

test('a team\'s own address: the connection is that team\'s environment — work lands in the person\'s ledger linked to the plan, the personal ledger stays out', async () => {
  const { base, store, close } = await boot();
  try {
    const spaces = new Spaces(store), s = await spaces.create(person('u_j'), '연구실');
    await spaces.setMember(person('u_j'), s.id, 'u_m', 'member');
    await spaces.proposeCharter(person('u_j'), s.id, ['공유는 필드 단위다.']);
    await spaces.consentCharter(person('u_m'), s.id, 1, true);
    const team = `/mcp/t/${s.id}`, resource = `${base}${team}`;
    // discovery names the team address as its own resource; a malformed one is not found
    assert.equal((await (await fetch(`${base}/.well-known/oauth-protected-resource${team}`)).json()).resource, resource);
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/t/nope`)).status, 404);
    const un = await fetch(`${base}${team}`, { method: 'POST' });
    assert.equal(un.status, 401); assert.match(un.headers.get('www-authenticate') || '', new RegExp(`oauth-protected-resource${team}`));
    // the owner writes the plan on a personal connection, naming the space
    const p = await mcp(base, (await connect(base, { uid: 'u_j', clientName: 'Claude' })).access_token);
    json(await p.callTool({ name: 'wbs_plan_put', arguments: { space: s.id, items: [
      { year: '2026', code: '1', scope: '출시 준비' }, { year: '2026', code: '1.1', scope: '결제 연동', deliverable: '정기 결제와 환불', status: '진행 중' },
      { year: '2026', code: '1.2', scope: '가입·로그인 흐름', deliverable: '이메일·소셜 로그인, 비밀번호 재설정', status: '진행 중' }] } }));
    const personalRow = json(await p.callTool({ name: 'wbs_add', arguments: { area: '6 개인 행정', package: '6.1 개인 일정', task: '개인 서류 정리', start: '2026-11-18', status: '완료' } }));
    await p.close();
    // the member connects the team's address: the consent page says so, and the token is bound to it
    const t = await connect(base, { uid: 'u_m', clientName: 'Claude', resource });
    const c = await mcp(base, t.access_token, team);
    const names = (await c.listTools()).tools.map(x => x.name);
    assert.ok(!names.includes('wbs_inbox_list') && !names.includes('wbs_inbox_add'), 'the personal inbox is not on a team connection');
    const sps = json(await c.callTool({ name: 'wbs_spaces', arguments: {} }));
    const me = sps.find((x: { id: string }) => x.id === s.id);
    assert.equal(me.this_connection, true); assert.equal(me.connector_url, resource);
    // recording without space: the member's own ledger, linked to the team plan
    const named = json(await c.callTool({ name: 'wbs_add', arguments: { area: '4 창업·제품', package: '4.3 서비스 개발', task: '관리자 화면 초안', start: '2026-11-18', status: '진행 중', plan: '1.2' } }));
    assert.equal(named.team.status, 'linked'); assert.equal(named.team.linked.plan, '2026:1.2');
    const matched = json(await c.callTool({ name: 'wbs_add', arguments: { package: '4.3', task: '정기 결제 연동: 카드 등록과 자동 청구 시험 통과', start: '2026-11-18', status: '진행 중' } }));
    assert.equal(matched.team.status, 'linked'); assert.equal(matched.team.matched.plan, '1.1', 'the hub matched the plan item');
    const loose = json(await c.callTool({ name: 'wbs_add', arguments: { package: '4.3', task: '팀 운영 도구 비교표 작성', start: '2026-11-18', status: '진행 중' } }));
    assert.equal(loose.team.status, 'pending'); assert.ok(Array.isArray(loose.team.suggestions));
    const pv = json(await c.callTool({ name: 'wbs_plan', arguments: {} }));
    assert.equal(pv.totals.shared_rows, 2, 'only linked rows reach the team; the pending one waits');
    // the rows are the member's own, not the team's ledger
    assert.equal(json(await c.callTool({ name: 'wbs_search', arguments: {} })).total, 0, 'reads default to the team\'s own ledger');
    const pr = await c.callTool({ name: 'wbs_search', arguments: { space: 'personal' } });
    assert.equal(pr.isError, true); assert.equal(json(pr).error, 'forbidden', 'the personal ledger is not readable here');
    const mine = json(await c.callTool({ name: 'wbs_shared', arguments: {} }));
    assert.deepEqual(mine.map((l: { code: string; pending?: boolean }) => [l.code, !!l.pending]), [[named.created.code, false], [matched.created.code, false], [loose.created.code, true]]);
    // updates: rows linked to this team (pending included) yes, other personal rows no
    const u = json(await c.callTool({ name: 'wbs_update', arguments: { year: '2026', code: matched.created.code, status: '완료' } }));
    assert.equal(u.updated.status, '완료');
    assert.equal(json(await c.callTool({ name: 'wbs_plan', arguments: {} })).items.find((i: { code: string }) => i.code === '1.1').actual.status, '완료', 'the team\'s copy followed');
    const other = await c.callTool({ name: 'wbs_update', arguments: { year: '2026', code: personalRow.created.code, status: '진행 중' } });
    assert.equal(other.isError, true); assert.equal(json(other).error, 'forbidden');
    // linking the pending row once the person picks the item
    json(await c.callTool({ name: 'wbs_share', arguments: { year: '2026', code: loose.created.code, plan: '1' } }));
    assert.equal(json(await c.callTool({ name: 'wbs_plan', arguments: {} })).totals.shared_rows, 3);
    const brief = json(await c.callTool({ name: 'wbs_brief', arguments: {} }));
    assert.ok('alignment' in brief, 'the team brief by default');
    await c.close();
    // a personal token does not open the team address; a team grant cannot be refreshed into a personal one
    const pt = await connect(base, { uid: 'u_m', clientName: 'Claude' });
    assert.equal((await fetch(`${base}${team}`, { method: 'POST', headers: { authorization: `Bearer ${pt.access_token}`, 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const rf = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId, resource: `${base}/mcp` }) });
    assert.equal(rf.status, 400); assert.equal((await rf.json()).error, 'invalid_target');
    // an outsider cannot connect the team's address
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' }) })).json();
    const { c: ch } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: ch, code_challenge_method: 'S256', scope: 'wbs.read wbs.write', state: 'st8', resource });
    const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    assert.match(page, /팀 환경 연결입니다/);
    const req = /name="req" value="([^"]+)"/.exec(page)![1];
    const no = await fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, id_token: 'dev:u_x', decision: 'allow' }) });
    assert.equal(new URL(no.headers.get('location')!).searchParams.get('error'), 'access_denied');
  } finally { await close(); }
});
