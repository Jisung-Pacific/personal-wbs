// Firestore store: the hub's own named database (default "ppwbs") in the product's Firebase project. Only this server
// reaches it (Security Rules deny every client); its service account is granted roles/datastore.user on this database alone.
//
//   users/{uid}/rows/{year}_{code}     one ledger row: {year, code, enc} — the row itself is sealed (see crypto/envelope.ts)
//   users/{uid}/events/{auto id}       one history line: {year, code, at, seq, enc}
//   users/{uid}/secrets/{name}         a stored credential (e.g. the host product's session): {enc}
//   users/{uid}/inbox/{id}             captured raw material: {status, added, ref, expire?, enc}
//   keys/{uid}                         the account's data key, wrapped by the KMS key; deleting it shreds the account
// year and code stay readable so queries can select a year or a task; everything else is ciphertext.
//   oauth_clients/{sha256(client_id)}  registered or metadata-document clients
//   oauth_requests/{id}, oauth_codes/{hash}, oauth_refresh/{hash}   short-lived OAuth state; `expire` drives a TTL policy
import { createHash } from 'node:crypto';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import type { AuthCode, AuthRequest, InboxItem, LedgerEvent, LedgerTx, OAuthClient, RefreshRecord, Row, RowFilter, Store } from './types.js';
import { matches } from './memory.js';
import { Envelope, type DekStore, type Kek, type Sealed, type WrappedDek } from '../crypto/envelope.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const expire = (ms: number) => Timestamp.fromMillis(ms);

/** Wrapped data keys in keys/{uid}; create() fails when the document exists, so two first requests agree on one key. */
class FirestoreDekStore implements DekStore {
  constructor(private db: Firestore) {}
  async get(uid: string) { const d = await this.db.collection('keys').doc(uid).get(); return d.exists ? d.data() as WrappedDek : null; }
  async create(uid: string, rec: WrappedDek) {
    try { await this.db.collection('keys').doc(uid).create(rec); return true; }
    catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }   // 6 = ALREADY_EXISTS
  }
  async remove(uid: string) { await this.db.collection('keys').doc(uid).delete(); }
}

type SealedRowDoc = { year: string; code: string; enc: Sealed };

export class FirestoreStore implements Store {
  private db: Firestore;
  readonly envelope: Envelope;
  /** allowPlain: read documents written before encryption was switched on (a one-off migration window only). */
  constructor(projectId: string | undefined, databaseId: string, kek: Kek, private allowPlain = false) {
    const app: App = getApps()[0] || initializeApp(projectId ? { projectId } : undefined);
    this.db = getFirestore(app, databaseId);
    this.envelope = new Envelope(kek, new FirestoreDekStore(this.db));
  }

  private async openRow(uid: string, id: string, d: Record<string, unknown>): Promise<Row> {
    if (d.enc) return this.envelope.open<Row>(uid, `rows/${id}`, d.enc as Sealed);
    if (this.allowPlain) return d as unknown as Row;
    throw new Error(`unsealed row ${id}`);
  }
  private async sealRow(uid: string, r: Row): Promise<SealedRowDoc> {
    return { year: r.year, code: r.code, enc: await this.envelope.seal(uid, `rows/${r.year}_${r.code}`, r) };
  }
  private async openEvent(uid: string, id: string, d: Record<string, unknown>): Promise<LedgerEvent & { seq: number }> {
    const seq = Number(d.seq ?? 0);
    if (d.enc) return { ...await this.envelope.open<LedgerEvent>(uid, `events/${id}`, d.enc as Sealed), seq };
    if (this.allowPlain) { const { at: _a, seq: _s, ...e } = d; return { ...(e as unknown as LedgerEvent), seq }; }
    throw new Error(`unsealed event ${id}`);
  }
  private async sealEvent(uid: string, id: string, e: LedgerEvent, at: Timestamp, seq: number) {
    return { year: e.year, code: e.code, at, seq, enc: await this.envelope.seal(uid, `events/${id}`, e) };
  }

