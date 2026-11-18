// Firestore store: the hub's own named database (default "ppwbs") in the product's Firebase project. Only this server
// reaches it (Security Rules deny every client); its service account is granted roles/datastore.user on this database alone.
//
//   users/{uid}/rows/{year}_{code}     one ledger row: {year, code, enc} — the row itself is sealed (see crypto/envelope.ts)
//   users/{uid}/events/{auto id}       one history line: {year, code, at, seq, enc}
//   users/{uid}/secrets/{name}         a stored credential (e.g. the host product's session): {enc}
//   users/{uid}/inbox/{id}             captured raw material: {status, added, ref, expire?, enc}
//   keys/{uid}                         the account's data key, wrapped by the KMS key; deleting it shreds the account
//   users/{uid}/spaces/{id}            the team spaces the account belongs to: {role, since}
//   spaces/{id}                        a team space: {owner, created, enc} — its name is sealed under the space's own key
//   spaces/{id}/members/{uid}          {role, since, by, projects?} — a guest's projects as "YYYY:<package code>"
//   spaces/{id}/keys/dek               the space's data key, wrapped like an account's; deleting it shreds the space
//   spaces/{id}/charter/{version}      {status, by, at, activeAt?, closedAt?, consents: {uid: {agree, at}}, enc} — lines and note sealed
//   spaces/{id}/rows|events|inbox|secrets   the team ledger, laid out and sealed exactly like a personal one
//   spaces/{id}/plan/{year}_{code}     one item of the team plan: {year, code, enc} — scope, deliverable, owners, dates sealed
//   spaces/{id}/shared/{workId}        the shared fields of one member's linked row: {uid, frozen?, enc} — plan code and fields sealed
//   users/{uid}/links/{year}_{code}    a personal row's link to a team plan item: {year, code, enc} — space, plan, fields sealed
// year and code stay readable so queries can select a year or a task, and memberships (uid, role) so access can be
// checked; everything else is ciphertext.
//   oauth_clients/{sha256(client_id)}  registered or metadata-document clients
//   oauth_requests/{id}, oauth_codes/{hash}, oauth_refresh/{hash}   short-lived OAuth state; `expire` drives a TTL policy
import { createHash } from 'node:crypto';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import {
  isSpaceOwner, spaceOwner, type AuthCode, type AuthRequest, type CharterVersion, type InboxItem, type LedgerEvent, type LedgerTx, type Membership,
  type OAuthClient, type PlanItem, type PlanLink, type RefreshRecord, type Row, type RowFilter, type SharedWork, type SpaceRecord, type SpaceRole, type Store,
} from './types.js';
import { matches } from './memory.js';
import { Envelope, type DekStore, type Kek, type Sealed, type WrappedDek } from '../crypto/envelope.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const expire = (ms: number) => Timestamp.fromMillis(ms);
const SPACE_OWNER_RE = /^spaces\/s_[A-Za-z0-9_-]{22}$/;

/** A membership as stored: role, since, by, and a guest's projects ("YYYY:<package code>", plaintext like a row's code). */
const memberOf = (uid: string, d: Record<string, unknown>): Membership =>
  ({ uid, role: d.role as SpaceRole, since: d.since as number, by: d.by as string, ...(Array.isArray(d.projects) ? { projects: d.projects as string[] } : {}) });

/** The document a ledger owner's collections hang from: users/{uid} for an account, spaces/{id} for a team space. */
function home(db: Firestore, owner: string) {
  if (!owner) throw new Error('no ledger owner');
  if (isSpaceOwner(owner)) { if (!SPACE_OWNER_RE.test(owner)) throw new Error('malformed space'); return db.doc(owner); }
  if (owner.includes('/')) throw new Error('malformed account id');
  return db.collection('users').doc(owner);
}

/** Wrapped data keys: keys/{uid} for an account, spaces/{id}/keys/dek for a team space. create() fails when the document
 *  exists, so two first requests agree on one key. */
