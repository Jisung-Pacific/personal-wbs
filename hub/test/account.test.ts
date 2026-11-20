// Deleting an account (execution WBS 5.4): the ownership rule and the plan shown first; what leaves with the person
// (their delegations, their shared rows frozen or removed); the tombstone that stops every token and session issued
// before it — an agent's access and refresh tokens and another device's session — while a later sign-in starts a fresh
// account; and the hub's own pages: the export, the typed phrase, handing a team over and deleting it by its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import type { RefreshRecord } from '../src/store/types.js';
import { Spaces } from '../src/wbs/spaces.js';
import { Plans } from '../src/wbs/plan.js';
import { Cards } from '../src/wbs/cards.js';
import { MasterAgent } from '../src/wbs/master.js';
import { LedgerError } from '../src/wbs/service.js';
import { person } from '../src/wbs/access.js';
import { Revocations } from '../src/auth/revocations.js';
import { admit, boot, connect, form } from './support.js';

const A = person('u_a');
const refresh = (hash: string, family: string, uid: string): RefreshRecord =>
  ({ hash, family, client_id: 'c1', client_name: 'Claude', uid, scope: 'wbs.read', resource: 'https://hub/mcp/t/x/agent', expires_at: Date.now() + 864e5, used: false });

test('the ownership rule first, then the person leaves with their delegations and (by choice) their shared rows', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  new Cards(store, spaces); new MasterAgent(store, spaces, plans);   // their hooks run when a person leaves a space
  const t = await spaces.create(A, '팀'), solo = await spaces.create(A, '혼자 쓰는 팀');
  await admit(spaces, A, t.id, 'u_b', 'member');
  await store.putDelegation(t.id, { client_id: 'c1', client_name: 'Claude', by: 'u_a', at: Date.now(), active: true, family: 'fam1' });
  await store.putRefresh(refresh('h1', 'fam1', 'u_a'));
  await store.putShared(t.id, { id: 'w1', uid: 'u_a', plan: '2026:1', fields: { title: '공유한 행' }, at: Date.now() });

  // the plan the page shows: the solo team goes, the shared one blocks until it is handed over
  assert.deepEqual(await spaces.deletionPlan('u_a'), { deletes: [solo.id], leaves: [], blocks: [{ id: t.id, people: 1 }] });
  const refused = await spaces.deleteAccount('u_a').then(() => null, e => e as LedgerError);
  assert.equal(refused?.code, 'invalid'); assert.deepEqual((refused?.detail as { blocks: unknown[] }).blocks, [{ id: t.id, people: 1 }]);
  assert.equal(await store.deletedAt('u_a'), null, 'a refused deletion leaves no tombstone');
  assert.ok(await store.space(solo.id), 'and removes nothing');

  await spaces.transfer(A, t.id, 'u_b');
  assert.deepEqual(await spaces.deletionPlan('u_a'), { deletes: [solo.id], leaves: [{ id: t.id, role: 'member' }], blocks: [] });
  const out = await spaces.deleteAccount('u_a', { now: 1_000_000 });
  assert.deepEqual(out, { deleted: true, at: 1_000_000, spaces_deleted: 1, spaces_left: 1, shared_removed: 0 });
  assert.equal(await store.deletedAt('u_a'), 1_000_000);
  assert.equal(await store.space(solo.id), null);
  assert.equal(await store.membership(t.id, 'u_a'), null);
  const d = (await store.delegations(t.id))[0];
  assert.equal(d.active, false); assert.equal(d.stopped?.by, 'u_a'); assert.equal(d.family, undefined);
  assert.equal(await store.useRefresh('h1'), null, 'the delegation\'s grant is revoked');
  assert.ok((await store.shared(t.id)).find(w => w.id === 'w1')?.frozen, 'by default a shared row stays as a frozen copy');

  // with the choice, the shared rows go too
  const t2 = await spaces.create(person('u_b'), '둘째 팀');
  await admit(spaces, person('u_b'), t2.id, 'u_c', 'member');
  await store.putShared(t2.id, { id: 'w2', uid: 'u_c', plan: '2026:1', fields: { title: '지울 행' }, at: Date.now() });
  assert.equal((await spaces.deleteAccount('u_c', { withShared: true })).shared_removed, 1);
  assert.deepEqual((await store.shared(t2.id)).map(w => w.id), []);
  assert.equal(await store.membership(t2.id, 'u_c'), null);
});

