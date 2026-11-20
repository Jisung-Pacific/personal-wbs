// Spaces: whose ledger a call works on, and who may do what there. Every account has its personal space (the account
// itself, nothing to create); a team space is made by one person, its owner, who invites members (equal, read and write)
// and guests (read only, and only the projects they are assigned). A small AI-native team is the target: usually 2–5
// people, at most 10 per space. A team space's ledger lives under spaces/<id> with its own data key, so its rows, history
// and name are sealed apart from every member's personal ledger, and deleting the space shreds that key.
//
// One account, many teams (execution WBS 5.3): a person joins a team only by accepting an invitation, by their own hand
// — a one-time link the owner hands to them, or an invitation addressed to their account — so nobody is put in a team
// without saying yes, and the same account moves between its personal space and every team it has joined.
//
// Every decision goes through the permission table (access.ts): the stored membership is the relation tuple, the table
// says what it grants, and agents act within the person's relation and scopes but never govern a space.
//
// The team charter (at most 9 lines) gates the space: it opens once a charter is in force, which takes every owner's and
// member's agreement, and each owner or member enters only after agreeing to the version in force (a newcomer agrees on
// joining). A change is a new version: it takes effect when everyone agrees, the version it replaces is kept as
// superseded, and withdrawn proposals stay too, so the versions with their dated consents are the change record.
import { createHash, randomBytes } from 'node:crypto';
import { spaceOwner, type CharterVersion, type Invite, type Membership, type Store } from '../store/types.js';
import { LedgerError, type View } from './service.js';
import { callerUid, decide, type Action, type Caller, type Relation } from './access.js';

