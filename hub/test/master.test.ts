// The team master agent (execution WBS 4.5): only the owner delegates it, through the team's agent address; it acts as
// the team's delegate with a tool set of its own (the team summary to read, proposals to make) and its token opens
// nothing else; plan changes wait for the accountable people (A) and are applied as their write, declined or found
// stale; the weekly report it drafts names no one and reaches the team once the owner approves it; approving is a
// person's act on the hub's pages; the owner stops it at once (calls refused, grant revoked, proposals withdrawn).
import { test } from 'node:test';
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
import { LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Briefs, lastFullWeek, isoWeek } from '../src/wbs/weekly.js';
import { MasterAgent } from '../src/wbs/master.js';
import { agent, person, type Caller } from '../src/wbs/access.js';
import { todayKst } from '../src/wbs/model.js';
import { admit } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const O = person('u_o'), M = person('u_m'), G = person('u_g');
const T = todayKst(), Y = T.slice(0, 4);

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  const master = new MasterAgent(store, spaces, plans), briefs = new Briefs(store, spaces);
  const id = (await spaces.create(O, '시범 팀')).id;
  await admit(spaces, O, id, 'u_m', 'member');
  await admit(spaces, O, id, 'u_g', 'guest', [`${Y}:1.1`]);
  await spaces.proposeCharter(O, id, ['에이전트는 제안하고 사람은 승인한다.'], '');
  await spaces.consentCharter(M, id, 1, true);
  for (const [u, n] of [['u_o', '오너'], ['u_m', '멤버엠']]) await store.putSecret(u, 'profile', { name: n });
  await plans.put(O, id, { items: [{ code: '1', scope: '출시 준비', status: '진행 중', accountable: 'u_m' }, { code: '1.1', scope: '결제 연동', status: '진행 중' },
    { code: '2', scope: '고객 인터뷰', status: '진행 중' }] });
  const ta: Caller = { kind: 'team_agent', space: id, client: 'Claude', clientId: 'c_master' };
  return { store, spaces, plans, master, briefs, id, ta };
}

test('A on plan items: one owner or member, inherited by children, the owner when none', async () => {
  const { plans, id } = await team();
  assert.equal(await outcome(plans.put(O, id, { items: [{ code: '2', accountable: 'u_g' }] })), 'invalid', 'a guest cannot be A');
  assert.equal(await outcome(plans.put(O, id, { items: [{ code: '2', accountable: 'u_nobody' }] })), 'invalid', 'nor someone outside the team');
  await plans.put(O, id, { items: [{ code: '2', accountable: 'u_o' }] });
  const items = (await plans.list(O, id)).items as { code: string; accountable?: string; log: { change: string }[] }[];
  assert.equal(items.find(i => i.code === '2')!.accountable, 'u_o');
  assert.match(items.find(i => i.code === '2')!.log.at(-1)!.change, /^A 없음 → u_o/);
  await plans.put(O, id, { items: [{ code: '2', accountable: '' }] });
  assert.equal(((await plans.list(O, id)).items as { code: string; accountable?: string }[]).find(i => i.code === '2')!.accountable, undefined, '"" clears it');
});

