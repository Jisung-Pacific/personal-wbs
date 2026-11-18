// Storage contracts. Two implementations: memory (tests, local runs) and Firestore (the hub's own named database).
// Every ledger call is scoped by its owner: an account's personal ledger lives under users/{uid}/…, a team space's under
// spaces/{id}/…, and no call can reach another owner's.

/** Whose ledger a call works on: an account's uid (its personal space) or `spaces/<id>` (a team space). A uid never
 *  contains "/", so the two cannot be confused; the owner string also binds the ledger's data key and every sealed
 *  document to it. */
export type Owner = string;
export const spaceOwner = (id: string): Owner => `spaces/${id}`;
export const isSpaceOwner = (o: Owner) => o.startsWith('spaces/');

/** Roles in a team space: one owner, equal members, guests who only read. */
export type SpaceRole = 'owner' | 'member' | 'guest';
/** A team space. The personal space needs no record: it is the account itself. */
export interface SpaceRecord { id: string; name: string; owner: string; created: number }
export interface Membership { uid: string; role: SpaceRole; since: number; by: string }

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

/** Raw material captured anywhere — a chat on a site without tools, a search, a note, a calendar event — waiting to
 *  become ledger rows. Agents read the inbox, turn what is work into rows, and mark each item merged or skipped. */
export interface InboxItem {
  id: string;            // derived from source, url, time and title, so sending the same item again changes nothing
  kind: 'chat' | 'search' | 'note' | 'file' | 'event' | 'record';
  source: string;        // chatgpt, deepseek, grok, meta-ai, kimi, gemini, perplexity, google-search, takeout, extension, …
  at: string;            // when it happened (YYYY-MM-DD or an ISO date-time)
  title: string;
  text: string;          // at most 20,000 characters
  url: string;
  status: 'new' | 'merged' | 'skipped';
  added: number;         // when the hub received it (ms)
  ref: string;           // the ledger code(s) it became, once merged
}

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
  // inbox
  /** Stores new items; items whose id already exists are left as they are. */
  putInbox(uid: string, items: InboxItem[]): Promise<{ added: number; existing: number }>;
  inbox(uid: string, f?: { status?: InboxItem['status']; limit?: number }): Promise<InboxItem[]>;
  /** Marks items processed; processed items are removed after a retention period (Firestore TTL on `expire`). */
  markInbox(uid: string, ids: string[], status: 'merged' | 'skipped', ref?: string): Promise<number>;
  // account
  /** A credential kept for the account (sealed at rest in the Firestore store), e.g. the host product's session. */
  putSecret(uid: string, name: string, value: unknown): Promise<void>;
  secret<T>(uid: string, name: string): Promise<T | null>;
  /** Removes the account's ledger and secrets; the Firestore store shreds the account's data key first.
   *  Team memberships are ended before this by Spaces.deleteAccount, which applies the ownership rules. */
  deleteAccount(uid: string): Promise<void>;
  // team spaces (ledger calls take `spaces/<id>` as their owner; the calls below keep the membership records)
  /** Creates the space with its owner as the first member. */
  createSpace(s: SpaceRecord): Promise<void>;
  space(id: string): Promise<SpaceRecord | null>;
  /** The team spaces an account belongs to, with its role in each. */
  spacesOf(uid: string): Promise<{ id: string; role: SpaceRole }[]>;
  membership(id: string, uid: string): Promise<Membership | null>;
  members(id: string): Promise<Membership[]>;
  /** Adds a member or guest, or changes a role; the account's own list of spaces is kept in step. */
  putMember(id: string, m: Membership): Promise<void>;
  removeMember(id: string, uid: string): Promise<void>;
  /** Hands the space to one of its members in one step: the new owner's role, the old owner's (now member) and the record. */
  setOwner(id: string, uid: string): Promise<void>;
  /** Shreds the space's data key, then removes its ledger, its members and their entries in the members' own lists. */
  deleteSpace(id: string): Promise<void>;
}
