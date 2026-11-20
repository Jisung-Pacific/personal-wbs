// The team master agent (execution WBS 4.5). The strategy: "에이전트는 제안하고 사람은 승인한다. 개인 행은 본인이, 팀 계획
// 변경은 그 작업의 A가 승인한다"; "팀 마스터 에이전트는 팀 요약본만 읽고 추천만 한다. 배정·평가는 사람이, 근거를 보이며";
// "주간 보고를 사람이 쓰지 않는다. 사람은 승인만"; 4.5: "제안 → A 승인, 언제든 중단", done when "주간 보고 수기 작성 0".
//
// The team's owner delegates an agent through the team's agent address (/mcp/t/<space>/agent): only the owner can approve
// that connection, and the agent then acts as the team's delegate, never as the owner. It reads the team summary only —
// the plan against the actual work without names, the intents in counts, the weekly brief, the charter — and no one's
// ledger, cards or view logs. It writes nothing itself. A plan change is a proposal, checked as a write would be and
// applied once the accountable person (A) of every item it touches approves: the item's own A, else its nearest parent's,
// else the owner. The weekly report it drafts for an ended week reaches the team only once the owner approves it, and it
// names no one. Approving is a person's own act on the hub's pages. The owner stops a delegation at any moment: its grant
// is revoked, its next call is refused and its open proposals are withdrawn. Every proposal and report carries the agent
// that wrote it and the person who decided (Shavit et al., 2023, Practices for Governing Agentic AI Systems, OpenAI:
// approval, legibility, attributability, interruptibility; Chan et al., 2024, Visibility into AI Agents, FAccT). The agent
// recommends and never assigns or rates people (Kellogg, Valentine & Christin, 2020, Academy of Management Annals 14(1):
// algorithmic control by recommending, recording, rating, replacing).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Proposal, Store, WeeklyReport } from '../store/types.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller } from './access.js';
import type { Spaces } from './spaces.js';
import { PlanItemInput, accountableFor, type Plans } from './plan.js';
import { lastFullWeek, weekRange } from './weekly.js';
import { todayKst } from './model.js';

const kst = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
export const MAX_REPORT = 4000, MAX_RECS = 5, MAX_OPEN = 20;

export const ProposeInput = z.object({
  items: z.array(PlanItemInput.omit({ accountable: true })).min(1).max(20).describe('Plan item changes or new items, in wbs_plan_put\'s shape (A is set by people only)'),
  why: z.string().min(10).max(600).describe('What in the team summary calls for it'),
  refs: z.array(z.string().max(80)).max(10).optional().describe('What it rests on: plan codes, the week of the brief'),
});
export const ReportInput = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/).optional().describe('An ended ISO week; default the last one'),
  text: z.string().min(40).max(MAX_REPORT).describe('The report, about the work only: what moved, what is stuck, what is at risk, what to decide'),
  recommendations: z.array(z.object({ text: z.string().min(5).max(300), refs: z.array(z.string().max(80)).max(5).optional() })).max(MAX_RECS).optional(),
});

export class MasterAgent {
  constructor(private store: Store, private spaces: Spaces, private plans: Plans, private today: () => string = todayKst) {}

  private agent(caller: Caller) {
    if (caller.kind !== 'team_agent') throw new LedgerError('forbidden', 'Only the team master agent proposes; people change the plan themselves');
    return caller;
  }
  private person(caller: Caller) {
    if (caller.kind !== 'person') throw new LedgerError('forbidden', 'Approving is a person\'s own act, on the hub\'s pages; agents do not approve');
    return caller.uid;
  }

  /** Whether a delegation is live; every call through the agent address checks it, so stopping takes effect at once. */
  async active(space: string, clientId: string) { return (await this.store.delegations(space)).some(d => d.client_id === clientId && d.active); }