test('proposals: only the team agent proposes, checked as a write; the A of every touched item approves; applied as their write', async () => {
  const { master, plans, id, ta } = await team();
  assert.equal(await outcome(master.propose(O, id, { items: [{ code: '2', status: '완료' }], why: '사람은 직접 고친다는 확인' })), 'forbidden', 'people write the plan themselves');
  assert.equal(await outcome(master.propose(ta, id, { items: [{ code: '9.1', scope: '부모 없음' }], why: '부모 없는 항목을 제안해 본다' })), 'invalid', 'checked as a write would be');
  assert.equal(await outcome(master.propose(ta, id, { items: [{ code: '1', accountable: 'u_o' } as never], why: 'A를 바꾸려 해 본다 — 사람만 정한다' })), 'invalid', 'A is not the agent\'s to propose (nothing left to change)');

  const p = await master.propose(ta, id, { items: [{ code: '1.1', status: '완료' }, { code: '2.1', scope: '인터뷰 질문지' }], why: '결제 연동 행이 모두 완료, 인터뷰 준비 항목이 없음', refs: [`${Y} 1.1`] });
  assert.deepEqual(p.preview.map(v => [v.code, v.created, v.changes]), [['1.1', false, ['상태 진행 중 → 완료']], ['2.1', true, ['생성: 인터뷰 질문지']]]);
  assert.equal(p.approvers, 2, '1.1 inherits A from 1 (u_m); 2.1 has none, so the owner');
  assert.equal((await master.propose(ta, id, { items: [{ code: '1.1', status: '완료' }, { code: '2.1', scope: '인터뷰 질문지' }], why: '같은 제안을 한 번 더 보낸다' })).id, p.id, 'a retry does not duplicate');

  assert.equal(await outcome(master.decide(G, id, p.id, true)), 'forbidden', 'a guest');
  assert.equal(await outcome(master.decide(agent('u_m', 'Claude', ['wbs.read', 'wbs.write']), id, p.id, true)), 'forbidden', 'an agent never approves');
  assert.equal(await outcome(master.decide(ta, id, p.id, true)), 'forbidden');
  assert.deepEqual(await master.decide(M, id, p.id, true, '좋습니다'), { space: id, id: p.id, status: 'open', waiting: 1 });
  assert.equal(await outcome(master.decide(M, id, p.id, true)), 'invalid', 'once');
  const done = await master.decide(O, id, p.id, true);
  assert.deepEqual([done.status, (done as { changed: string[] }).changed], ['applied', [`${Y} 1.1`, `${Y} 2.1`]]);
  const items = (await plans.list(O, id)).items as { code: string; status: string; log: { by: string; change: string }[] }[];
  assert.equal(items.find(i => i.code === '1.1')!.status, '완료');
  assert.match(items.find(i => i.code === '2.1')!.log[0].change, /^생성 — 팀 마스터 에이전트\(Claude\) 제안 p_/);
  assert.equal(items.find(i => i.code === '2.1')!.log[0].by, 'u_o', 'the last approver\'s write');

  // one decline closes it; a plan that moved meanwhile makes it stale
  const d = await master.propose(ta, id, { items: [{ code: '1', status: '완료' }], why: '하위 항목이 모두 끝나 상위도 닫자' });
  assert.equal((await master.decide(M, id, d.id, false, '아직 출시 전')).status, 'declined');
  const s = await master.propose(ta, id, { items: [{ code: '2', status: '대기·심사' }], why: '인터뷰 일정 확정을 기다리는 중' });
  await plans.put(O, id, { items: [{ code: '2', due: `${Y}-12-31` }] });
  assert.equal((await master.decide(O, id, s.id, true)).status, 'stale');
  const listed = await master.list(ta, id) as { proposals: { id: string; status: string }[] };
  assert.deepEqual(listed.proposals.map(x => x.status), ['applied', 'declined', 'stale'], 'the agent sees how its proposals were decided');
});

