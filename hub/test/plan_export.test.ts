// The team plan as the team's own CSV copy (execution WBS 3.10; decision 6, intent 4: the hub holds the original, a CSV
// replica lives where the team chooses). One row per item in code order with its actual work, a BOM and CRLF like the
// ledger's files, a manifest whose sha and bytes match the file; what each caller's plan view holds and no more; the
// charter gate; and the three ways out: wbs_plan view csv, REST, and the hub's own page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { Ledger, LedgerError } from '../src/wbs/service.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { parseCsv } from '../src/wbs/model.js';
import { person, type Caller } from '../src/wbs/access.js';
import { admit, boot, connect, json, mcp } from './support.js';

const outcome = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof LedgerError) return e.code; throw e; } };
const A = person('u_a'), B = person('u_b'), G = person('u_g'), X = person('u_x');
const HEAD = ['연도', '코드', '스콥', '산출물', '완료 기준', '선행', '담당', '의도', '계획 상태', '시작 예정', '마감', '실적 행', '실적 완료', '실적 상태', '실적 시작', '실적 끝', '최근 진행일', '마감 대비(일)', '표시'];

async function team() {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces), ledger = new Ledger(store);
  const s = await spaces.create(A, '창업 팀'), id = s.id;
  await admit(spaces, A, id, 'u_b', 'member');
  await admit(spaces, A, id, 'u_g', 'guest', ['2026:2.1']);   // a guest's project: a level-2 item and what is under it
  await spaces.proposeCharter(A, id, ['팀 작업은 기본 공개다.']);
  await spaces.consentCharter(B, id, 1, true);
  await plans.put(A, id, { intents: [{ why: '첫 고객을 붙잡는다', what: '결제까지 되는 시범' }], items: [
    { code: '1', year: '2026', scope: '출시 준비', owners: ['제품'], intent: 'i1', status: '진행 중', start: '2026-11-01', due: '2026-11-10' },
    { code: '1.1', year: '2026', scope: '결제 붙이기, "PG" 심사', deliverable: '심사 통과 메일', done: '실결제 1건', owners: ['한유진', 'Claude'], depends_on: ['1.2'], status: '진행 중', due: '2026-11-15' },
    { code: '1.2', year: '2026', scope: '약관', status: '완료', due: '2026-11-05' },
    { code: '10', year: '2026', scope: '두 자리 코드는 뒤로', status: '백로그' },
    { code: '2', year: '2026', scope: '자문', intent: 'i1', status: '진행 중' },
    { code: '2.1', year: '2026', scope: '게스트 프로젝트', owners: ['자문'], status: '진행 중' },
  ] });
  const { created: row } = await ledger.add({ uid: 'u_b', clientName: 'Claude' }, { area: '4 창업·제품', package: '4.3 서비스 개발', task: 'PG 심사 서류 제출', start: '2026-11-03', status: '진행 중' });
  await plans.share(B, { year: row.year, code: row.code, space: id, plan: '1.1' });
  return { spaces, plans, id };
}
const read = (csv: string) => { assert.equal(csv.charCodeAt(0), 0xfeff, 'a BOM, as the ledger files'); assert.match(csv, /\r\n$/); return parseCsv(csv.slice(1)); };

test('the plan as plan.csv: items in code order with their actual work, and a manifest that matches the file', async () => {
  const { plans, id } = await team();
  const out = await plans.exportCsv(A, id);
  const [head, ...rows] = read(out.csv);
  assert.deepEqual(head, HEAD);
  assert.deepEqual(rows.map(r => r[1]), ['1', '1.1', '1.2', '2', '2.1', '10'], 'code order, numerically');
  const r11 = rows[1];
  assert.deepEqual([r11[2], r11[3], r11[4], r11[5], r11[6]], ['결제 붙이기, "PG" 심사', '심사 통과 메일', '실결제 1건', '1.2', '한유진, Claude'], 'quotes and commas survive');
  assert.equal(r11[7], 'i1 첫 고객을 붙잡는다', 'the inherited intent, with its why');
  assert.deepEqual([r11[11], r11[12], r11[13], r11[14]], ['1', '0', '진행 중', '2026-11-03'], 'the shared row counts as its actual work');
  assert.equal(rows[0][11], '1', 'a parent counts the work under it');
  assert.equal(rows[2][17], '', 'done, with no work behind it: no end to measure against the due date');
  assert.equal(rows[4][7], 'i1 첫 고객을 붙잡는다', 'inherited from its parent');
  assert.equal(rows[5][7], '', 'no intent, no label');
  assert.equal(out.manifest.rows, 6); assert.equal(out.manifest.source, 'hub'); assert.equal(out.manifest.file, 'plan.csv');
  assert.equal(out.manifest.bytes, Buffer.byteLength(out.csv, 'utf8'));
  assert.equal(out.manifest.sha, createHash('sha256').update(out.csv, 'utf8').digest('hex').slice(0, 16));
  assert.ok(!Number.isNaN(Date.parse(out.manifest.at)));
  const y = await plans.exportCsv(A, id, '2027');
  assert.equal(y.manifest.rows, 0); assert.equal(y.manifest.year, '2027', 'one plan year, and the manifest says which');
  assert.deepEqual(read(y.csv), [HEAD]);
});

