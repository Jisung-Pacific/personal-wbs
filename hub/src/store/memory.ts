// In-memory store for tests and local runs. Same contract as the Firestore store, including single-use semantics and
// per-user transactions (a promise chain per uid serialises them, as Firestore's transactions would).
import {
  spaceOwner, type AuthCode, type AuthRequest, type InboxItem, type LedgerEvent, type LedgerTx, type Membership, type OAuthClient,
  type RefreshRecord, type Row, type RowFilter, type SpaceRecord, type Store,
} from './types.js';

const key = (year: string, code: string) => `${year}|${code}`;

export function matches(r: Row, f?: RowFilter): boolean {
  if (!f) return true;
  if (f.year && r.year !== f.year) return false;
  if (f.status && f.status.length && !f.status.includes(r.status)) return false;
  if (f.packageCode && r.package.split(' ')[0] !== f.packageCode) return false;
  if (f.parentCode && r.parent.split(' ')[0] !== f.parentCode) return false;
  return true;
}

export class MemoryStore implements Store {
  private ledgers = new Map<string, { rows: Map<string, Row>; events: LedgerEvent[] }>();
  private locks = new Map<string, Promise<unknown>>();
  private clients = new Map<string, OAuthClient>();
  private requests = new Map<string, AuthRequest>();
  private codes = new Map<string, AuthCode>();
  private refresh = new Map<string, RefreshRecord>();

  private ledger(uid: string) {
    let l = this.ledgers.get(uid);
    if (!l) { l = { rows: new Map(), events: [] }; this.ledgers.set(uid, l); }
    return l;
  }

  async rows(uid: string, filter?: RowFilter) { return [...this.ledger(uid).rows.values()].filter(r => matches(r, filter)).map(r => ({ ...r })); }
  async row(uid: string, year: string, code: string) { const r = this.ledger(uid).rows.get(key(year, code)); return r ? { ...r } : null; }
  async events(uid: string, year?: string, code?: string) {
    return this.ledger(uid).events.filter(e => (!year || e.year === year) && (!code || e.code === code)).map(e => ({ ...e }));
  }

  async ledgerTx<T>(uid: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(uid) || Promise.resolve();
    const run = prev.then(async () => {
      const l = this.ledger(uid), puts: Row[] = [], evs: LedgerEvent[] = [];
      const tx: LedgerTx = {
        rows: async f => [...l.rows.values()].filter(r => matches(r, f)).map(r => ({ ...r })),
        get: async (y, c) => { const r = l.rows.get(key(y, c)); return r ? { ...r } : null; },
        put: r => { puts.push({ ...r }); },
        event: e => { evs.push({ ...e }); },
      };
      const out = await fn(tx);
      for (const r of puts) l.rows.set(key(r.year, r.code), r);   // all writes land after fn succeeds
      l.events.push(...evs);
      return out;
    });
    this.locks.set(uid, run.catch(() => undefined));
    return run;
  }

  async bulkImport(uid: string, rows: Row[], events: LedgerEvent[]) {
    const l = this.ledger(uid); rows.forEach(r => l.rows.set(key(r.year, r.code), { ...r })); l.events.push(...events.map(e => ({ ...e })));
  }

  async putClient(c: OAuthClient) { this.clients.set(c.client_id, { ...c }); }
  async client(id: string) { const c = this.clients.get(id); return c ? { ...c } : null; }
  async putRequest(r: AuthRequest) { this.requests.set(r.id, { ...r }); }
  async takeRequest(id: string) { const r = this.requests.get(id); this.requests.delete(id); return r && r.expires_at > Date.now() ? r : null; }
  async putCode(c: AuthCode) { this.codes.set(c.hash, { ...c }); }
  async takeCode(hash: string) { const c = this.codes.get(hash); this.codes.delete(hash); return c && c.expires_at > Date.now() ? c : null; }
  async putRefresh(r: RefreshRecord) { this.refresh.set(r.hash, { ...r }); }
  async useRefresh(hash: string) {
    const r = this.refresh.get(hash); if (!r) return null;
    const was = { ...r }; r.used = true; return was;
  }
  async revokeFamily(family: string) { for (const [h, r] of this.refresh) if (r.family === family) this.refresh.delete(h); }

