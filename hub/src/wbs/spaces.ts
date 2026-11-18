// Spaces: whose ledger a call works on, and who may do what there. Every account has its personal space (the account
// itself, nothing to create); a team space is made by one person, its owner, who adds members (equal, read and write)
// and guests (read only, and only the projects they are assigned). A small AI-native team is the target: usually 2–5
// people, at most 10 per space. A team space's ledger lives under spaces/<id> with its own data key, so its rows, history
// and name are sealed apart from every member's personal ledger, and deleting the space shreds that key.
//
// Every decision goes through the permission table (access.ts): the stored membership is the relation tuple, the table
// says what it grants, and agents act within the person's relation and scopes but never govern a space.
//
// The team charter (at most 9 lines) gates the space: it opens once a charter is in force, which takes every owner's and
// member's agreement, and each owner or member enters only after agreeing to the version in force (a newcomer agrees on
// joining). A change is a new version: it takes effect when everyone agrees, the version it replaces is kept as
// superseded, and withdrawn proposals stay too, so the versions with their dated consents are the change record.
import { randomBytes } from 'node:crypto';
import { spaceOwner, type CharterVersion, type Membership, type Store } from '../store/types.js';
import { LedgerError, type View } from './service.js';
import { callerUid, decide, type Action, type Caller, type Relation } from './access.js';

export const PERSONAL = 'personal';
export const MAX_PEOPLE = 10;
const SPACE_ID = /^s_[A-Za-z0-9_-]{22}$/;
const PROJECT = /^\d{4}:\d+\.\d+$/;   // a package of one year, e.g. "2026:4.3"
export const CHARTER_LINES = 9;

/** An account id as the hub receives it from sign-in; "/" would let it pass for a ledger path, so it is refused. */
export function assertUid(uid: unknown): string {
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid.length > 128) throw new LedgerError('invalid', 'Invalid account id');
  return uid;
}
function cleanName(name: unknown): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 80) throw new LedgerError('invalid', 'A space name is 1–80 characters');
  return n;
}
function cleanProjects(p: unknown): string[] {
  if (p === undefined) return [];
  if (!Array.isArray(p) || p.length > 50 || !p.every(x => typeof x === 'string' && PROJECT.test(x))) {
    throw new LedgerError('invalid', 'projects are packages as "YYYY:<code>", e.g. "2026:4.3" (at most 50)');
  }
  return [...new Set(p as string[])].sort();
}

function cleanLines(lines: unknown): string[] {
  if (!Array.isArray(lines) || !lines.length || lines.length > CHARTER_LINES) throw new LedgerError('invalid', `A charter has 1–${CHARTER_LINES} lines`);
  return lines.map(l => {
    const t = String(l ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 300) throw new LedgerError('invalid', 'Each charter line is 1–300 characters');
    return t;
  });
}
const cleanNote = (n: unknown) => { const t = String(n ?? '').trim(); if (t.length > 500) throw new LedgerError('invalid', 'A note is at most 500 characters'); return t; };

type Rel = { relation: Relation; member?: Membership };

export class Spaces {
  constructor(private store: Store) {}

  /** Called when someone stops being an owner or member of a space (removed, left, made a guest, account deleted), so
   *  what they shared with it goes too. The plan service (plan.ts) sets it. */
  left?: (space: string, uid: string) => Promise<void>;

  /** A team-space call outside the ledger tools (the plan, shared work): the permission table and the charter gate, then
   *  the caller's relation, a guest's projects, and whether the caller may see who is who (members.read). */
  async enter(caller: Caller, space: string | undefined, action: Action) {
    if (!space || space === PERSONAL) throw new LedgerError('invalid', 'This works in a team space; pass its id from wbs_spaces');
    const r = await this.need(caller, space, action);
    await this.gate(caller, space, r);
    return { relation: r.relation, projects: r.relation === 'guest' ? r.member?.projects ?? [] : undefined, named: decide(caller, r.relation, 'members.read').allow };
  }