  /** The team's delegations: the owner sees them all, with who delegated and when; members see which agents act for the team. */
  async delegations(caller: Caller, space: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    if (e.relation === 'guest' || e.relation === 'delegate') throw new LedgerError('forbidden', 'The team\'s owner and members see its delegations');
    const all = await this.store.delegations(space);
    return all.map(d => ({ client_id: d.client_id, client_name: d.client_name, by: d.by, since: kst(d.at), active: d.active,
      last: d.last ? kst(d.last) : null, stopped: d.stopped ? { by: d.stopped.by, at: kst(d.stopped.at) } : null }));
  }

  /** Stops a delegation now (the owner): its grant is revoked, its next call refused, its open proposals withdrawn and its
   *  report drafts set aside. */
  async stop(caller: Caller, space: string, clientId: string) {
    const me = this.person(caller);
    await this.spaces.enter(caller, space, 'agent.manage');
    const d = (await this.store.delegations(space)).find(x => x.client_id === clientId);
    if (!d) throw new LedgerError('not_found', 'No such delegation');
    if (d.family) await this.store.revokeFamily(d.family);
    const { family: _f, ...rest } = d;
    await this.store.putDelegation(space, { ...rest, active: false, stopped: { by: me, at: Date.now() } });
    let withdrawn = 0;
    for (const p of await this.store.proposals(space)) {
      if (p.status !== 'open' || p.client_id !== clientId) continue;
      await this.store.putProposal(space, { ...p, status: 'withdrawn', closed: Date.now(), note: '위임 중단' }); withdrawn++;
    }
    for (const r of await this.store.reports(space)) if (r.status === 'proposed' && r.client_id === clientId) await this.store.putReport(space, { ...r, status: 'withdrawn' });
    return { space, client_id: clientId, stopped: true, withdrawn };
  }

  private async used(space: string, clientId: string) {
    const d = (await this.store.delegations(space)).find(x => x.client_id === clientId);
    if (d && (!d.last || Date.now() - d.last > 3600e3)) await this.store.putDelegation(space, { ...d, last: Date.now() });
  }

  /** The agent proposes plan changes: checked as a write would be, then waiting for the accountable people to approve. */
  async propose(caller: Caller, space: string, raw: z.input<typeof ProposeInput>) {
    const a = this.agent(caller);
    await this.spaces.enter(caller, space, 'plan.propose');
    const input = ProposeInput.parse(raw), all = await this.store.proposals(space);
    const same = all.find(p => p.status === 'open' && JSON.stringify(p.items) === JSON.stringify(input.items));
    if (same) return { space, id: same.id, status: same.status, approvers: same.approvers.length, preview: same.preview, repeated: true };
    if (all.filter(p => p.status === 'open').length >= MAX_OPEN) throw new LedgerError('invalid', `${MAX_OPEN} proposals already wait for a decision; let people decide them first`);
    const preview = await this.plans.preview(space, input.items);
    const [items, s] = await Promise.all([this.store.plan(space), this.store.space(space)]);
    const approvers = new Set<string>();
    for (const v of preview) {
      const who = accountableFor(items, v.year, v.code), m = who ? await this.store.membership(space, who) : null;
      approvers.add(who && m && m.role !== 'guest' ? who : s!.owner);   // an A who left, or none: the owner decides
    }
    const base = Object.fromEntries(preview.map(v => [`${v.year}:${v.code}`, v.created ? 0 : items.find(i => i.year === v.year && i.code === v.code)!.updated]));
    const p: Proposal = { id: 'p_' + randomBytes(9).toString('base64url'), items: input.items as Record<string, unknown>[], why: input.why.trim(), refs: input.refs ?? [],
      client: a.client, client_id: a.clientId ?? '', at: Date.now(), preview, approvers: [...approvers].sort(), decisions: {}, base, status: 'open' };
    await this.store.putProposal(space, p);
    await this.used(space, p.client_id);
    return { space, id: p.id, status: p.status, approvers: p.approvers.length, preview };
  }