export const PERSONAL = 'personal';
export const MAX_PEOPLE = 10;
export const TITLE_MAX = 30;   // a display title, in characters
const SPACE_ID = /^s_[A-Za-z0-9_-]{22}$/;
const PROJECT = /^\d{4}:\d+\.\d+$/;   // a package of one year, e.g. "2026:4.3"
export const CHARTER_LINES = 9;
export const INVITE_DAYS = 7;
const INVITE_ID = /^i_[A-Za-z0-9_-]{16}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;   // a link invitation's code: 32 random bytes, base64url; only its SHA-256 is stored
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** How a person names an invitation: the code of a link invitation, or a space and an invitation addressed to them. */
export type InviteRef = { code: string } | { space: string; invite: string };

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

  /** The owner changes someone's role (member or guest) or a guest's projects. People join only by accepting an
   *  invitation (invite, join); becoming owner is a hand-over (transfer). */
  async setMember(caller: Caller, id: string, who: string, role: 'member' | 'guest', projects?: string[]) {
    await this.need(caller, id, 'members.manage');
    assertUid(who);
    if (role !== 'member' && role !== 'guest') throw new LedgerError('invalid', 'role is member or guest');
    const cur = await this.store.membership(id, who);
    if (!cur) throw new LedgerError('invalid', 'Not in this space: people join by accepting an invitation');
    if (cur.role === 'owner') throw new LedgerError('invalid', 'The owner\'s role changes only by a hand-over');
    const p = role === 'guest' ? cleanProjects(projects ?? cur.projects) : undefined;
    if (role === 'member' && projects !== undefined) throw new LedgerError('invalid', 'Members see every project; projects are for guests');
    await this.store.putMember(id, { uid: who, role, since: cur.since, by: callerUid(caller)!, ...(p ? { projects: p } : {}), ...(cur.title ? { title: cur.title } : {}) });
    if (role === 'guest' && cur.role !== 'guest') await this.left?.(id, who);   // a guest shares nothing with the team
    await this.settle(id);   // a member who becomes a guest no longer holds up a proposal
    return { uid: who, role, ...(p ? { projects: p } : {}) };
  }

  /** A display title (execution WBS 3.9; the strategy's decision 7: "직함은 표시용"): words beside a name — 대표, 공동
   *  창업자, 연구원, 자문 — that grant nothing; the role does. Each person sets their own; the owner may set or clear
   *  anyone's. People only, on the hub's page: an agent never edits a membership. An empty title clears it. */
  async setTitle(caller: Caller, id: string, who: string, title: string) {
    assertUid(who);
    await this.need(caller, id, who === callerUid(caller) ? 'title.self' : 'members.manage');
    const t = String(title ?? '').replace(/\s+/g, ' ').trim();
    if ([...t].length > TITLE_MAX || /[\u0000-\u001f\u007f]/.test(t)) throw new LedgerError('invalid', `A title is plain text of at most ${TITLE_MAX} characters`);
    const cur = await this.store.membership(id, who);
    if (!cur) throw new LedgerError('invalid', 'Not in this space');
    const { title: _old, ...rest } = cur;
    await this.store.putMember(id, t ? { ...rest, title: t } : rest);
    return { space: id, uid: who, title: t || null };
  }

  // ---------------------------------------------------------------- invitations (execution WBS 5.3)
  /** The owner invites one person as a member or a guest (with its projects): by a link, whose one-time code is
   *  returned only here, or by naming the person's account, where it waits in their list. Nobody joins until they
   *  accept. Open invitations hold seats: members and open invitations together stay within MAX_PEOPLE. */
  async invite(caller: Caller, id: string, o: { role: 'member' | 'guest'; projects?: string[]; for?: string }) {
    await this.need(caller, id, 'members.manage');
    if (o.role !== 'member' && o.role !== 'guest') throw new LedgerError('invalid', 'role is member or guest');
    if (o.role === 'member' && o.projects?.length) throw new LedgerError('invalid', 'Members see every project; projects are for guests');
    const projects = o.role === 'guest' ? cleanProjects(o.projects) : undefined, who = o.for === undefined ? undefined : assertUid(o.for);
    const now = Date.now(), [ms, all] = await Promise.all([this.store.members(id), this.store.invites(id)]);
    const open = all.filter(i => i.status === 'open' && i.expires > now);
    if (who && ms.some(m => m.uid === who)) throw new LedgerError('invalid', 'Already in this space');
    if (who && open.some(i => i.for === who)) throw new LedgerError('duplicate', 'An invitation for this account is already open');
    if (ms.length + open.length >= MAX_PEOPLE) throw new LedgerError('invalid', `A team space holds at most ${MAX_PEOPLE} people, open invitations included`);
    const code = who ? undefined : randomBytes(32).toString('base64url');
    const inv: Invite = { id: 'i_' + randomBytes(12).toString('base64url'), space: id, role: o.role, ...(projects ? { projects } : {}),
      ...(code ? { hash: sha256(code) } : { for: who }), by: callerUid(caller)!, at: now, expires: now + INVITE_DAYS * 864e5, status: 'open' };
    await this.store.putInvite(inv);
    return { ...this.shown(inv, now), ...(code ? { code } : {}) };
  }

  /** The owner's record of the space's invitations, newest first: open, expired, joined, declined or revoked. */
  async invites(caller: Caller, id: string) {
    await this.need(caller, id, 'members.manage');
    const now = Date.now();
    return (await this.store.invites(id)).map(i => this.shown(i, now));
  }

  /** The owner takes back an open invitation; it stays in the record as revoked. */
  async revoke(caller: Caller, id: string, iid: string) {
    await this.need(caller, id, 'members.manage');
    if (typeof iid !== 'string' || !INVITE_ID.test(iid)) throw new LedgerError('not_found', 'No open invitation with this id');
    return this.store.inviteTx(id, iid, async inv => {
      if (!inv || inv.status !== 'open') throw new LedgerError('not_found', 'No open invitation with this id');
      return { put: { ...inv, status: 'revoked', closed: Date.now() }, out: { revoked: inv.id } };
    });
  }

  /** What a person reads before answering: the team, the role offered (a guest's projects), who invited and until when,
   *  whether they are in the team already, and for a member the charter in force they agree to on joining (or the open
   *  proposal they will be asked to answer). */
  async preview(caller: Caller, ref: InviteRef) {
    const { inv, uid } = await this.resolve(caller, ref);
    const [s, me, vs] = await Promise.all([this.store.space(inv.space), this.store.membership(inv.space, uid), this.store.charters(inv.space)]);
    if (!s) throw this.gone();
    const active = vs.find(c => c.status === 'active'), open = vs.find(c => c.status === 'proposed'), member = inv.role === 'member';
    return { space: { id: s.id, name: s.name }, invite: inv.id, role: inv.role, ...(inv.projects ? { projects: inv.projects } : {}),
      by: inv.by, expires: inv.expires, already: me?.role ?? null,
      charter: member && active ? { version: active.version, lines: active.lines } : null,
      proposal: member && open ? { version: open.version, lines: open.lines } : null };
  }

  /** A person accepts and joins, by their own hand. A member agrees to the charter in force on joining (`agree`: the
   *  version they read; without it the answer is consent_required with that version); a guest has none to agree to.
   *  One use: the invitation closes as joined in the same step that adds the person, and a full team refuses. */
  async join(caller: Caller, ref: InviteRef, agree?: number) {
    const { inv, uid } = await this.resolve(caller, ref);
    if (await this.store.membership(inv.space, uid)) throw new LedgerError('invalid', 'You are already in this space');
    const active = inv.role === 'member' ? (await this.store.charters(inv.space)).find(c => c.status === 'active') : undefined;
    if (active && agree !== active.version) throw new LedgerError('consent_required', `Agree to the team charter (version ${active.version}) to join`, { version: active.version });
    const now = Date.now();
    await this.store.inviteTx(inv.space, inv.id, async (cur, ms) => {
      if (!cur || cur.status !== 'open' || cur.expires <= now) throw this.gone();
      if (ms.some(m => m.uid === uid)) throw new LedgerError('invalid', 'You are already in this space');
      if (ms.length >= MAX_PEOPLE) throw new LedgerError('invalid', `This team space is full (${MAX_PEOPLE} people)`);
      return { put: { ...cur, status: 'joined', who: uid, closed: now },
        member: { uid, role: cur.role, since: now, by: cur.by, ...(cur.role === 'guest' ? { projects: cur.projects ?? [] } : {}) }, out: null };
    });
    if (active) await this.store.charterTx(inv.space, async vs => {   // the version they read, if it is still the one in force
      const c = vs.find(v => v.status === 'active' && v.version === agree);
      return { put: c ? [{ ...c, consents: { ...c.consents, [uid]: { agree: true, at: now } } }] : [], out: null };
    });
    const s = await this.store.space(inv.space);
    return { space: inv.space, name: s?.name ?? '', role: inv.role };
  }

  /** A person says no; the invitation closes as declined (a link cannot be used after that). */
  async decline(caller: Caller, ref: InviteRef) {
    const { inv, uid } = await this.resolve(caller, ref);
    return this.store.inviteTx(inv.space, inv.id, async cur => {
      if (!cur || cur.status !== 'open') throw this.gone();
      return { put: { ...cur, status: 'declined', who: uid, closed: Date.now() }, out: { declined: cur.id } };
    });
  }

  /** The account invitations waiting for the caller, soonest to lapse first, with each team's name: for the person, or
   *  an agent reading for them (it may tell them; only the person answers). A team's agent has none. */
  async received(caller: Caller) {
    if (caller.kind === 'team_agent') return [];
    if (caller.kind === 'agent' && !caller.scopes.includes('wbs.read')) throw new LedgerError('forbidden', 'Reading invitations needs the wbs.read scope');
    const uid = assertUid(caller.uid), now = Date.now();
    const found = await Promise.all((await this.store.invitesFor(uid)).map(async r => {
      const [inv, s] = await Promise.all([this.store.invite(r.space, r.id), this.store.space(r.space)]);
      return inv && s && inv.status === 'open' && inv.expires > now && inv.for === uid
        ? { space: s.id, invite: inv.id, name: s.name, role: inv.role, ...(inv.projects ? { projects: inv.projects } : {}), by: inv.by, expires: inv.expires } : null;
    }));
    return found.filter(x => x !== null).sort((a, b) => a.expires - b.expires);
  }

  /** An invitation as its owner sees it; an open one past its date reads as expired. */
  private shown(i: Invite, now: number) {
    return { id: i.id, kind: i.for ? 'account' as const : 'link' as const, role: i.role, ...(i.projects ? { projects: i.projects } : {}), ...(i.for ? { for: i.for } : {}),
      by: i.by, at: i.at, expires: i.expires, status: i.status === 'open' && i.expires <= now ? 'expired' as const : i.status,
      ...(i.who ? { who: i.who } : {}), ...(i.closed ? { closed: i.closed } : {}) };
  }
  private gone() { return new LedgerError('not_found', 'This invitation cannot be used: it was used, revoked or has expired, or it is for another account'); }
  /** The open invitation a person names, if it is theirs to answer: a link's code works for whoever holds it, an account
   *  invitation only for its account. Anything else reads the same, so codes and ids cannot be probed. People only. */
  private async resolve(caller: Caller, ref: InviteRef): Promise<{ inv: Invite; uid: string }> {
    if (caller.kind !== 'person') throw new LedgerError('forbidden', 'Joining a team is for people, by their own hand, not agents');
    const uid = assertUid(caller.uid), byCode = !!ref && typeof ref === 'object' && 'code' in ref;
    let at: { space: string; id: string } | null = null;
    if (byCode) { const c = (ref as { code: unknown }).code; if (typeof c === 'string' && CODE.test(c)) at = await this.store.inviteByHash(sha256(c)); }
    else {
      const r = ref as { space?: unknown; invite?: unknown };
      if (typeof r?.space === 'string' && SPACE_ID.test(r.space) && typeof r.invite === 'string' && INVITE_ID.test(r.invite)) at = { space: r.space, id: r.invite };
    }
    const inv = at && await this.store.invite(at.space, at.id);
    if (!inv || inv.status !== 'open' || inv.expires <= Date.now()) throw this.gone();
    if (byCode ? inv.hash !== sha256((ref as { code: string }).code) : inv.for !== uid) throw this.gone();
    return { inv, uid };
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

  /** What deleting the account would do to its team spaces, shown before the person decides: the spaces it owns alone go
   *  with it, it leaves the others, and a space it owns with other people blocks the deletion until it is handed over or
   *  deleted (`people`: members and guests besides the owner). */
  async deletionPlan(uid: string) {
    assertUid(uid);
    const mine = await Promise.all((await this.store.spacesOf(uid)).map(async s => ({ ...s, people: (await this.store.members(s.id)).length - 1 })));
    return {
      deletes: mine.filter(s => s.role === 'owner' && s.people === 0).map(s => s.id),
      leaves: mine.filter(s => s.role !== 'owner').map(s => ({ id: s.id, role: s.role })),
      blocks: mine.filter(s => s.role === 'owner' && s.people > 0).map(s => ({ id: s.id, people: s.people })),
    };
  }

  /** A person deletes their own account (the hub's page asks them first; no agent can). Nothing is removed while a space
   *  it owns with others blocks it. Then, in this order: the tombstone (every token and session issued before now stops:
   *  auth/revocations.ts), the spaces it owns alone, its place in the others (as when leaving: its card goes, its
   *  delegations end, its shared rows stay as frozen copies — or go too with `withShared`), and its own ledger, secrets and
   *  refresh tokens (Store.deleteAccount). */
  async deleteAccount(uid: string, opts: { now?: number; withShared?: boolean } = {}) {
    const plan = await this.deletionPlan(uid), now = opts.now ?? Date.now();
    if (plan.blocks.length) throw new LedgerError('invalid', `Hand ${plan.blocks.map(b => b.id).join(', ')} to a member, or delete it, before deleting the account`, { blocks: plan.blocks });
    await this.store.markDeleted(uid, now);
    for (const id of plan.deletes) await this.store.deleteSpace(id);
    let sharedRemoved = 0;
    for (const s of plan.leaves) {
      await this.store.removeMember(s.id, uid); await this.left?.(s.id, uid);
      if (opts.withShared) for (const w of await this.store.shared(s.id)) if (w.uid === uid) { await this.store.removeShared(s.id, w.id); sharedRemoved++; }
      await this.settle(s.id);
    }
    await this.store.deleteAccount(uid);
    return { deleted: true as const, at: now, spaces_deleted: plan.deletes.length, spaces_left: plan.leaves.length, shared_removed: sharedRemoved };
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
