// In-memory store for tests and local runs. Same contract as the Firestore store, including single-use semantics and
// per-user transactions (a promise chain per uid serialises them, as Firestore's transactions would).
import type { AuthCode, AuthRequest, LedgerEvent, LedgerTx, OAuthClient, RefreshRecord, Row, RowFilter, Store } from './types.js';

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
}