  /** A person decides a proposal they are accountable for. All approvers approving applies it (as the last one's write,
   *  logged with the proposal); one decline closes it; a plan that moved meanwhile makes it stale. */
  async decide(caller: Caller, space: string, pid: string, approve: boolean, note = '') {
    const me = this.person(caller);
    await this.spaces.enter(caller, space, 'proposal.decide');
    const step = await this.store.proposalTx(space, pid, async p => {
      if (!p) throw new LedgerError('not_found', 'No such proposal');
      if (p.status !== 'open') throw new LedgerError('invalid', `This proposal is ${p.status}`);
      if (!p.approvers.includes(me)) throw new LedgerError('forbidden', 'Only the accountable person (A) of the items it touches decides it');
      if (p.decisions[me]) throw new LedgerError('invalid', 'You have decided this proposal already');
      const next: Proposal = { ...p, decisions: { ...p.decisions, [me]: { approve, at: Date.now(), note: note.trim().slice(0, 300) } } };
      if (!approve) return { put: { ...next, status: 'declined', closed: Date.now() }, out: { p: next, ready: false } };
      return { put: next, out: { p: next, ready: p.approvers.every(u => next.decisions[u]?.approve) } };
    });
    if (!approve) return { space, id: pid, status: 'declined' as const };
    if (!step.ready) return { space, id: pid, status: 'open' as const, waiting: step.p.approvers.filter(u => !step.p.decisions[u]).length };
    const p = step.p, items = await this.store.plan(space);
    const moved = Object.entries(p.base).filter(([k, u]) => (items.find(i => `${i.year}:${i.code}` === k)?.updated ?? 0) !== u).map(([k]) => k.replace(':', ' '));
    const close = async (status: Proposal['status'], extra: Partial<Proposal> = {}) =>
      this.store.proposalTx(space, pid, async cur => ({ put: cur ? { ...cur, status, closed: Date.now(), ...extra } : undefined, out: null }));
    if (moved.length) { await close('stale', { note: `계획이 그사이 바뀜: ${moved.join(', ')}` }); return { space, id: pid, status: 'stale' as const, moved }; }
    try {
      await this.plans.put(caller, space, { items: p.items as z.input<typeof PlanItemInput>[], memo: `팀 마스터 에이전트(${p.client}) 제안 ${p.id} 승인` });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      await close('stale', { note: e.message }); return { space, id: pid, status: 'stale' as const, reason: e.message };
    }
    await close('applied');
    return { space, id: pid, status: 'applied' as const, changed: p.preview.map(v => `${v.year} ${v.code}`) };
  }

  /** The agent drafts the weekly report for an ended week; a new draft replaces an earlier one until the owner decides. */
  async proposeReport(caller: Caller, space: string, raw: z.input<typeof ReportInput>) {
    const a = this.agent(caller);
    await this.spaces.enter(caller, space, 'plan.propose');
    const input = ReportInput.parse(raw), today = this.today(), w = input.week ? weekRange(input.week) : lastFullWeek(today);
    if (w.to >= today) throw new LedgerError('invalid', 'Report on a week that has ended');
    const cur = await this.store.report(space, w.week);
    if (cur?.status === 'approved') throw new LedgerError('duplicate', `The report for ${w.week} is approved already`);
    // about the work only: no member's account id or name anywhere in it
    const people = (await Promise.all((await this.store.members(space)).map(async m => [m.uid, (await this.store.secret<{ name?: string }>(m.uid, 'profile'))?.name ?? '']))).flat()
      .filter(x => x.trim().length >= 2);
    const text = [input.text, ...(input.recommendations ?? []).map(r => r.text)].join('\n'), hit = people.find(x => text.includes(x));
    if (hit) throw new LedgerError('invalid', `A weekly report is about the work and names no one; "${hit}" names a person. Write about plan items instead`);
    const r: WeeklyReport = { week: w.week, text: input.text.trim(), recommendations: (input.recommendations ?? []).map(x => ({ text: x.text.trim(), refs: x.refs ?? [] })),
      client: a.client, client_id: a.clientId ?? '', at: Date.now(), status: 'proposed' };
    await this.store.putReport(space, r);
    await this.used(space, r.client_id);
    return { space, week: w.week, status: r.status, note: 'The team sees it once the owner approves it' };
  }

