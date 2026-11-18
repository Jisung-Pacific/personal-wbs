// Spaces: whose ledger a call works on, and who may do what there. Every account has its personal space (the account
// itself, nothing to create); a team space is made by one person, its owner, who adds members (equal, read and write)
// and guests (read only, and only the projects they are assigned). A small AI-native team is the target: usually 2–5
// people, at most 10 per space. A team space's ledger lives under spaces/<id> with its own data key, so its rows, history
// and name are sealed apart from every member's personal ledger, and deleting the space shreds that key.
//
// Every decision goes through the permission table (access.ts): the stored membership is the relation tuple, the table
// says what it grants, and agents act within the person's relation and scopes but never govern a space.
import { randomBytes } from 'node:crypto';
import { spaceOwner, type Membership, type Store } from '../store/types.js';
import { LedgerError, type View } from './service.js';
import { callerUid, decide, type Action, type Caller, type Relation } from './access.js';

export const PERSONAL = 'personal';
export const MAX_PEOPLE = 10;
const SPACE_ID = /^s_[A-Za-z0-9_-]{22}$/;
const PROJECT = /^\d{4}:\d+\.\d+$/;   // a package of one year, e.g. "2026:4.3"

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

type Rel = { relation: Relation; member?: Membership };

export class Spaces {
  constructor(private store: Store) {}

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
      const [s, me] = await Promise.all([this.store.space(m.id), this.store.membership(m.id, caller.uid)]);
      if (!s || !me) return null;
      return { id: s.id, kind: 'team' as const, name: s.name, role: me.role, ...(me.role === 'guest' ? { projects: me.projects ?? [] } : {}) };
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
    for (const s of mine) await (s.role === 'owner' ? this.store.deleteSpace(s.id) : this.store.removeMember(s.id, uid));
    await this.store.deleteAccount(uid);
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
