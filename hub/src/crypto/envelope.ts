// Application-level envelope encryption.
//
// Every account has one random 256-bit data key (DEK). The DEK is never stored in the clear: it is kept only wrapped by a
// key-encryption key (KEK) that lives in Cloud KMS, and the wrap is bound to the account (the KMS call's additional
// authenticated data names the uid), so a wrapped key copied to another account does not unwrap. Ledger rows, history
// lines and stored credentials are sealed with AES-256-GCM under the account's DEK, each bound to its own location by its
// AAD (`<uid>|rows/2026_4.3.42`), so a sealed document moved to another path or account fails to open.
//
// What this adds on top of the database's own encryption at rest: a database export, a backup, or anyone holding database
// access alone sees only ciphertext; reading needs the hub's identity *and* its permission on the one KMS key. Deleting an
// account's wrapped DEK makes every copy of its data unreadable at once (crypto-shredding).
//
// KEKs: KmsKek (production, Cloud KMS REST through the runtime's own service account) or LocalKek (tests, the emulator and
// local runs; a key from HUB_LOCAL_KEK). Unwrapped DEKs are cached in memory for a few minutes so a request costs no KMS call.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM output: base64 nonce and base64 ciphertext with the 16-byte tag appended. */
export interface Sealed { v: 1; iv: string; ct: string }

export function gcmSeal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
}
export function gcmOpen(key: Buffer, s: Sealed, aad: string): Buffer {
  if (!s || s.v !== 1) throw new Error('unknown sealed format');
  const iv = Buffer.from(s.iv, 'base64'), all = Buffer.from(s.ct, 'base64');
  if (iv.length !== 12 || all.length < 16) throw new Error('sealed value is malformed');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad, 'utf8')); d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);   // throws when the tag does not verify
}

/** Wraps and unwraps data keys. `id` names the key (a KMS key version, or "local") for the record. */
export interface Kek {
  id: string;
  wrap(dek: Buffer, aad: string): Promise<{ wrapped: string; kek: string }>;
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
}

/** Tests, the emulator and local runs: the KEK is a 32-byte key from the environment. */
export class LocalKek implements Kek {
  readonly id = 'local';
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('HUB_LOCAL_KEK must be 32 bytes (base64)'); }
  static fromBase64(b64: string) { return new LocalKek(Buffer.from(b64, 'base64')); }
  async wrap(dek: Buffer, aad: string) { return { wrapped: Buffer.from(JSON.stringify(gcmSeal(this.key, dek, aad))).toString('base64'), kek: this.id }; }
  async unwrap(wrapped: string, aad: string) { return gcmOpen(this.key, JSON.parse(Buffer.from(wrapped, 'base64').toString('utf8')), aad); }
}

/** Minimal HTTP client the KMS calls need: google-auth-library's client in production, a fake in tests. */
export interface AuthorizedHttp { request<T>(opts: { url: string; method: 'POST'; data: unknown }): Promise<{ data: T }> }

/** Production: a symmetric Cloud KMS key (projects/…/locations/…/keyRings/…/cryptoKeys/…). Rotation is KMS's job: new wraps
 *  use the primary version, old wraps keep decrypting with the version recorded in their ciphertext. */
export class KmsKek implements Kek {
  readonly id: string;
  constructor(private keyName: string, private http: () => Promise<AuthorizedHttp>) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) throw new Error('HUB_KMS_KEY must be a full CryptoKey resource name');
    this.id = keyName;
  }
  static withDefaultCredentials(keyName: string) {
    let client: Promise<AuthorizedHttp> | null = null;
    return new KmsKek(keyName, () => client ??= (async () => {
      const { GoogleAuth } = await import('google-auth-library');
      return await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloudkms'] }).getClient() as unknown as AuthorizedHttp;
    })());
  }
  async wrap(dek: Buffer, aad: string) {
    const r = await (await this.http()).request<{ name: string; ciphertext: string }>({ url: `https://cloudkms.googleapis.com/v1/${this.keyName}:encrypt`, method: 'POST',
      data: { plaintext: dek.toString('base64'), additionalAuthenticatedData: Buffer.from(aad).toString('base64') } });
    return { wrapped: r.data.ciphertext, kek: r.data.name || this.keyName };
  }
  async unwrap(wrapped: string, aad: string) {
    const r = await (await this.http()).request<{ plaintext: string }>({ url: `https://cloudkms.googleapis.com/v1/${this.keyName}:decrypt`, method: 'POST',
      data: { ciphertext: wrapped, additionalAuthenticatedData: Buffer.from(aad).toString('base64') } });
    return Buffer.from(r.data.plaintext, 'base64');
  }
}

/** Where wrapped data keys live: one record per account, created once (create-if-absent), deleted to shred the account. */
export interface WrappedDek { v: 1; kek: string; wrapped: string; created: number }
export interface DekStore {
  get(uid: string): Promise<WrappedDek | null>;
  /** true when created; false when a record already existed (a concurrent first request won). */
  create(uid: string, rec: WrappedDek): Promise<boolean>;
  remove(uid: string): Promise<void>;
}
export class MemoryDekStore implements DekStore {
  private m = new Map<string, WrappedDek>();
  async get(uid: string) { return this.m.get(uid) ?? null; }
  async create(uid: string, rec: WrappedDek) { if (this.m.has(uid)) return false; this.m.set(uid, rec); return true; }
  async remove(uid: string) { this.m.delete(uid); }
}

const dekAad = (uid: string) => `ppwbs-dek|${uid}`;

export class Envelope {
  private cache = new Map<string, { key: Buffer; at: number }>();
  private pending = new Map<string, Promise<Buffer>>();
  constructor(private kek: Kek, private keys: DekStore, private ttlMs = 10 * 60_000, private maxCached = 2000) {}

  /** The account's data key: from the cache, else unwrapped from its record, else made, wrapped and recorded. */
  async dek(uid: string): Promise<Buffer> {
    if (!uid) throw new Error('no account');
    const hit = this.cache.get(uid);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.key;
    let p = this.pending.get(uid);   // one unwrap per account at a time
    if (!p) { p = this.load(uid).finally(() => this.pending.delete(uid)); this.pending.set(uid, p); }
    return p;
  }
  private async load(uid: string): Promise<Buffer> {
    let rec = await this.keys.get(uid);
    if (!rec) {
      const fresh = randomBytes(32), w = await this.kek.wrap(fresh, dekAad(uid));
      if (await this.keys.create(uid, { v: 1, kek: w.kek, wrapped: w.wrapped, created: Date.now() })) return this.remember(uid, fresh);
      rec = await this.keys.get(uid);   // lost the race to a concurrent first request: use the winner's key
      if (!rec) throw new Error('data key vanished while it was being created');
    }
    return this.remember(uid, await this.kek.unwrap(rec.wrapped, dekAad(uid)));
  }
  private remember(uid: string, key: Buffer) {
    if (this.cache.size >= this.maxCached) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
    this.cache.set(uid, { key, at: Date.now() });
    return key;
  }

  async seal(uid: string, where: string, value: unknown): Promise<Sealed> {
    return gcmSeal(await this.dek(uid), Buffer.from(JSON.stringify(value), 'utf8'), `${uid}|${where}`);
  }
  async open<T>(uid: string, where: string, s: Sealed): Promise<T> {
    return JSON.parse(gcmOpen(await this.dek(uid), s, `${uid}|${where}`).toString('utf8')) as T;
  }
  /** Crypto-shredding: the wrapped key is deleted, so every sealed copy of this account's data stops opening. */
  async shred(uid: string) { this.cache.delete(uid); await this.keys.remove(uid); }
}
