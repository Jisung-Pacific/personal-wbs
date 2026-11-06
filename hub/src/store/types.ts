// Storage contracts. Two implementations: memory (tests, local runs) and Firestore (the hub's own named database).
// Every ledger call is scoped by uid: a user's rows live under users/{uid}/…, and no call can reach another user's.

/** One ledger row: the 22 columns of wbs.csv, under English keys. All values are strings ('' when empty). */
export interface Row {
  year: string; code: string; level: string; area: string; package: string; parent: string; task: string;
  start: string; end: string; date_text: string; start_month: string; status: string; key_result: string; source: string;
  due: string; importance: string; size: string; depends_on: string; blocker: string; last_progress: string; goal: string; evidence: string;
}

/** One history line of events.csv. */
export interface LedgerEvent {
  date: string; year: string; code: string; event: string; from: string; to: string; memo: string; source: string; estimated: string;
}

export interface RowFilter { year?: string; status?: string[]; packageCode?: string; parentCode?: string }

/** Inside one ledger transaction: reads see a consistent snapshot, writes land together or not at all. */
export interface LedgerTx {
  rows(filter?: RowFilter): Promise<Row[]>;
  get(year: string, code: string): Promise<Row | null>;
  put(row: Row): void;
  event(ev: LedgerEvent): void;
}

export interface OAuthClient {
  client_id: string;            // random id (DCR) or the https URL of its metadata document (CIMD)
  client_name: string;
  redirect_uris: string[];
  kind: 'dcr' | 'cimd';
  created_at: number;
  /** Confidential clients only (GPT Actions and other servers that keep a secret): SHA-256 of the secret. */
  secret_hash?: string;
}
export interface AuthRequest {   // a pending /authorize, kept server-side so the sign-in page cannot alter it
  id: string; client_id: string; client_name: string; redirect_uri: string; code_challenge: string;
  scope: string; resource: string; state: string; expires_at: number;
}
export interface AuthCode {
  hash: string; client_id: string; client_name: string; redirect_uri: string; code_challenge: string; scope: string; resource: string;
  uid: string; expires_at: number;
}
export interface RefreshRecord {
  hash: string; family: string; client_id: string; client_name: string; uid: string; scope: string; resource: string;
  expires_at: number; used: boolean;
}

export interface Store {
  // ledger
  rows(uid: string, filter?: RowFilter): Promise<Row[]>;
  row(uid: string, year: string, code: string): Promise<Row | null>;
  events(uid: string, year?: string, code?: string): Promise<LedgerEvent[]>;
  ledgerTx<T>(uid: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
  /** Migration only: writes many rows and events at once (beyond one transaction's limits), keeping the events' order. */
  bulkImport(uid: string, rows: Row[], events: LedgerEvent[]): Promise<void>;
  // OAuth
  putClient(c: OAuthClient): Promise<void>;
  client(id: string): Promise<OAuthClient | null>;
  putRequest(r: AuthRequest): Promise<void>;
  takeRequest(id: string): Promise<AuthRequest | null>;   // single use
  putCode(c: AuthCode): Promise<void>;
  takeCode(hash: string): Promise<AuthCode | null>;       // single use
  putRefresh(r: RefreshRecord): Promise<void>;
  /** Marks the token used and returns it as it was; null when unknown. A second use returns it with used = true. */
  useRefresh(hash: string): Promise<RefreshRecord | null>;
  revokeFamily(family: string): Promise<void>;
}