test('an ex-owner who leaves a team ends the delegations they made there', async () => {
  const store = new MemoryStore(), spaces = new Spaces(store), plans = new Plans(store, spaces);
  new MasterAgent(store, spaces, plans);
  const t = await spaces.create(A, '팀');
  await admit(spaces, A, t.id, 'u_b', 'member');
  await store.putDelegation(t.id, { client_id: 'c1', client_name: 'Claude', by: 'u_a', at: Date.now(), active: true, family: 'fam1' });
  await store.putRefresh(refresh('h1', 'fam1', 'u_a'));
  await spaces.transfer(A, t.id, 'u_b');
  assert.equal((await store.delegations(t.id))[0].active, true, 'handing over alone keeps it: the new owner may stop it');
  await spaces.removeMember(A, t.id, 'u_a');
  assert.equal((await store.delegations(t.id))[0].active, false);
  assert.equal(await store.useRefresh('h1'), null);
});

test('revocations: credentials issued before the deletion stop, later ones pass; one read per account per window', async () => {
  const store = new MemoryStore();
  let reads = 0, now = 10_000_000;
  const read = store.deletedAt.bind(store);
  store.deletedAt = async (uid: string) => { reads++; return read(uid); };
  const here = new Revocations(store, () => now);
  assert.equal(await here.revoked('u_a', 9_000), false);
  assert.equal(await here.revoked('u_a', 9_000), false); assert.equal(reads, 1, 'answered from memory within the window');
  await store.markDeleted('u_a', 10_000_500);
  here.note('u_a', 10_000_500);   // the instance that deleted the account knows at once
  assert.equal(await here.revoked('u_a', 10_000), true, 'issued in the second before');
  assert.equal(await here.revoked('u_a', 10_001), false, 'issued after');
  assert.equal(await here.revoked('u_a', Number.NaN), true, 'no readable iat counts as before');
  const other = new Revocations(store, () => now);   // another instance asks the store
  assert.equal(await other.revoked('u_a', 9_999), true);
  now += 31_000; reads = 0;
  assert.equal(await here.revoked('u_b', 1), false); assert.equal(reads, 1);
});

