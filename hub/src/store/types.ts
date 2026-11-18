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
/** One version of a team space's charter (at most 9 lines). A proposal becomes active when every owner and member has
 *  agreed; the active version it replaces is kept as superseded, so the versions are the change history. */
export interface CharterVersion {
  version: number; lines: string[]; note: string; by: string; at: number;
  status: 'proposed' | 'active' | 'superseded' | 'withdrawn';
  activeAt?: number; closedAt?: number;
  /** each person's decision on this version: agree (or object, which keeps a proposal open) and when */
  consents: Record<string, { agree: boolean; at: number }>;
}

/** One item of a team space's plan, the team plan ledger (a project WBS): a scope with its deliverable, its done
 *  criterion, prerequisites, owners and planned dates. Codes are the plan's own (1, 1.1, 1.1.1, …) within a year and are
 *  permanent; an item is never deleted, only parked. `log` keeps the latest changes, newest last. */
export interface PlanItem {
  year: string; code: string; scope: string; deliverable: string; done: string;
  depends_on: string[]; owners: string[]; status: string; start: string; due: string;
  updated: number; by: string; log: { at: number; by: string; via?: string; change: string }[];
  /** The team intent the item serves (execution WBS 4.1); an item without one inherits its nearest parent's. */
  intent?: string;
}
/** One of a team's intents (execution WBS 4.1; the charter's 의도 정렬: why, what, how), at most five in force, ranked.
 *  Plan items point at intents; the alignment shows where the shared work actually goes against them. */
export interface Intent {
  id: string; why: string; what: string; how: string; rank: number; status: 'active' | 'retired'; updated: number; by: string;
}
/** The fields of a personal row a person may share with a team, field by field. `title` is the task text up to its
 *  first ':' or ';' (or its first 50 characters) and `links` the http(s) links in the row (its deliverables); the rest
 *  are the row's own columns. The team charter's default: title, status, dates and deliverable links; blocker details,
 *  the row's goal (목표, which the intent alignment sets beside the team's intents), evidence and the full task text only
 *  when the person chooses. */
export const SHARE_FIELDS = ['title', 'status', 'start', 'end', 'due', 'last_progress', 'links', 'size', 'key_result', 'blocker', 'goal', 'evidence', 'task'] as const;
export type ShareField = typeof SHARE_FIELDS[number];
/** A personal row's reference to a team plan item, kept in the person's own space: which plan item it serves and which
 *  of its fields the team may see. One row serves one plan item. */
export interface PlanLink { year: string; code: string; space: string; plan: string; share: ShareField[]; at: number }
/** What a team sees of a linked personal row: only the shared fields, under an id that does not reveal the person's own
 *  code. `plan` is "YYYY:<plan code>". `frozen`: when the person left the space or became a guest there; the copy stays
 *  with the team as it was (the charter: the shared copies remain with the team) and no longer follows the row. */
export interface SharedWork { id: string; uid: string; plan: string; fields: Partial<Record<ShareField, string>>; at: number; frozen?: number }

/** One line of a person's view log (execution WBS 3.5): someone else read team content carrying that person's shared
 *  rows (or, later, cards) on one day. Merged per reader, agent, space and kind: `count` reads, `rows` the most of the
 *  person's rows one read carried, `first` and `last` when. `viewer` is the reading account ('' for the team's agent),
 *  `client` the agent it read through ('' for a person in a first-party session), `role` its relation to the space. */
export interface ViewEntry {
  viewer: string; kind: 'person' | 'agent' | 'team_agent'; client: string; role: string; space: string; what: 'work' | 'card';
  rows: number; count: number; first: number; last: number;
}

/** `projects`: for a guest, the projects (packages, as "YYYY:<code>", e.g. "2026:4.3") whose plan and work it may read. */
export interface Membership { uid: string; role: SpaceRole; since: number; by: string; projects?: string[] }

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
  /** Every version of the space's charter, oldest first. */
  charters(id: string): Promise<CharterVersion[]>;
  /** Reads the versions and writes the ones `fn` returns in `put`, atomically (one change at a time per space). */
  charterTx<T>(id: string, fn: (versions: CharterVersion[]) => Promise<{ put: CharterVersion[]; out: T }>): Promise<T>;
  // the team plan and shared work (execution WBS 3.4)
  /** Every plan item of a team space. */
  plan(id: string): Promise<PlanItem[]>;
  /** Reads the plan and writes the items `fn` returns in `put`, atomically (one change at a time per space). */
  planTx<T>(id: string, fn: (items: PlanItem[]) => Promise<{ put: PlanItem[]; out: T }>): Promise<T>;
  /** The links a person keeps from personal rows to team plan items (in the person's own space). */
  links(uid: string): Promise<PlanLink[]>;
  putLink(uid: string, l: PlanLink): Promise<void>;
  removeLink(uid: string, year: string, code: string): Promise<void>;
  /** The shared fields of linked personal rows, as a team space holds them. */
  shared(id: string): Promise<SharedWork[]>;
  putShared(id: string, w: SharedWork): Promise<void>;
  removeShared(id: string, workId: string): Promise<void>;
  /** Freezes everything one person shares with a space (on leaving it or becoming a guest): the copies stay and stop
   *  following their rows. Returns how many. */
  freezeSharedBy(id: string, uid: string, at: number): Promise<number>;
  /** A team space's intents (4.1), and the same read-and-write-atomically pattern as the plan. */
  intents(id: string): Promise<Intent[]>;
  intentsTx<T>(id: string, fn: (all: Intent[]) => Promise<{ put: Intent[]; out: T }>): Promise<T>;
  // the view log (execution WBS 3.5), in the viewed person's own space, one document per day
  /** Merges entries into the person's log for `date` (same reader, kind, agent, space and what: counts add up, first and
   *  last widen, rows keep the most). `keepUntil`: when the day may be dropped (Firestore TTL). */
  logViews(uid: string, date: string, entries: ViewEntry[], keepUntil: number): Promise<void>;
  /** The person's log from `since` (YYYY-MM-DD) on, by day. */
  views(uid: string, since: string): Promise<{ date: string; entries: ViewEntry[] }[]>;
}