  /** What a call may read or write: the caller's own ledger (no space, or "personal") or a team space, as the permission
   *  table allows. A guest reads only its projects; outsiders are told the space does not exist. */
  async view(caller: Caller, space: string | undefined, need: 'read' | 'write'): Promise<View> {
    const action: Action = need === 'write' ? 'plan.write' : 'plan.read';
    if (!space || space === PERSONAL) {
      const uid = callerUid(caller);
      if (uid === null) throw new LedgerError('not_found', 'A team agent has no personal space');
      this.check(caller, 'owner', action);
      return { owner: assertUid(uid) };
    }
    const r = await this.need(caller, space, action);
    await this.gate(caller, space, r);
    return r.relation === 'guest' ? { owner: spaceOwner(space), projects: r.member?.projects ?? [] } : { owner: spaceOwner(space) };
  }

  /** A person makes a team space and owns it. Agents do not create spaces. */
  async create(caller: Caller, name: string) {
    if (caller.kind !== 'person') throw new LedgerError('forbidden', 'Creating a team space is for people, not agents');
    const s = { id: 's_' + randomBytes(16).toString('base64url'), name: cleanName(name), owner: assertUid(caller.uid), created: Date.now() };
    await this.store.createSpace(s);
    return { id: s.id, name: s.name, role: 'owner' as const };
  }

  /** The switcher's list: the personal space first, then each team space with the caller's role (a guest also sees its
   *  projects). A team agent sees only the space that delegated it. */
  async list(caller: Caller) {
    if (caller.kind === 'team_agent') {
      const s = await this.store.space(caller.space);
      return s ? [{ id: s.id, kind: 'team' as const, name: s.name, role: 'delegate' as const }] : [];
    }
    this.check(caller, 'owner', 'space.see');
    const teams = await Promise.all((await this.store.spacesOf(assertUid(caller.uid))).map(async m => {
      const [s, me, vs] = await Promise.all([this.store.space(m.id), this.store.membership(m.id, caller.uid), this.store.charters(m.id)]);
      if (!s || !me) return null;
      const active = vs.find(c => c.status === 'active'), open = vs.find(c => c.status === 'proposed'), bound = me.role !== 'guest';
      return { id: s.id, kind: 'team' as const, name: s.name, role: me.role, ...(me.role === 'guest' ? { projects: me.projects ?? [] } : {}),
        charter: { in_force: active?.version ?? null, needs_consent: bound && !active?.consents[caller.uid]?.agree,
          proposal: open ? { version: open.version, answered: !!open.consents[caller.uid] } : null } };
    }));
    return [{ id: PERSONAL, kind: 'personal' as const, name: '', role: 'owner' as const }, ...teams.filter(t => t !== null)];
  }

  /** Everyone in the space, owner first (owner and members may see this; guests see only their projects' work). */
  async members(caller: Caller, id: string) {
    await this.need(caller, id, 'members.read');
    const order = { owner: 0, member: 1, guest: 2 } as const;
    return (await this.store.members(id)).sort((a, b) => order[a.role] - order[b.role] || a.since - b.since);
  }

  /** The owner adds a member or a guest, changes a role, or sets a guest's projects. Becoming owner is a transfer. */
  async setMember(caller: Caller, id: string, who: string, role: 'member' | 'guest', projects?: string[]) {
    await this.need(caller, id, 'members.manage');
    assertUid(who);
    if (role !== 'member' && role !== 'guest') throw new LedgerError('invalid', 'role is member or guest');
    const all = await this.store.members(id), cur = all.find(m => m.uid === who);
    if (cur?.role === 'owner') throw new LedgerError('invalid', 'The owner\'s role changes only by a hand-over');
    if (!cur && all.length >= MAX_PEOPLE) throw new LedgerError('invalid', `A team space holds at most ${MAX_PEOPLE} people`);
    const p = role === 'guest' ? cleanProjects(projects ?? cur?.projects) : undefined;
    if (role === 'member' && projects !== undefined) throw new LedgerError('invalid', 'Members see every project; projects are for guests');
    await this.store.putMember(id, { uid: who, role, since: cur?.since ?? Date.now(), by: callerUid(caller)!, ...(p ? { projects: p } : {}) });
    if (role === 'guest' && cur && cur.role !== 'guest') await this.left?.(id, who);   // a guest shares nothing with the team
    await this.settle(id);   // a member who becomes a guest no longer holds up a proposal
    return { uid: who, role, ...(p ? { projects: p } : {}) };
  }