  private rowsCol(uid: string) { return this.db.collection('users').doc(uid).collection('rows'); }
  private eventsCol(uid: string) { return this.db.collection('users').doc(uid).collection('events'); }
  private rowQuery(uid: string, f?: RowFilter): Query {
    let q: Query = this.rowsCol(uid);
    if (f?.year) q = q.where('year', '==', f.year);   // remaining filters are applied in memory (a ledger is small)
    return q;
  }

  async rows(uid: string, filter?: RowFilter) {
    const s = await this.rowQuery(uid, filter).get();
    return (await Promise.all(s.docs.map(d => this.openRow(uid, d.id, d.data())))).filter(r => matches(r, filter));
  }
  async row(uid: string, year: string, code: string) {
    const d = await this.rowsCol(uid).doc(`${year}_${code}`).get();
    return d.exists ? this.openRow(uid, d.id, d.data()!) : null;
  }
  async events(uid: string, year?: string, code?: string) {
    let q: Query = this.eventsCol(uid);
    if (year) q = q.where('year', '==', year);
    if (code) q = q.where('code', '==', code);
    const s = await q.get();   // seq keeps the history in order (imported lines share one timestamp)
    const evs = await Promise.all(s.docs.map(d => this.openEvent(uid, d.id, d.data())));
    return evs.sort((a, b) => a.seq - b.seq).map(({ seq: _s, ...e }) => e as LedgerEvent);
  }

  async bulkImport(uid: string, rows: Row[], events: LedgerEvent[]) {
    await this.envelope.dek(uid);   // one key fetch before the batch; sealing below is local
    const w = this.db.bulkWriter(), at = Timestamp.now();
    for (const r of rows) w.set(this.rowsCol(uid).doc(`${r.year}_${r.code}`), await this.sealRow(uid, r));
    for (let i = 0; i < events.length; i++) { const ref = this.eventsCol(uid).doc(); w.set(ref, await this.sealEvent(uid, ref.id, events[i], at, i)); }
    await w.close();
  }

  async ledgerTx<T>(uid: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    await this.envelope.dek(uid);   // KMS stays outside the retryable transaction; inside, sealing and opening are local
    return this.db.runTransaction(async t => {
      const puts: Row[] = [], evs: LedgerEvent[] = [];
      const tx: LedgerTx = {   // Firestore wants every read before the first write, so writes are buffered
        rows: async f => (await Promise.all((await t.get(this.rowQuery(uid, f))).docs.map(d => this.openRow(uid, d.id, d.data())))).filter(r => matches(r, f)),
        get: async (y, c) => { const d = await t.get(this.rowsCol(uid).doc(`${y}_${c}`)); return d.exists ? this.openRow(uid, d.id, d.data()!) : null; },
        put: r => { puts.push(r); },
        event: e => { evs.push(e); },
      };
      const out = await fn(tx);
      const sealedRows = await Promise.all(puts.map(r => this.sealRow(uid, r)));
      const base = Date.now() * 1000, at = Timestamp.now();
      const sealedEvs = await Promise.all(evs.map(async (e, i) => { const ref = this.eventsCol(uid).doc(); return [ref, await this.sealEvent(uid, ref.id, e, at, base + i)] as const; }));
      sealedRows.forEach(d => t.set(this.rowsCol(uid).doc(`${d.year}_${d.code}`), d));
      sealedEvs.forEach(([ref, d]) => t.set(ref, d));
      return out;
    });
  }