test('the weekly report: an ended week, about the work and naming no one, the owner approves it, then the team reads it beside the brief', async () => {
  const { master, briefs, id, ta } = await team();
  const last = lastFullWeek(T);
  const text = '지난주 결제 연동이 끝났고 인터뷰 준비 항목이 비어 있었다. 이번 주 7일 안 마감은 없다. 출시 의도 쪽 작업 비중이 높아 인터뷰 의도가 밀린다.';
  assert.equal(await outcome(master.proposeReport(ta, id, { week: isoWeek(T).week, text })), 'invalid', 'the week has not ended');
  assert.equal(await outcome(master.proposeReport(ta, id, { text: text + ' 멤버엠이 잘했다.' })), 'invalid', 'it names a person');
  assert.equal(await outcome(master.proposeReport(ta, id, { text: text + ' u_m 담당.' })), 'invalid', 'an account id is a person too');
  assert.equal(await outcome(master.proposeReport(O, id, { text })), 'forbidden', 'the agent drafts, people approve');
  assert.deepEqual(await master.proposeReport(ta, id, { text, recommendations: [{ text: '인터뷰 질문지 항목을 계획에 넣기', refs: [`${Y} 2`] }] }),
    { space: id, week: last.week, status: 'proposed', note: 'The team sees it once the owner approves it' });
  assert.equal((await briefs.weekly(M, id)).report, null, 'not before the owner approves');
  assert.deepEqual((await master.list(M, id) as { drafts: unknown[] }).drafts, [], 'members do not see drafts');
  assert.equal((await master.list(O, id) as { drafts: unknown[] }).drafts.length, 1);
  assert.equal(await outcome(master.decideReport(M, id, last.week, true)), 'forbidden', 'the owner approves');
  assert.equal((await master.decideReport(O, id, last.week, true, '그대로 공유')).status, 'approved');
  const w = await briefs.weekly(M, id);
  assert.deepEqual([w.report?.text, w.report?.by_agent, w.report?.recommendations.length], [text, 'Claude', 1]);
  assert.equal(await outcome(master.proposeReport(ta, id, { text })), 'duplicate', 'an approved week stays as it was');
  assert.equal(await outcome(master.decideReport(O, id, last.week, true)), 'invalid');
});