  /** The owner removes someone, or a member or guest leaves. The owner leaves only after handing the space over. */
  async removeMember(caller: Caller, id: string, who: string) {
    const self = callerUid(caller) === who, r = await this.relation(caller, id);
    if (self && r.relation === 'owner' && caller.kind === 'person') throw new LedgerError('invalid', 'Hand the space to a member before leaving it');
    this.check(caller, r.relation, self ? 'space.leave' : 'members.manage');
    const m = await this.store.membership(id, assertUid(who));
    if (!m) throw new LedgerError('not_found', 'Not in this space');
    if (m.role === 'owner') throw new LedgerError('invalid', 'The owner cannot be removed; hand the space over first');
    await this.store.removeMember(id, who);
    await this.left?.(id, who);
    await this.settle(id);   // the last person still to answer may be the one who left
    return { removed: who };
  }

  /** The owner hands the space to a member (not a guest); the old owner stays on as a member. */
  async transfer(caller: Caller, id: string, to: string) {
    await this.need(caller, id, 'space.transfer');
    const m = await this.store.membership(id, assertUid(to));
    if (!m || m.role !== 'member') throw new LedgerError('invalid', 'Hand the space to one of its members');
    await this.store.setOwner(id, to);
    return { owner: to };
  }

  /** The owner deletes the space: its key is shredded, then its ledger and memberships are removed. */
  async remove(caller: Caller, id: string) {
    await this.need(caller, id, 'space.delete');
    await this.store.deleteSpace(id);
    return { deleted: id };
  }

  /** Before an account goes (a person's own request): it leaves every team space, and a space it owns alone goes with it.
   *  A space it owns with others must be handed over first; nothing is removed until every space passes that check. */
  async deleteAccount(uid: string) {
    assertUid(uid);
    const mine = await this.store.spacesOf(uid), owned = mine.filter(s => s.role === 'owner');
    for (const s of owned) if ((await this.store.members(s.id)).length > 1) throw new LedgerError('invalid', `Hand space ${s.id} to a member before deleting the account`);
    for (const s of mine) {
      if (s.role === 'owner') { await this.store.deleteSpace(s.id); continue; }
      await this.store.removeMember(s.id, uid); await this.left?.(s.id, uid);
    }
    await this.store.deleteAccount(uid);
  }

  // ---------------------------------------------------------------- the team charter
  /** The charter: the version in force, an open proposal, and every version so far. Who agreed, objected or has yet to
   *  answer is named for those who may see the member list, and counted for anyone else. */
  async charter(caller: Caller, id: string) {
    const r = await this.need(caller, id, 'charter.read');
    const [vs, ms] = await Promise.all([this.store.charters(id), this.store.members(id)]);
    const people = ms.filter(m => m.role !== 'guest').map(m => m.uid), named = decide(caller, r.relation, 'members.read').allow;
    const tally = (c: CharterVersion) => {
      const agreed = people.filter(u => c.consents[u]?.agree), objected = people.filter(u => c.consents[u] && !c.consents[u].agree);
      const waiting = people.filter(u => !c.consents[u]);
      return named ? { agreed: agreed.map(u => ({ uid: u, at: c.consents[u].at })), objected, waiting }
        : { agreed: agreed.length, objected: objected.length, waiting: waiting.length };
    };
    const show = (c: CharterVersion) => ({ version: c.version, lines: c.lines, note: c.note, by: named ? c.by : undefined, at: c.at,
      ...(c.activeAt ? { active_at: c.activeAt } : {}), ...tally(c) });
    const active = vs.find(c => c.status === 'active'), open = vs.find(c => c.status === 'proposed');
    return { open: !!active, in_force: active ? show(active) : null, proposal: open ? show(open) : null,
      history: vs.map(c => ({ version: c.version, status: c.status, at: c.at, ...(c.activeAt ? { active_at: c.activeAt } : {}), ...(c.closedAt ? { closed_at: c.closedAt } : {}) })) };
  }

  /** An owner or member proposes a version (at most 9 lines) and agrees by proposing. One proposal is open at a time; it
   *  takes effect once everyone agrees (a space of one person adopts it at once). */
  async proposeCharter(caller: Caller, id: string, lines: string[], note = '') {
    await this.need(caller, id, 'charter.propose');
    const uid = callerUid(caller)!, L = cleanLines(lines), n = cleanNote(note), now = Date.now();
    await this.store.charterTx(id, async vs => {
      if (vs.some(c => c.status === 'proposed')) throw new LedgerError('invalid', 'A charter proposal is already open; decide or withdraw it first');
      const c: CharterVersion = { version: Math.max(0, ...vs.map(v => v.version)) + 1, lines: L, note: n, by: uid, at: now, status: 'proposed', consents: { [uid]: { agree: true, at: now } } };
      return { put: [c], out: null };
    });
    await this.settle(id);
    return this.charter(caller, id);
  }