  private boxes = new Map<string, Map<string, InboxItem>>();
  private box(uid: string) { let b = this.boxes.get(uid); if (!b) { b = new Map(); this.boxes.set(uid, b); } return b; }
  async putInbox(uid: string, items: InboxItem[]) {
    const b = this.box(uid); let added = 0;
    for (const it of items) if (!b.has(it.id)) { b.set(it.id, { ...it }); added++; }
    return { added, existing: items.length - added };
  }
  async inbox(uid: string, f?: { status?: InboxItem['status']; limit?: number }) {
    return [...this.box(uid).values()].filter(i => !f?.status || i.status === f.status).sort((a, b) => b.added - a.added).slice(0, f?.limit ?? 50).map(i => ({ ...i }));
  }
  async markInbox(uid: string, ids: string[], status: 'merged' | 'skipped', ref = '') {
    const b = this.box(uid); let n = 0;
    for (const id of ids) { const i = b.get(id); if (i) { i.status = status; i.ref = ref; n++; } }
    return n;
  }

  private secrets = new Map<string, unknown>();
  async putSecret(uid: string, name: string, value: unknown) { this.secrets.set(`${uid}|${name}`, structuredClone(value)); }
  async secret<T>(uid: string, name: string) { const v = this.secrets.get(`${uid}|${name}`); return v === undefined ? null : structuredClone(v) as T; }
  async deleteAccount(uid: string) {
    this.dropOwner(uid);
    for (const [h, r] of this.refresh) if (r.uid === uid) this.refresh.delete(h);
  }
  /** Everything kept under one ledger owner: its rows and history, inbox and secrets. */
  private dropOwner(owner: string) {
    this.ledgers.delete(owner); this.boxes.delete(owner);
    for (const k of [...this.secrets.keys()]) if (k.startsWith(owner + '|')) this.secrets.delete(k);
  }

  // team spaces: the record and its members; the space's ledger is the ordinary ledger under `spaces/<id>`
  private spaces = new Map<string, SpaceRecord>();
  private crew = new Map<string, Map<string, Membership>>();
  async createSpace(s: SpaceRecord) {
    if (this.spaces.has(s.id)) throw new Error(`space ${s.id} exists`);
    this.spaces.set(s.id, { ...s });
    this.crew.set(s.id, new Map([[s.owner, { uid: s.owner, role: 'owner', since: s.created, by: s.owner }]]));
  }
  async space(id: string) { const s = this.spaces.get(id); return s ? { ...s } : null; }
  async spacesOf(uid: string) {
    return [...this.crew].flatMap(([id, ms]) => { const m = ms.get(uid); return m ? [{ id, role: m.role }] : []; });
  }
  async membership(id: string, uid: string) { const m = this.crew.get(id)?.get(uid); return m ? { ...m } : null; }
  async members(id: string) { return [...(this.crew.get(id)?.values() ?? [])].map(m => ({ ...m })); }
  async putMember(id: string, m: Membership) {
    const ms = this.crew.get(id); if (!ms) throw new Error(`no space ${id}`);
    ms.set(m.uid, { ...m });
  }
  async removeMember(id: string, uid: string) { this.crew.get(id)?.delete(uid); }
  async setOwner(id: string, uid: string) {
    const s = this.spaces.get(id), ms = this.crew.get(id), next = ms?.get(uid);
    if (!s || !ms || !next) throw new Error(`no member ${uid} in space ${id}`);
    const prev = ms.get(s.owner);
    if (prev && prev.uid !== uid) prev.role = 'member';
    next.role = 'owner'; s.owner = uid;
  }
  async deleteSpace(id: string) { this.spaces.delete(id); this.crew.delete(id); this.dropOwner(spaceOwner(id)); }
}
