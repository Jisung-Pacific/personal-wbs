// Spaces: whose ledger a call works on. Every account has its personal space (the account itself, nothing to create);
// a team space is made by one account, its owner, who adds members (equal, read and write) and guests (read only).
// A small AI-native team is the target: usually 2–5 people, at most 10 per space. A team space's ledger lives under
// spaces/<id> with its own data key, so its rows, history and name are sealed apart from every member's personal ledger,
// and deleting the space shreds that key. Personal ledgers are untouched by anything here.
//
// Checks here are the membership baseline (who belongs, and whether a guest is writing). Finer permissions — fields a
// member may share, the agents acting for a member, viewing records — build on these records (execution WBS 3.2).
import { randomBytes } from 'node:crypto';
import { spaceOwner, type Membership, type Owner, type Store } from '../store/types.js';
import { LedgerError } from './service.js';

export const PERSONAL = 'personal';
export const MAX_PEOPLE = 10;
const SPACE_ID = /^s_[A-Za-z0-9_-]{22}$/;

/** An account id as the hub receives it from sign-in; "/" would let it pass for a ledger path, so it is refused. */
export function assertUid(uid: string): string {
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid.length > 128) throw new LedgerError('invalid', 'Invalid account id');
  return uid;
}
function cleanName(name: unknown): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 80) throw new LedgerError('invalid', 'A space name is 1–80 characters');
  return n;
}

export class Spaces {
  constructor(private store: Store) {}

  /** The ledger a call works on. No space (or "personal") is the caller's own ledger. A team space needs membership, and
   *  writing needs more than a guest's role. A space the caller does not belong to answers not_found, never forbidden,
   *  so its existence is not disclosed. */
  async ledgerFor(uid: string, space: string | undefined, need: 'read' | 'write'): Promise<Owner> {
    assertUid(uid);
    if (!space || space === PERSONAL) return uid;
    const m = await this.member(uid, space);
    if (need === 'write' && m.role === 'guest') throw new LedgerError('forbidden', 'A guest can read this space but not write to it');
    return spaceOwner(space);
  }

  async create(uid: string, name: string) {
    assertUid(uid);
    const s = { id: 's_' + randomBytes(16).toString('base64url'), name: cleanName(name), owner: uid, created: Date.now() };
    await this.store.createSpace(s);
    return { id: s.id, name: s.name, role: 'owner' as const };
  }

  /** The personal space first, then each team space with its name and the caller's role. */
  async list(uid: string) {
    assertUid(uid);
    const teams = await Promise.all((await this.store.spacesOf(uid)).map(async m => {
      const s = await this.store.space(m.id);
      return s ? { id: s.id, kind: 'team' as const, name: s.name, role: m.role } : null;
    }));
    return [{ id: PERSONAL, kind: 'personal' as const, name: '', role: 'owner' as const }, ...teams.filter(t => t !== null)];
  }

  /** Everyone in the space, owner first; any member or guest may see who is in it. */
  async members(uid: string, id: string) {
    await this.member(uid, id);
    const order = { owner: 0, member: 1, guest: 2 } as const;
    return (await this.store.members(id)).sort((a, b) => order[a.role] - order[b.role] || a.since - b.since);
  }

  /** The owner adds a member or a guest, or changes one's role. Becoming owner is a transfer, never a role change. */
  async setMember(uid: string, id: string, who: string, role: 'member' | 'guest') {
    await this.owner(uid, id); assertUid(who);
    if (role !== 'member' && role !== 'guest') throw new LedgerError('invalid', 'role is member or guest');
    if (who === uid) throw new LedgerError('invalid', 'The owner\'s role changes only by a transfer');
    const all = await this.store.members(id), cur = all.find(m => m.uid === who);
    if (!cur && all.length >= MAX_PEOPLE) throw new LedgerError('invalid', `A team space holds at most ${MAX_PEOPLE} people`);
    await this.store.putMember(id, { uid: who, role, since: cur?.since ?? Date.now(), by: uid });
    return { uid: who, role };
  }

  /** The owner removes someone, or a member or guest leaves. The owner leaves only after handing the space over. */
  async removeMember(uid: string, id: string, who: string) {
    const me = who === uid ? await this.member(uid, id) : await this.owner(uid, id);
    if (me.role === 'owner' && who === uid) throw new LedgerError('invalid', 'Hand the space to a member before leaving it');
    if (!(await this.store.membership(id, assertUid(who)))) throw new LedgerError('not_found', 'Not in this space');
    await this.store.removeMember(id, who);
    return { removed: who };
  }

  /** The owner hands the space to a member (not a guest); the old owner stays on as a member. */
  async transfer(uid: string, id: string, to: string) {
    await this.owner(uid, id);
    const m = await this.store.membership(id, assertUid(to));
    if (!m || m.role !== 'member') throw new LedgerError('invalid', 'Hand the space to one of its members');
    await this.store.setOwner(id, to);
    return { owner: to };
  }

  /** The owner deletes the space: its key is shredded, then its ledger and memberships are removed. */
  async remove(uid: string, id: string) {
    await this.owner(uid, id);
    await this.store.deleteSpace(id);
    return { deleted: id };
  }

  /** Before an account goes: it leaves every team space, and a space it owns alone goes with it. A space it owns with
   *  others must be handed over first; nothing is removed until every space passes that check. */
  async deleteAccount(uid: string) {
    assertUid(uid);
    const mine = await this.store.spacesOf(uid), owned = mine.filter(s => s.role === 'owner');
    for (const s of owned) if ((await this.store.members(s.id)).length > 1) throw new LedgerError('invalid', `Hand space ${s.id} to a member before deleting the account`);
    for (const s of mine) await (s.role === 'owner' ? this.store.deleteSpace(s.id) : this.store.removeMember(s.id, uid));
    await this.store.deleteAccount(uid);
  }

  private async member(uid: string, id: string): Promise<Membership> {
    assertUid(uid);
    if (typeof id !== 'string' || !SPACE_ID.test(id)) throw new LedgerError('invalid', 'space is "personal" or a team space id');
    const m = await this.store.membership(id, uid);
    if (!m) throw new LedgerError('not_found', 'No such space');
    return m;
  }
  private async owner(uid: string, id: string): Promise<Membership> {
    const m = await this.member(uid, id);
    if (m.role !== 'owner') throw new LedgerError('forbidden', 'Only the space\'s owner can do this');
    return m;
  }
}