  /** An owner or member answers a version: agree or object to an open proposal (an objection keeps it open; answering
   *  again replaces the answer), or agree to the version in force, which is how a newcomer enters. */
  async consentCharter(caller: Caller, id: string, version: number, agree: boolean) {
    await this.need(caller, id, 'charter.consent');
    const uid = callerUid(caller)!;
    await this.store.charterTx(id, async vs => {
      const c = vs.find(v => v.version === version);
      if (!c || (c.status !== 'proposed' && c.status !== 'active')) throw new LedgerError('not_found', `No open or in-force charter version ${version}`);
      if (c.status === 'active' && !agree) throw new LedgerError('invalid', 'To change the charter in force, propose a new version');
      return { put: [{ ...c, consents: { ...c.consents, [uid]: { agree: !!agree, at: Date.now() } } }], out: null };
    });
    await this.settle(id);
    return this.charter(caller, id);
  }

  /** The proposer or the owner withdraws an open proposal; it stays in the history as withdrawn. */
  async withdrawCharter(caller: Caller, id: string, version: number) {
    const r = await this.need(caller, id, 'charter.propose'), uid = callerUid(caller)!;
    await this.store.charterTx(id, async vs => {
      const c = vs.find(v => v.version === version && v.status === 'proposed');
      if (!c) throw new LedgerError('not_found', `No open proposal ${version}`);
      if (c.by !== uid && r.relation !== 'owner') throw new LedgerError('forbidden', 'Only the proposer or the owner can withdraw a proposal');
      return { put: [{ ...c, status: 'withdrawn', closedAt: Date.now() }], out: null };
    });
    return this.charter(caller, id);
  }

  /** An open proposal takes effect once every owner and member has agreed; the version it replaces becomes superseded. */
  private async settle(id: string) {
    const people = (await this.store.members(id)).filter(m => m.role !== 'guest').map(m => m.uid);
    await this.store.charterTx(id, async vs => {
      const open = vs.find(c => c.status === 'proposed');
      if (!open || !people.length || !people.every(u => open.consents[u]?.agree)) return { put: [], out: null };
      const now = Date.now(), old = vs.find(c => c.status === 'active');
      const put: CharterVersion[] = [{ ...open, status: 'active', activeAt: now }];
      if (old) put.push({ ...old, status: 'superseded', closedAt: now });
      return { put, out: null };
    });
  }

  /** The charter gate on team content: the space is open once a charter is in force, and an owner or member enters after
   *  agreeing to that version. Guests and the team's agent enter an open space without a consent of their own. */
  private async gate(caller: Caller, id: string, r: Rel) {
    const active = (await this.store.charters(id)).find(c => c.status === 'active');
    if (!active) throw new LedgerError('consent_required', 'This team space opens once everyone has agreed to its charter');
    if ((r.relation === 'owner' || r.relation === 'member') && !active.consents[callerUid(caller)!]?.agree) {
      throw new LedgerError('consent_required', `Agree to the team charter (version ${active.version}) to enter this space`, { version: active.version });
    }
  }

  /** The relation tuple behind a call: the caller's membership, or a team agent's delegation by this space. */
  private async relation(caller: Caller, id: string): Promise<Rel> {
    if (typeof id !== 'string' || !SPACE_ID.test(id)) throw new LedgerError('invalid', 'space is "personal" or a team space id');
    if (caller.kind === 'team_agent') return { relation: caller.space === id && await this.store.space(id) ? 'delegate' : 'none' };
    const m = await this.store.membership(id, assertUid(caller.uid));
    return m ? { relation: m.role, member: m } : { relation: 'none' };
  }
  private check(caller: Caller, relation: Relation, action: Action) {
    const d = decide(caller, relation, action);
    if (!d.allow) throw new LedgerError(d.code!, d.code === 'not_found' ? 'No such space' : d.why);
  }
  private async need(caller: Caller, id: string, action: Action): Promise<Rel> {
    const r = await this.relation(caller, id);
    this.check(caller, r.relation, action);
    return r;
  }
}