  private inboxCol(uid: string) { return this.db.collection('users').doc(uid).collection('inbox'); }
  async putInbox(uid: string, items: InboxItem[]) {
    await this.envelope.dek(uid);
    const res = await Promise.allSettled(items.map(async it => {
      const { status, added, ref, ...body } = it;
      await this.inboxCol(uid).doc(it.id).create({ status, added, ref, enc: await this.envelope.seal(uid, `inbox/${it.id}`, body) });
    }));
    const existing = res.filter(r => r.status === 'rejected' && (r.reason as { code?: number }).code === 6).length;
    const failed = res.find(r => r.status === 'rejected' && (r.reason as { code?: number }).code !== 6);
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return { added: items.length - existing, existing };
  }
  async inbox(uid: string, f?: { status?: InboxItem['status']; limit?: number }) {
    let q: Query = this.inboxCol(uid);
    if (f?.status) q = q.where('status', '==', f.status);
    const docs = (await q.limit(1000).get()).docs.sort((a, b) => (b.get('added') as number) - (a.get('added') as number)).slice(0, f?.limit ?? 50);
    return Promise.all(docs.map(async d => {
      const x = d.data(), body = await this.envelope.open<Omit<InboxItem, 'status' | 'added' | 'ref'>>(uid, `inbox/${d.id}`, x.enc as Sealed);
      return { ...body, id: d.id, status: x.status, added: x.added, ref: x.ref || '' } as InboxItem;
    }));
  }
  async markInbox(uid: string, ids: string[], status: 'merged' | 'skipped', ref = '') {
    const keep = expire(Date.now() + 30 * 24 * 3600e3);   // processed items leave after 30 days
    const out = await Promise.allSettled(ids.map(id => this.inboxCol(uid).doc(id).update({ status, ref, expire: keep })));
    return out.filter(r => r.status === 'fulfilled').length;
  }

  async putSecret(uid: string, name: string, value: unknown) {
    await this.db.collection('users').doc(uid).collection('secrets').doc(name).set({ enc: await this.envelope.seal(uid, `secrets/${name}`, value), at: Timestamp.now() });
  }
  async secret<T>(uid: string, name: string): Promise<T | null> {
    const d = await this.db.collection('users').doc(uid).collection('secrets').doc(name).get();
    return d.exists ? this.envelope.open<T>(uid, `secrets/${name}`, d.data()!.enc as Sealed) : null;
  }
  /** Shred first (the data becomes unreadable at once), then remove the documents. */
  async deleteAccount(uid: string) {
    await this.envelope.shred(uid);
    await this.db.recursiveDelete(this.db.collection('users').doc(uid));
  }

  async putClient(c: OAuthClient) { await this.db.collection('oauth_clients').doc(sha(c.client_id)).set(c); }
  async client(id: string) { const d = await this.db.collection('oauth_clients').doc(sha(id)).get(); return d.exists ? d.data() as OAuthClient : null; }

  async putRequest(r: AuthRequest) { await this.db.collection('oauth_requests').doc(r.id).set({ ...r, expire: expire(r.expires_at) }); }
  async takeRequest(id: string) { return this.take<AuthRequest>('oauth_requests', id); }
  async putCode(c: AuthCode) { await this.db.collection('oauth_codes').doc(c.hash).set({ ...c, expire: expire(c.expires_at) }); }
  async takeCode(hash: string) { return this.take<AuthCode>('oauth_codes', hash); }

  async putRefresh(r: RefreshRecord) { await this.db.collection('oauth_refresh').doc(r.hash).set({ ...r, expire: expire(r.expires_at) }); }
  async useRefresh(hash: string) {
    const ref = this.db.collection('oauth_refresh').doc(hash);
    return this.db.runTransaction(async t => {
      const d = await t.get(ref); if (!d.exists) return null;
      const { expire: _e, ...was } = d.data() as RefreshRecord & { expire: unknown };
      t.update(ref, { used: true });
      return was as RefreshRecord;
    });
  }
  async revokeFamily(family: string) {
    const s = await this.db.collection('oauth_refresh').where('family', '==', family).get();
    const b = this.db.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit();
  }

  /** Read and delete in one transaction: a code or a pending request can be redeemed once. */
  private async take<T extends { expires_at: number }>(col: string, id: string): Promise<T | null> {
    const ref = this.db.collection(col).doc(id);
    return this.db.runTransaction(async t => {
      const d = await t.get(ref); if (!d.exists) return null;
      t.delete(ref);
      const { expire: _e, ...v } = d.data() as Record<string, unknown>;
      const out = v as unknown as T;
      return out.expires_at > Date.now() ? out : null;
    });
  }
}