class FirestoreDekStore implements DekStore {
  constructor(private db: Firestore) {}
  private doc(owner: string) { return isSpaceOwner(owner) ? home(this.db, owner).collection('keys').doc('dek') : this.db.collection('keys').doc(home(this.db, owner).id); }
  async get(owner: string) { const d = await this.doc(owner).get(); return d.exists ? d.data() as WrappedDek : null; }
  async create(owner: string, rec: WrappedDek) {
    try { await this.doc(owner).create(rec); return true; }
    catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }   // 6 = ALREADY_EXISTS
  }
  async remove(owner: string) { await this.doc(owner).delete(); }
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

  private rowsCol(uid: string) { return home(this.db, uid).collection('rows'); }
  private eventsCol(uid: string) { return home(this.db, uid).collection('events'); }
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

  private inboxCol(uid: string) { return home(this.db, uid).collection('inbox'); }
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
    await home(this.db, uid).collection('secrets').doc(name).set({ enc: await this.envelope.seal(uid, `secrets/${name}`, value), at: Timestamp.now() });
  }
  async secret<T>(uid: string, name: string): Promise<T | null> {
    const d = await home(this.db, uid).collection('secrets').doc(name).get();
    return d.exists ? this.envelope.open<T>(uid, `secrets/${name}`, d.data()!.enc as Sealed) : null;
  }
  /** Shred first (the data becomes unreadable at once), then remove the documents. */
  async deleteAccount(uid: string) {
    if (isSpaceOwner(uid)) throw new Error('deleteAccount takes an account, not a space');
    await this.envelope.shred(uid);
    await this.db.recursiveDelete(home(this.db, uid));
  }

  // ---------------------------------------------------------------- team spaces
  private spaceDoc(id: string) { return home(this.db, spaceOwner(id)); }
  private memberDoc(id: string, uid: string) { return this.spaceDoc(id).collection('members').doc(home(this.db, uid).id); }
  private indexDoc(uid: string, id: string) { return home(this.db, uid).collection('spaces').doc(this.spaceDoc(id).id); }

  async createSpace(s: SpaceRecord) {
    const enc = await this.envelope.seal(spaceOwner(s.id), 'meta', { name: s.name });   // makes the space's data key
    const b = this.db.batch();
    b.create(this.spaceDoc(s.id), { owner: s.owner, created: s.created, enc });
    b.set(this.memberDoc(s.id, s.owner), { role: 'owner', since: s.created, by: s.owner });
    b.set(this.indexDoc(s.owner, s.id), { role: 'owner', since: s.created });
    await b.commit();
  }
  async space(id: string): Promise<SpaceRecord | null> {
    const d = await this.spaceDoc(id).get(); if (!d.exists) return null;
    const x = d.data()!, { name } = await this.envelope.open<{ name: string }>(spaceOwner(id), 'meta', x.enc as Sealed);
    return { id, name, owner: x.owner as string, created: x.created as number };
  }
  async spacesOf(uid: string) {
    const s = await home(this.db, uid).collection('spaces').get();
    return s.docs.map(d => ({ id: d.id, role: d.get('role') as SpaceRole }));
  }
  async membership(id: string, uid: string): Promise<Membership | null> {
    const d = await this.memberDoc(id, uid).get();
    return d.exists ? memberOf(uid, d.data()!) : null;
  }
  async members(id: string): Promise<Membership[]> {
    const s = await this.spaceDoc(id).collection('members').get();
    return s.docs.map(d => memberOf(d.id, d.data()));
  }
  async putMember(id: string, m: Membership) {
    const b = this.db.batch();
    b.set(this.memberDoc(id, m.uid), { role: m.role, since: m.since, by: m.by, ...(m.projects ? { projects: m.projects } : {}) });
    b.set(this.indexDoc(m.uid, id), { role: m.role, since: m.since });
    await b.commit();
  }
  async removeMember(id: string, uid: string) {
    const b = this.db.batch(); b.delete(this.memberDoc(id, uid)); b.delete(this.indexDoc(uid, id)); await b.commit();
  }
  async setOwner(id: string, uid: string) {
    await this.db.runTransaction(async t => {
      const s = await t.get(this.spaceDoc(id)), next = await t.get(this.memberDoc(id, uid));
      if (!s.exists || !next.exists) throw new Error(`no member ${uid} in space ${id}`);
      const prev = s.get('owner') as string;
      t.update(this.spaceDoc(id), { owner: uid });
      t.update(this.memberDoc(id, uid), { role: 'owner' }); t.set(this.indexDoc(uid, id), { role: 'owner' }, { merge: true });
      if (prev !== uid) { t.update(this.memberDoc(id, prev), { role: 'member' }); t.set(this.indexDoc(prev, id), { role: 'member' }, { merge: true }); }
    });
  }
  private charterCol(id: string) { return this.spaceDoc(id).collection('charter'); }
  private async openCharter(id: string, d: Record<string, unknown>): Promise<CharterVersion> {
    const v = Number(d.version), body = await this.envelope.open<{ lines: string[]; note: string }>(spaceOwner(id), `charter/${v}`, d.enc as Sealed);
    return { version: v, lines: body.lines, note: body.note, by: d.by as string, at: d.at as number, status: d.status as CharterVersion['status'],
      ...(d.activeAt ? { activeAt: d.activeAt as number } : {}), ...(d.closedAt ? { closedAt: d.closedAt as number } : {}),
      consents: (d.consents || {}) as CharterVersion['consents'] };
  }
  private async sealCharter(id: string, c: CharterVersion) {
    const { lines, note, ...meta } = c;
    return { ...meta, enc: await this.envelope.seal(spaceOwner(id), `charter/${c.version}`, { lines, note }) };
  }
  async charters(id: string) {
    const s = await this.charterCol(id).get();
    return (await Promise.all(s.docs.map(d => this.openCharter(id, d.data())))).sort((a, b) => a.version - b.version);
  }
  async charterTx<T>(id: string, fn: (versions: CharterVersion[]) => Promise<{ put: CharterVersion[]; out: T }>): Promise<T> {
    await this.envelope.dek(spaceOwner(id));   // KMS outside the retryable transaction; sealing inside is local
    return this.db.runTransaction(async t => {
      const s = await t.get(this.charterCol(id));
      const all = (await Promise.all(s.docs.map(d => this.openCharter(id, d.data())))).sort((a, b) => a.version - b.version);
      const { put, out } = await fn(all);
      const sealed = await Promise.all(put.map(c => this.sealCharter(id, c)));
      sealed.forEach(d => t.set(this.charterCol(id).doc(String(d.version)), d));
      return out;
    });
  }

  // ---------------------------------------------------------------- the team plan, links and shared work (3.4)
  private planCol(id: string) { return this.spaceDoc(id).collection('plan'); }
  private sharedCol(id: string) { return this.spaceDoc(id).collection('shared'); }
  private linksCol(uid: string) { return home(this.db, uid).collection('links'); }
  private async openPlan(id: string, docId: string, d: Record<string, unknown>): Promise<PlanItem> {
    const body = await this.envelope.open<Omit<PlanItem, 'year' | 'code'>>(spaceOwner(id), `plan/${docId}`, d.enc as Sealed);
    return { year: d.year as string, code: d.code as string, ...body };
  }
  private async sealPlan(id: string, p: PlanItem) {
    const { year, code, ...body } = p;
    return { year, code, enc: await this.envelope.seal(spaceOwner(id), `plan/${year}_${code}`, body) };
  }
  async plan(id: string) {
    const s = await this.planCol(id).get();
    return Promise.all(s.docs.map(d => this.openPlan(id, d.id, d.data())));
  }
  async planTx<T>(id: string, fn: (items: PlanItem[]) => Promise<{ put: PlanItem[]; out: T }>): Promise<T> {
    await this.envelope.dek(spaceOwner(id));   // KMS outside the retryable transaction; sealing inside is local
    return this.db.runTransaction(async t => {
      const s = await t.get(this.planCol(id));
      const { put, out } = await fn(await Promise.all(s.docs.map(d => this.openPlan(id, d.id, d.data()))));
      const sealed = await Promise.all(put.map(p => this.sealPlan(id, p)));
      sealed.forEach(d => t.set(this.planCol(id).doc(`${d.year}_${d.code}`), d));
      return out;
    });
  }
  async links(uid: string) {
    const s = await this.linksCol(uid).get();
    return Promise.all(s.docs.map(async d => ({ year: d.get('year') as string, code: d.get('code') as string,
      ...await this.envelope.open<Omit<PlanLink, 'year' | 'code'>>(uid, `links/${d.id}`, d.get('enc') as Sealed) })));
  }
  async putLink(uid: string, l: PlanLink) {
    const { year, code, ...body } = l, docId = `${year}_${code}`;
    await this.linksCol(uid).doc(docId).set({ year, code, enc: await this.envelope.seal(uid, `links/${docId}`, body) });
  }
  async removeLink(uid: string, year: string, code: string) { await this.linksCol(uid).doc(`${year}_${code}`).delete(); }
  async shared(id: string) {
    const s = await this.sharedCol(id).get();
    return Promise.all(s.docs.map(async d => ({ id: d.id, uid: d.get('uid') as string, ...(d.get('frozen') ? { frozen: d.get('frozen') as number } : {}),
      ...await this.envelope.open<Omit<SharedWork, 'id' | 'uid' | 'frozen'>>(spaceOwner(id), `shared/${d.id}`, d.get('enc') as Sealed) })));
  }
  async putShared(id: string, w: SharedWork) {
    const { id: workId, uid, frozen, ...body } = w;
    await this.sharedCol(id).doc(workId).set({ uid, ...(frozen ? { frozen } : {}), enc: await this.envelope.seal(spaceOwner(id), `shared/${workId}`, body) });
  }
  async removeShared(id: string, workId: string) { await this.sharedCol(id).doc(workId).delete(); }
  async freezeSharedBy(id: string, uid: string, at: number) {
    const s = await this.sharedCol(id).where('uid', '==', uid).get(), live = s.docs.filter(d => !d.get('frozen'));
    const b = this.db.batch(); live.forEach(d => b.update(d.ref, { frozen: at })); await b.commit();
    return live.length;
  }

  /** Shred first (the team ledger becomes unreadable at once), then drop the members' entries and the documents. */
  async deleteSpace(id: string) {
    const ms = await this.members(id);
    await this.envelope.shred(spaceOwner(id));
    const b = this.db.batch(); ms.forEach(m => b.delete(this.indexDoc(m.uid, id))); await b.commit();
    await this.db.recursiveDelete(this.spaceDoc(id));
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