const H = { 'x-ppwbs': '1', 'content-type': 'application/json' };
async function signIn(base: string, uid: string) {
  const r = await fetch(`${base}/app/session`, { method: 'POST', headers: H, body: JSON.stringify({ id_token: `dev:${uid}` }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0];
}
const call = (base: string, cookie: string) => (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

test('deleting an account on the hub: the export first, the typed phrase, then every earlier token and session refused', async () => {
  const { base, store, close } = await boot();
  try {
    const one = await signIn(base, 'u_a'), two = await signIn(base, 'u_a');   // two devices
    const a = call(base, one);
    const solo = await (await a('POST', '/app/api/spaces', { name: '혼자 쓰는 팀' })).json();
    const conn = await connect(base, { uid: 'u_a', resource: `${base}/v1` });
    const bearer = { authorization: `Bearer ${conn.access_token}`, 'content-type': 'application/json' };
    const add = await fetch(`${base}/v1/rows`, { method: 'POST', headers: bearer, body: JSON.stringify({ area: '4 창업·제품', package: '4.3 서비스 개발', task: '지워질 행', start: '2026-11-20', status: '진행 중' }) });
    assert.ok(add.ok, await add.clone().text());

    // the person's own ledger, as files, from the page
    const csv = await fetch(`${base}/app/export/wbs.csv`, { headers: { cookie: one } });
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') || '', /attachment; filename="wbs.csv"/);
    assert.match(await csv.text(), /지워질 행/);
    assert.equal((await fetch(`${base}/app/export/secrets.json`, { headers: { cookie: one } })).status, 404);
    const page = await (await fetch(`${base}/app/account`, { headers: { cookie: one } })).text();
    assert.match(page, /함께 지워지는 팀/); assert.match(page, /혼자 쓰는 팀/); assert.match(page, /계정 삭제/);
    assert.match(await (await fetch(`${base}/app`, { headers: { cookie: one } })).text(), /href="\/app\/account"/);

    // only the typed phrase deletes; an agent's token cannot reach the page's API at all
    assert.equal((await a('POST', '/app/api/account/delete', { confirm: '삭제' })).status, 400);
    assert.equal((await fetch(`${base}/app/api/account/delete`, { method: 'POST', headers: { ...H, authorization: bearer.authorization }, body: JSON.stringify({ confirm: '계정 삭제' }) })).status, 401);
    const del = await a('POST', '/app/api/account/delete', { confirm: '계정 삭제' });
    assert.equal(del.status, 200);
    assert.deepEqual({ ...(await del.json()), at: 0 }, { deleted: true, at: 0, spaces_deleted: 1, spaces_left: 0, shared_removed: 0 });
    assert.match(del.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(await store.space(solo.id), null);

    // what was issued before is refused: the agent's access token, its refresh token, the other device's session
    assert.equal((await fetch(`${base}/v1/export`, { headers: bearer })).status, 401);
    const re = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: conn.refresh_token, client_id: conn.clientId }) });
    assert.equal(re.status, 400);
    const other = await fetch(`${base}/app`, { headers: { cookie: two } });
    assert.match(await other.text(), /개발용 로그인/); assert.match(other.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal((await call(base, two)('POST', '/app/api/spaces', { name: '되살리기' })).status, 401);
    assert.deepEqual(await store.rows('u_a'), []);

    // a later sign-in with the same identity starts a fresh, empty account (issued after the tombstone)
    await new Promise(r => setTimeout(r, 1100));
    const three = await signIn(base, 'u_a');
    const fresh = await fetch(`${base}/app/export/wbs.csv`, { headers: { cookie: three } });
    assert.equal(fresh.status, 200); assert.doesNotMatch(await fresh.text(), /지워질 행/);
    const again = await connect(base, { uid: 'u_a', resource: `${base}/v1`, clientId: conn.clientId });
    assert.equal((await fetch(`${base}/v1/export`, { headers: { authorization: `Bearer ${again.access_token}` } })).status, 200);
  } finally { await close(); }
});

test('an owner hands a team over or deletes it by its name on the team page; then the account can go', async () => {
  const { base, store, close } = await boot();
  try {
    const o = call(base, await signIn(base, 'u_o')), m = call(base, await signIn(base, 'u_m'));
    const t = await (await o('POST', '/app/api/spaces', { name: '결제 팀' })).json();
    const inv = await (await o('POST', `/app/api/t/${t.id}/invites`, { role: 'member', for: 'u_m' })).json();
    assert.equal((await m('POST', '/app/api/join', { space: t.id, invite: inv.id })).status, 200);

    // the shared team blocks the owner's deletion, and the page says which team and what to do
    const blocked = await o('POST', '/app/api/account/delete', { confirm: '계정 삭제' });
    assert.equal(blocked.status, 400); assert.equal((await blocked.json()).detail.blocks[0].id, t.id);
    assert.match(await (await o('GET', '/app/account')).text(), /먼저 정리할 팀/);
    const tp = await (await o('GET', `/app/t/${t.id}`)).text();
    assert.match(tp, /소유자 넘기기/); assert.match(tp, /팀 삭제/);
    assert.doesNotMatch(await (await m('GET', `/app/t/${t.id}`)).text(), /소유자 넘기기/, 'a member has neither');

    // a wrong name deletes nothing; a member cannot delete the team or take it
    assert.equal((await o('POST', `/app/api/t/${t.id}/delete`, { name: '결제' })).status, 400);
    assert.equal((await m('POST', `/app/api/t/${t.id}/delete`, { name: '결제 팀' })).status, 403);
    assert.equal((await m('POST', `/app/api/t/${t.id}/transfer`, { to: 'u_m' })).status, 403);
    assert.ok(await store.space(t.id));

    // handed over, the account goes and the team stays with its new owner, who may then delete it by name
    assert.equal((await o('POST', `/app/api/t/${t.id}/transfer`, { to: 'u_m' })).status, 200);
    const gone = await o('POST', '/app/api/account/delete', { confirm: '계정 삭제' });
    assert.equal(gone.status, 200); assert.equal((await gone.json()).spaces_left, 1);
    assert.equal((await store.membership(t.id, 'u_m'))?.role, 'owner');
    assert.equal(await store.membership(t.id, 'u_o'), null);
    assert.equal((await m('POST', `/app/api/t/${t.id}/delete`, { name: '결제 팀' })).status, 200);
    assert.equal(await store.space(t.id), null);
    assert.match(await (await m('GET', `/app/t/${t.id}`)).text(), /찾을 수 없습니다/);
  } finally { await close(); }
});
