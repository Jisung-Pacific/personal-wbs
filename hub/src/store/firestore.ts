// Firestore store: the hub's own named database (default "ppwbs") in the product's Firebase project. Only this server
// reaches it (Security Rules deny every client); its service account is granted roles/datastore.user on this database alone.
//
//   users/{uid}/rows/{year}_{code}     one ledger row (Row fields)
//   users/{uid}/events/{auto id}       one history line (LedgerEvent fields + at)
//   oauth_clients/{sha256(client_id)}  registered or metadata-document clients
//   oauth_requests/{id}, oauth_codes/{hash}, oauth_refresh/{hash}   short-lived OAuth state; `expire` drives a TTL policy
import { createHash } from 'node:crypto';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import type { AuthCode, AuthRequest, LedgerEvent, LedgerTx, OAuthClient, RefreshRecord, Row, RowFilter, Store } from './types.js';
import { matches } from './memory.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const expire = (ms: number) => Timestamp.fromMillis(ms);

export class FirestoreStore implements Store {
  private db: Firestore;
  constructor(projectId: string | undefined, databaseId: string) {
    const app: App = getApps()[0] || initializeApp(projectId ? { projectId } : undefined);
    this.db = getFirestore(app, databaseId);
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
    return s.docs.map(d => d.data() as Row).filter(r => matches(r, filter));
  }
  async row(uid: string, year: string, code: string) {
    const d = await this.rowsCol(uid).doc(`${year}_${code}`).get();
    return d.exists ? d.data() as Row : null;
  }
  async events(uid: string, year?: string, code?: string) {
    let q: Query = this.eventsCol(uid);
    if (year) q = q.where('year', '==', year);
    if (code) q = q.where('code', '==', code);
    const s = await q.get();   // seq keeps the history in order (imported lines share one timestamp)
    return s.docs.map(d => d.data()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(({ at: _at, seq: _s, ...e }) => e as LedgerEvent);
  }

  async bulkImport(uid: string, rows: Row[], events: LedgerEvent[]) {
    const w = this.db.bulkWriter(), at = Timestamp.now();
    rows.forEach(r => w.set(this.rowsCol(uid).doc(`${r.year}_${r.code}`), r));
    events.forEach((e, i) => w.set(this.eventsCol(uid).doc(), { ...e, at, seq: i }));
    await w.close();
  }

  async ledgerTx<T>(uid: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async t => {
      const puts: Row[] = [], evs: LedgerEvent[] = [];
      const tx: LedgerTx = {   // Firestore wants every read before the first write, so writes are buffered
        rows: async f => (await t.get(this.rowQuery(uid, f))).docs.map(d => d.data() as Row).filter(r => matches(r, f)),
        get: async (y, c) => { const d = await t.get(this.rowsCol(uid).doc(`${y}_${c}`)); return d.exists ? d.data() as Row : null; },
        put: r => { puts.push(r); },
        event: e => { evs.push(e); },
      };
      const out = await fn(tx);
      for (const r of puts) t.set(this.rowsCol(uid).doc(`${r.year}_${r.code}`), r);
      const base = Date.now() * 1000;
      evs.forEach((e, i) => t.set(this.eventsCol(uid).doc(), { ...e, at: Timestamp.now(), seq: base + i }));
      return out;
    });
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