  /** The owner approves or declines a week's draft. */
  async decideReport(caller: Caller, space: string, week: string, approve: boolean, note = '') {
    const me = this.person(caller);
    await this.spaces.enter(caller, space, 'agent.manage');
    const r = await this.store.report(space, weekRange(week).week);
    if (!r) throw new LedgerError('not_found', `No report drafted for ${week}`);
    if (r.status !== 'proposed') throw new LedgerError('invalid', `The report for ${week} is ${r.status}`);
    await this.store.putReport(space, { ...r, status: approve ? 'approved' : 'declined', decided: { by: me, at: Date.now(), note: note.trim().slice(0, 300) } });
    return { space, week: r.week, status: approve ? 'approved' as const : 'declined' as const };
  }

  /** The approved report of a week, as the team reads it beside the brief. */
  async approved(space: string, week: string) {
    const r = await this.store.report(space, week);
    return r?.status === 'approved' ? { week: r.week, text: r.text, recommendations: r.recommendations, client: r.client, approved: kst(r.decided!.at) } : null;
  }

  /** What the caller has to see. People: the open proposals (marked where they decide), the report drafts (the owner),
   *  approved reports and recent decisions. The team agent: its own proposals and reports and how they were decided. */
  async list(caller: Caller, space: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    if (e.relation === 'guest') throw new LedgerError('forbidden', 'Proposals are for the team\'s owner and members');
    const [props, reps, s] = await Promise.all([this.store.proposals(space), this.store.reports(space), this.store.space(space)]);
    const view = (p: Proposal) => ({ id: p.id, at: kst(p.at), client: p.client, why: p.why, refs: p.refs, preview: p.preview, status: p.status, note: p.note ?? null,
      approvers: p.approvers.map(u => ({ uid: u, decided: p.decisions[u] ? (p.decisions[u].approve ? 'approve' : 'decline') : null })) });
    const rep = (r: WeeklyReport) => ({ week: r.week, status: r.status, client: r.client, at: kst(r.at), text: r.text, recommendations: r.recommendations,
      decided: r.decided ? { at: kst(r.decided.at), note: r.decided.note } : null });
    if (caller.kind === 'team_agent') {
      return { space, proposals: props.filter(p => p.client_id === caller.clientId).slice(-20).map(p => ({ ...view(p), approvers: p.approvers.length })),
        reports: reps.filter(r => r.client_id === caller.clientId).slice(-8).map(r => ({ week: r.week, status: r.status, decided: r.decided ? { at: kst(r.decided.at), note: r.decided.note } : null })) };
    }
    const me = callerUid(caller)!, owner = s!.owner === me;
    return { space,
      open: props.filter(p => p.status === 'open').map(p => ({ ...view(p), mine_to_decide: p.approvers.includes(me) && !p.decisions[me] })),
      decided: props.filter(p => p.status !== 'open').slice(-10).reverse().map(view),
      drafts: owner ? reps.filter(r => r.status === 'proposed').map(rep) : [],
      reports: reps.filter(r => r.status === 'approved').slice(-6).reverse().map(rep) };
  }

  /** What a team screen shows: the agents delegated, what waits for the caller, and the latest approved report. */
  async summary(caller: Caller, space: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    if (e.relation === 'guest') return null;
    const [dels, props, reps, s] = await Promise.all([this.store.delegations(space), this.store.proposals(space), this.store.reports(space), this.store.space(space)]);
    const last = reps.filter(r => r.status === 'approved').at(-1);
    if (caller.kind === 'team_agent') return { open: props.filter(p => p.status === 'open' && p.client_id === caller.clientId).length, last_report: last?.week ?? null };
    const me = callerUid(caller)!;
    return { delegated: dels.filter(d => d.active).map(d => d.client_name), to_decide: props.filter(p => p.status === 'open' && p.approvers.includes(me) && !p.decisions[me]).length,
      drafts: s!.owner === me ? reps.filter(r => r.status === 'proposed').length : 0, last_report: last?.week ?? null };
  }
}