test('each caller gets what its plan view holds: a guest its projects without intents, the team agent the whole plan; the gate holds', async () => {
  const { spaces, plans, id } = await team();
  const [, ...g] = read((await plans.exportCsv(G, id)).csv);
  assert.deepEqual(g.map(r => r[1]), ['2.1'], 'a guest: its project only');
  assert.equal(g[0][7], '', 'no intents for a guest, even an inherited one');
  const T: Caller = { kind: 'team_agent', space: id, client: 'team-master' };
  assert.equal((await plans.exportCsv(T, id)).manifest.rows, 6, 'the team agent reads the plan');
  assert.equal(await outcome(plans.exportCsv(X, id)), 'not_found');
  const s2 = await spaces.create(A, '헌장 전 팀');
  assert.equal(await outcome(plans.exportCsv(A, s2.id)), 'consent_required', 'before the charter, no plan to copy');
});

test('three ways out: wbs_plan view csv over MCP, REST, and the hub\'s own page for people (after the charter)', async () => {
  const { base, store, close } = await boot();
  try {
    const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
    const sign = async (uid: string) => (await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) })).headers.get('set-cookie')!.split(';')[0];
    const cookie = await sign('u_o');
    const as = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await (await as('POST', '/app/api/spaces', { name: '시범 팀' })).json();
    assert.doesNotMatch(await (await as('GET', `/app/t/${t.id}`)).text(), /plan\.csv 내려받기/, 'no copy before the charter is in force');
    assert.equal((await as('GET', `/app/t/${t.id}/plan.csv`)).status, 409);
    const plans = new Plans(store, new Spaces(store));
    await new Spaces(store).proposeCharter(person('u_o'), t.id, ['팀 작업은 기본 공개다.']);
    await plans.put(person('u_o'), t.id, { items: [{ code: '1', year: '2026', scope: '첫 계획 항목', status: '진행 중' }] });

    assert.match(await (await as('GET', `/app/t/${t.id}`)).text(), /plan\.csv 내려받기/);
    const page = await as('GET', `/app/t/${t.id}/plan.csv`);
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type') || '', /text\/csv/);
    assert.match(page.headers.get('content-disposition') || '', /attachment; filename="plan.csv"/);
    assert.match(await page.text(), /첫 계획 항목/);

    const conn = await connect(base, { uid: 'u_o', resource: `${base}/v1` });
    const rest = await fetch(`${base}/v1/plan?view=csv&space=${t.id}`, { headers: { authorization: `Bearer ${conn.access_token}` } });
    assert.equal(rest.status, 200);
    const j = await rest.json();
    assert.equal(j.file, 'plan.csv'); assert.equal(j.manifest.rows, 1); assert.match(j.csv, /첫 계획 항목/);
    assert.equal(j.manifest.sha, createHash('sha256').update(j.csv, 'utf8').digest('hex').slice(0, 16));
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.ok(spec.paths['/plan'].get.parameters.some((p: { name: string; schema?: { enum?: string[] } }) => p.name === 'view' && p.schema?.enum?.includes('csv')));

    const viaMcp = await mcp(base, (await connect(base, { uid: 'u_o' })).access_token);
    const m = json(await viaMcp.callTool({ name: 'wbs_plan', arguments: { space: t.id, view: 'csv' } }));
    await viaMcp.close();
    assert.equal(m.manifest.rows, 1); assert.equal(m.manifest.bytes, Buffer.byteLength(m.csv, 'utf8'));
    const anon = await fetch(`${base}/app/t/${t.id}/plan.csv`);   // no session: the sign-in page, never the plan
    assert.match(anon.headers.get('content-type') || '', /text\/html/);
    assert.doesNotMatch(await anon.text(), /첫 계획 항목/);
    const other = await fetch(`${base}/app/t/${t.id}/plan.csv`, { headers: { cookie: await sign('u_x') } });
    assert.equal(other.status, 404, 'someone outside the team is told it does not exist');
  } finally { await close(); }
});
