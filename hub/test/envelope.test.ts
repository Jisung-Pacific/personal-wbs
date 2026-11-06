// The encryption layer on its own: sealing round trips, every value is bound to its account and place, data keys are made
// once per account even under concurrent first requests, wrapped keys survive a restart, KMS calls carry the account in
// their authenticated data, and shredding makes old ciphertext unreadable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Envelope, KmsKek, LocalKek, MemoryDekStore, gcmOpen, gcmSeal, type AuthorizedHttp } from '../src/crypto/envelope.js';

test('AES-256-GCM: round trip; wrong AAD, key or a flipped bit fail', () => {
  const k = randomBytes(32), s = gcmSeal(k, Buffer.from('작업 원장'), 'u1|rows/2026_1.1.1');
  assert.equal(gcmOpen(k, s, 'u1|rows/2026_1.1.1').toString(), '작업 원장');
  assert.throws(() => gcmOpen(k, s, 'u2|rows/2026_1.1.1'));
  assert.throws(() => gcmOpen(randomBytes(32), s, 'u1|rows/2026_1.1.1'));
  const ct = Buffer.from(s.ct, 'base64'); ct[0] ^= 1;
  assert.throws(() => gcmOpen(k, { ...s, ct: ct.toString('base64') }, 'u1|rows/2026_1.1.1'));
});

test('Envelope: one data key per account, bound to the account and the place, and nothing readable in storage', async () => {
  const keys = new MemoryDekStore(), env = new Envelope(new LocalKek(randomBytes(32)), keys);
  const row = { year: '2026', code: '4.3.42', task: '허브 암호 레이어' };
  const s = await env.seal('alice', 'rows/2026_4.3.42', row);
  assert.ok(!JSON.stringify(s).includes('허브') && !Buffer.from(s.ct, 'base64').toString('utf8').includes('허브'));
  assert.deepEqual(await env.open('alice', 'rows/2026_4.3.42', s), row);
  await assert.rejects(env.open('bob', 'rows/2026_4.3.42', s));           // another account
  await assert.rejects(env.open('alice', 'rows/2026_4.3.43', s));         // another place
  const ka = await keys.get('alice'); assert.ok(ka && ka.wrapped && ka.kek === 'local');
  await env.seal('bob', 'rows/x', 1);
  assert.notEqual((await keys.get('bob'))!.wrapped, ka!.wrapped);
});

test('Envelope: concurrent first requests agree on one key; a restart unwraps the stored key', async () => {
  const kekKey = randomBytes(32), keys = new MemoryDekStore();
  let creates = 0; const counting = { ...keys, get: keys.get.bind(keys), remove: keys.remove.bind(keys), create: async (u: string, r: Parameters<MemoryDekStore['create']>[1]) => { creates++; return keys.create(u, r); } };
  const a = new Envelope(new LocalKek(kekKey), counting), b = new Envelope(new LocalKek(kekKey), counting);
  const [ka, kb] = await Promise.all([a.dek('carol'), b.dek('carol')]);
  assert.ok(ka.equals(kb), 'both processes use the winner key'); assert.ok(creates >= 1);
  const s = await a.seal('carol', 'secrets/host', { refresh: 'r1' });
  const fresh = new Envelope(new LocalKek(kekKey), keys);                 // a new process: only the wrapped key survives
  assert.deepEqual(await fresh.open('carol', 'secrets/host', s), { refresh: 'r1' });
  await assert.rejects(new Envelope(new LocalKek(randomBytes(32)), keys).open('carol', 'secrets/host', s), 'another KEK cannot unwrap');
});

test('Envelope: shredding the account key makes its old ciphertext unreadable', async () => {
  const keys = new MemoryDekStore(), env = new Envelope(new LocalKek(randomBytes(32)), keys);
  const s = await env.seal('dave', 'rows/2026_1.1.1', { task: 'x' });
  await env.shred('dave');
  await assert.rejects(env.open('dave', 'rows/2026_1.1.1', s));            // a new key is made; the old ciphertext stays shut
});

test('KmsKek: calls encrypt/decrypt on the named key with the account as authenticated data', async () => {
  const calls: { url: string; data: { plaintext?: string; ciphertext?: string; additionalAuthenticatedData: string } }[] = [];
  const store = new Map<string, string>();
  const http: AuthorizedHttp = { async request<T>(o: { url: string; method: 'POST'; data: unknown }) {
    const d = o.data as { plaintext?: string; ciphertext?: string; additionalAuthenticatedData: string }; calls.push({ url: o.url, data: d });
    if (o.url.endsWith(':encrypt')) { const id = 'ct' + calls.length; store.set(id + d.additionalAuthenticatedData, d.plaintext!); return { data: { name: 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1', ciphertext: id } as unknown as T }; }
    const pt = store.get(d.ciphertext! + d.additionalAuthenticatedData); if (!pt) throw new Error('KMS: decryption failed');
    return { data: { plaintext: pt } as unknown as T };
  } };
  const kek = new KmsKek('projects/p/locations/l/keyRings/r/cryptoKeys/k', async () => http), keys = new MemoryDekStore();
  const env = new Envelope(kek, keys), s = await env.seal('erin', 'rows/2026_2.1.1', { task: 'y' });
  assert.match(calls[0].url, /cryptoKeys\/k:encrypt$/);
  assert.equal(Buffer.from(calls[0].data.additionalAuthenticatedData, 'base64').toString(), 'ppwbs-dek|erin');
  assert.equal((await keys.get('erin'))!.kek, 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1');
  assert.deepEqual(await new Envelope(kek, keys).open('erin', 'rows/2026_2.1.1', s), { task: 'y' });
  assert.match(calls.at(-1)!.url, /:decrypt$/);
  assert.throws(() => new KmsKek('projects/p/keyRings/r', async () => http));
});
