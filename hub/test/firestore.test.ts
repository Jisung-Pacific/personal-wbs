// The Firestore store against the emulator (skipped unless FIRESTORE_EMULATOR_HOST is set), checking what the memory
// store cannot prove: transactions that allocate codes under contention, history order, single-use codes and requests.
// run: firebase emulators:exec --only firestore "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test dist/test/firestore.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStore } from '../src/store/firestore.js';
import { LocalKek } from '../src/crypto/envelope.js';
import { randomBytes } from 'node:crypto';
import { Ledger } from '../src/wbs/service.js';

const on = !!process.env.FIRESTORE_EMULATOR_HOST;

test('Firestore store: concurrent adds get distinct codes; history keeps its order; codes are single use', { skip: !on }, async () => {
  const store = new FirestoreStore('demo-ppwbs', 'ppwbs', new LocalKek(randomBytes(32))), ledger = new Ledger(store), uid = 'u_' + Date.now();
  const actor = { uid, clientName: 'Claude' };
  await ledger.add(actor, { area: '5 대외·경력', package: '5.3 기타 소프트웨어 구축', task: '첫 작업 기록 테스트', start: '2026-11-06', status: '완료' });
  const words = ['알파 베타 감마', '델타 엡실론 제타', '에타 세타 이오타', '카파 람다 뮤', '뉴 크시 오미크론'];
  const made = await Promise.all(words.map(w => ledger.add(actor, { package: '5.3', task: `${w} 작업`, start: '2026-11-06', status: '진행 중' })));
  const codes = made.map(m => m.created.code).sort();
  assert.equal(new Set(codes).size, 5, 'no two adds share a code');
  assert.deepEqual(codes, ['5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6']);
  await ledger.update(actor, { year: '2026', code: '5.3.2', status: '완료' });
  const hist = await store.events(uid, '2026', '5.3.2');
  assert.deepEqual(hist.map(e => e.event), ['생성', '상태']);
  await store.putCode({ hash: 'h1', client_id: 'c', client_name: 'Claude', redirect_uri: 'https://x/cb', code_challenge: 'x', scope: 'wbs.read', resource: 'r', uid, expires_at: Date.now() + 60e3 });
  assert.ok(await store.takeCode('h1')); assert.equal(await store.takeCode('h1'), null);
  await store.putRefresh({ hash: 'r1', family: 'f', client_id: 'c', client_name: 'Claude', uid, scope: 'wbs.read', resource: 'r', expires_at: Date.now() + 60e3, used: false });
  assert.equal((await store.useRefresh('r1'))!.used, false); assert.equal((await store.useRefresh('r1'))!.used, true);
  await store.revokeFamily('f'); assert.equal(await store.useRefresh('r1'), null);
});