// ---------------------------------------------------------------- end to end: delegation, the agent's own server, stopping
async function boot() {
  const store = new MemoryStore(), srv = http.createServer(); await new Promise<void>(r => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const cfg = loadConfig({ HUB_PUBLIC_URL: base, HUB_DEV_LOGIN: '1' } as NodeJS.ProcessEnv), issuer = await TokenIssuer.create(cfg.publicUrl, 3600);
  srv.on('request', createApp(cfg, store, issuer, devVerifier()));
  return { base, store, issuer, close: () => new Promise<void>(r => srv.close(() => r())) };
}
const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function authorize(base: string, uid: string, resource: string, clientName = 'Claude Team Master') {
  const redirect = 'http://localhost:9999/cb';
  const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  const clientId = (await reg.json()).client_id as string, { v, c } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: c, code_challenge_method: 'S256', scope: 'wbs.read wbs.write', state: 's', resource });
  const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  const req = /name="req" value="([^"]+)"/.exec(page)![1];
  const ok = await fetch(`${base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, id_token: `dev:${uid}`, decision: 'allow' }) });
  const back = new URL(ok.headers.get('location')!);
  if (back.searchParams.get('error')) return { error: back.searchParams.get('error')!, page };
  const tok = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: clientId, code_verifier: v, resource }) });
  return { clientId, page, ...(await tok.json()) as { access_token: string; refresh_token: string; error?: string } };
}
const mcpAt = async (base: string, token: string, path: string) => {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

test('delegation end to end: owner-only consent, the agent\'s own tools, nothing else opens, approvals on the page, stopped at once', async () => {
  const { base, store, issuer, close } = await boot();
  const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
  const sign = async (uid: string) => (await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) })).headers.get('set-cookie')!.split(';')[0];
  const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.message || j.error), { status: r.status }); return j;
  };
  try {
    const co = await sign('u_o'), cm = await sign('u_m'), o = call(co), m = call(cm);
    const s = await o('POST', '/app/api/spaces', { name: '시범 팀' });
    const inv = await o('POST', `/app/api/t/${s.id}/invites`, { role: 'member', for: 'u_m' });
    await m('POST', '/app/api/join', { space: s.id, invite: inv.id });
    await o('POST', `/app/api/t/${s.id}/charter/propose`, { lines: ['에이전트는 제안하고 사람은 승인한다.'], note: '' });
    await m('POST', `/app/api/t/${s.id}/charter/consent`, { version: 1, agree: true });
    const plans = new Plans(store, new Spaces(store));
    await plans.put(O, s.id, { items: [{ code: '1', scope: '출시 준비', status: '진행 중', accountable: 'u_m' }] });
    const addr = `${base}/mcp/t/${s.id}/agent`;
    assert.equal((await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/t/${s.id}/agent`)).json()).resource, addr);
    assert.equal((await fetch(addr, { method: 'POST' })).status, 401);

    const denied = await authorize(base, 'u_m', addr);
    assert.equal(denied.error, 'access_denied', 'a member cannot delegate the team\'s master agent');
    assert.match(denied.page, /팀 마스터 에이전트 위임입니다/);
    const g = await authorize(base, 'u_o', addr) as { clientId: string; access_token: string; refresh_token: string };
    assert.ok(g.access_token);
    const c = await mcpAt(base, g.access_token, `/mcp/t/${s.id}/agent`);
    assert.deepEqual((await c.listTools()).tools.map(t => t.name).sort(), ['wbs_charter', 'wbs_plan', 'wbs_proposals', 'wbs_propose', 'wbs_team', 'wbs_weekly']);
    const t = json(await c.callTool({ name: 'wbs_team', arguments: {} }));
    assert.deepEqual([t.space.role, t.members, t.agent], ['delegate', null, { open: 0, last_report: null }]);
    const p = json(await c.callTool({ name: 'wbs_propose', arguments: { kind: 'plan', items: [{ code: '1', status: '대기·심사' }], why: '외부 심사를 기다리는 행만 남음' } }));
    assert.equal(p.status, 'open');

    // its token opens nothing else, and no other token opens its address
    for (const path of ['/mcp', `/mcp/t/${s.id}`]) assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${g.access_token}`, 'content-type': 'application/json' }, body: '{}' })).status, 401, path);
    const own = (await issuer.access('u_o', 'c1', 'Claude', 'wbs.read wbs.write', base)).token;
    assert.equal((await fetch(addr, { method: 'POST', headers: { authorization: `Bearer ${own}`, 'content-type': 'application/json' }, body: '{}' })).status, 401, 'the owner\'s hub-wide token is not the team agent');

    // the team page shows it; A approves on the page; the agent sees the outcome
    const tp = await (await fetch(`${base}/app/t/${s.id}`, { headers: { cookie: cm } })).text();
    assert.match(tp, /팀 마스터 에이전트[\s\S]*Claude Team Master[\s\S]*승인할 것 1건/);
    assert.match(await (await fetch(`${base}/app/t/${s.id}/agent`, { headers: { cookie: cm } })).text(), /외부 심사를 기다리는 행만 남음/);
    await assert.rejects(o('POST', `/app/api/t/${s.id}/proposals/${p.id}/decide`, { approve: true }), (e: { status: number }) => e.status === 403, 'not the owner\'s to decide: A is the member');
    assert.equal((await m('POST', `/app/api/t/${s.id}/proposals/${p.id}/decide`, { approve: true })).status, 'applied');
    assert.deepEqual(json(await c.callTool({ name: 'wbs_proposals', arguments: {} })).proposals.map((x: { status: string }) => x.status), ['applied']);

    // stopping: members cannot; the owner can, and the very next call is refused, the grant gone
    await assert.rejects(m('POST', `/app/api/t/${s.id}/agent/stop`, { client_id: g.clientId }), (e: { status: number }) => e.status === 403);
    await o('POST', `/app/api/t/${s.id}/agent/stop`, { client_id: g.clientId });
    await assert.rejects(c.callTool({ name: 'wbs_team', arguments: {} }));
    const rt = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: g.clientId }) });
    assert.equal(rt.status, 400);
    assert.doesNotMatch(await (await fetch(`${base}/app/t/${s.id}`, { headers: { cookie: co } })).text(), /Claude Team Master/, 'no longer listed as acting for the team');
  } finally { await close(); }
});
