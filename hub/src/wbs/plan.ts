// The team plan ledger (execution WBS 3.4): a team space's project WBS, people's own rows linked to its items, and the
// plan set against the actual work.
//   - Plan items: a code of the plan's own (1, 1.1, 1.1.1 …) per year, a scope, its deliverable and done criterion,
//     prerequisites, owners, status and planned dates. Owners and members write them; guests read the items of their
//     projects. Codes are permanent: an item is parked (백로그), never deleted, and each item keeps its latest changes.
//   - Work stays where it was done: in each person's own ledger. A person links one of their rows to a plan item and
//     picks the fields the team may see (field-level sharing; the charter's default is title, status, dates and
//     deliverable links, while blocker details, evidence and the full task text are shared only when chosen). The hub
//     copies only those fields into the space, under an id that does not reveal the person's own code, and keeps the
//     copy in step whenever the row changes. Unlinking while in the space withdraws the copy; leaving the space or
//     becoming a guest freezes it, because the charter keeps shared copies with the team when someone leaves.
//   - Plan vs actual: for each item, the shared work linked to it or to the items under it, the state and dates that
//     work shows against the plan, the slip against the due date, and flags (late, in progress with no work, plan done
//     with open work, work done with the plan still open, work started on a parked item, waiting on others).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SHARE_FIELDS, type PlanItem, type PlanLink, type Row, type ShareField, type SharedWork, type Store } from '../store/types.js';
import { DATE_RE, STATUSES, codeKey, todayKst } from './model.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller } from './access.js';
import type { Spaces } from './spaces.js';

const CODE = /^\d+(\.\d+){0,3}$/;
const YEAR = /^\d{4}$/;
export const DEFAULT_SHARE: ShareField[] = ['title', 'status', 'start', 'end', 'due', 'last_progress', 'links'];
const LOG_KEEP = 20;
const date = z.string().regex(DATE_RE, 'YYYY-MM-DD, or YYYY-MM when only the month is known');

export const PlanItemInput = z.object({
  code: z.string().regex(CODE).describe('The plan\'s own code: 1, 1.1, 1.1.1 (up to 4 levels); a child needs its parent in the plan'),
  year: z.string().regex(YEAR).optional().describe('Plan year; defaults to this year'),
  scope: z.string().min(1).max(120).optional().describe('What the item is (needed when it is new)'),
  deliverable: z.string().max(300).optional(),
  done: z.string().max(300).optional().describe('The completion criterion'),
  depends_on: z.array(z.string().regex(CODE)).max(10).optional().describe('Codes of the same plan year that must finish first'),
  owners: z.array(z.string().min(1).max(40)).max(6).optional().describe('Who carries it: people, agents or lanes, as the team names them'),
  status: z.enum(STATUSES).optional(),
  start: date.optional(), due: date.optional(),
});
export const PlanPutInput = z.object({
  items: z.array(PlanItemInput).min(1).max(200).describe('New items, or changes to existing ones (only the fields given change)'),
  memo: z.string().max(300).optional().describe('Why it changed; kept in each changed item\'s log'),
});
export const ShareInput = z.object({
  year: z.string().regex(YEAR), code: z.string().regex(/^\d+(\.\d+)+$/).describe('A row of your own ledger'),
  space: z.string().describe('The team space id (wbs_spaces)'),
  plan: z.string().regex(CODE).describe('The plan item the row serves'),
  plan_year: z.string().regex(YEAR).optional().describe('The plan year; defaults to the row\'s year'),
  share: z.array(z.enum(SHARE_FIELDS)).max(SHARE_FIELDS.length).optional()
    .describe('Fields the team may see; status is always included. Default (the charter\'s): title, status, start, end, due, last_progress, links. Add blocker, evidence or task (the full text) only when the person chooses'),
});
export const UnshareInput = z.object({ year: z.string().regex(YEAR), code: z.string().regex(/^\d+(\.\d+)+$/) });
export const PlanReadInput = z.object({
  space: z.string(), view: z.enum(['actual', 'items']).optional(), year: z.string().regex(YEAR).optional(),
});

const byCode = (a: { year: string; code: string }, b: { year: string; code: string }) => a.year.localeCompare(b.year) || codeKey(a.code).localeCompare(codeKey(b.code));
const ancestorsOf = (code: string) => code.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'));
const planKey = (year: string, code: string) => `${year}:${code}`;
const splitPlan = (p: string) => { const [year, code] = p.split(':'); return { year, code }; };
/** A guest sees the items of its projects ("YYYY:<a.b>" covers a.b and everything under it), nothing above them. */
const visibleTo = (projects?: string[]) => (p: { year: string; code: string }) => {
  if (!projects) return true;
  const seg = p.code.split('.');
  return seg.length >= 2 && projects.includes(planKey(p.year, seg.slice(0, 2).join('.')));
};
const workId = (uid: string, year: string, code: string) => createHash('sha256').update(`${uid}|${year}|${code}`).digest('base64url').slice(0, 22);
const clean = (s: string | undefined) => s === undefined ? undefined : s.replace(/\s+/g, ' ').trim();
const days = (d: string) => Date.parse((d.length === 7 ? d + '-01' : d) + 'T00:00:00Z') / 864e5;

/** A row's title: its text up to the first ':' or ';' when that is 4–50 characters, else its first 50 characters. */
export function titleOf(task: string) {
  const head = task.split(/[:;]/, 1)[0].trim();
  if (/[:;]/.test(task) && head.length >= 4 && head.length <= 50) return head;
  return task.length <= 50 ? task : task.slice(0, 50).trimEnd() + '…';
}
/** The http(s) links in a row (its deliverables: a PR, a page, a document), at most five. */
const linksOf = (r: Row) => [...new Set(`${r.task} ${r.evidence}`.match(/https?:\/\/[^\s;,)"'<>]+/g) ?? [])].slice(0, 5).join(' ');
/** What a team may see of one row: the fields the link names, nothing else. */
function project(uid: string, row: Row, link: PlanLink): SharedWork {
  const fields: SharedWork['fields'] = {};
  for (const f of link.share) fields[f] = f === 'title' ? titleOf(row.task) : f === 'links' ? linksOf(row) : row[f];
  return { id: workId(uid, row.year, row.code), uid, plan: link.plan, fields, at: Date.now() };
}

// ---------------------------------------------------------------- plan vs actual
export type Flag = 'late' | 'no_work' | 'plan_done_work_open' | 'work_done_plan_open' | 'parked_but_active' | 'waiting';
const FLAG_KO: Record<Flag, string> = {
  late: '마감 지남', no_work: '진행 중인데 실적 없음', plan_done_work_open: '계획 완료·작업 남음', work_done_plan_open: '작업 완료·계획 미완료',
  parked_but_active: '보류인데 작업 진행', waiting: '대기 중인 작업',
};

/** The state a set of work shows: all done → 완료; else in progress, waiting or parked by what is still open. */
function stateOf(ws: SharedWork[]): string | null {
  if (!ws.length) return null;
  const open = ws.filter(w => w.fields.status !== '완료');
  if (!open.length) return '완료';
  if (open.some(w => w.fields.status === '진행 중')) return '진행 중';
  if (open.some(w => w.fields.status === '대기·심사')) return '대기·심사';
  return '백로그';
}

/** The plan set against the shared work, item by item (work on a child counts for its parents too). `named`: whether the
 *  caller may see who did the work (a guest or the team's agent sees counts only). */
export function planActual(items: PlanItem[], work: SharedWork[], today: string, named: boolean, year?: string) {
  const its = items.filter(p => !year || p.year === year).sort(byCode);
  const known = new Set(items.map(p => planKey(p.year, p.code)));
  const under = (p: PlanItem) => work.filter(w => { const x = splitPlan(w.plan); return x.year === p.year && (x.code === p.code || x.code.startsWith(p.code + '.')); });
  const rows = its.map(p => {
    const ws = under(p), done = ws.filter(w => w.fields.status === '완료').length, state = stateOf(ws);
    const starts = ws.map(w => w.fields.start || '').filter(Boolean).sort(), ends = ws.map(w => w.fields.end || '').filter(Boolean).sort();
    const lasts = ws.map(w => w.fields.last_progress || '').filter(Boolean).sort();
    const actual = { rows: ws.length, done, open: ws.length - done, status: state, start: starts[0] || '', end: state === '완료' ? ends.at(-1) || '' : '',
      last_progress: lasts.at(-1) || '', people: named ? [...new Set(ws.map(w => w.uid))].sort() : new Set(ws.map(w => w.uid)).size };
    const until = state === '완료' ? actual.end : p.status === '완료' ? '' : today;
    const slip = p.due && until ? Math.round(days(until) - days(p.due)) : null;
    const flags: Flag[] = [];
    if (p.due && p.status !== '완료' && state !== '완료' && today > p.due) flags.push('late');
    if (p.status === '진행 중' && !ws.length) flags.push('no_work');
    if (p.status === '완료' && actual.open) flags.push('plan_done_work_open');
    if (state === '완료' && p.status !== '완료') flags.push('work_done_plan_open');
    if (p.status === '백로그' && ws.some(w => w.fields.status === '진행 중')) flags.push('parked_but_active');
    if (ws.some(w => w.fields.status === '대기·심사')) flags.push('waiting');
    const direct = ws.filter(w => splitPlan(w.plan).code === p.code).slice(0, 20)   // the rows linked to this item itself
      .map(w => ({ ...w.fields, ...(named ? { uid: w.uid } : {}), ...(w.frozen ? { frozen: true } : {}) }));
    return { year: p.year, code: p.code, scope: p.scope, deliverable: p.deliverable, done: p.done, depends_on: p.depends_on, owners: p.owners,
      plan: { status: p.status, start: p.start, due: p.due }, actual, slip_days: slip, flags, work: direct };
  });
  const unplanned = work.filter(w => !known.has(w.plan)).map(w => ({ plan: w.plan, ...w.fields, ...(named ? { uid: w.uid } : {}) }));
  const lines = rows.map(r => {
    const a = r.actual, due = r.plan.due ? ` ~${r.plan.due}` : '';
    const act = a.rows ? `${a.done}/${a.rows} ${a.status}` : '—';
    const slip = r.slip_days && r.slip_days > 0 ? ` · ${r.slip_days}일 늦음` : '';
    return `${r.year} ${r.code} ${r.scope} | 계획 ${r.plan.status}${due} | 실적 ${act}${slip}${r.flags.length ? ' | ' + r.flags.map(f => FLAG_KO[f]).join(', ') : ''}`;
  });
  const leaves = rows.filter(r => !rows.some(o => o.year === r.year && o.code.startsWith(r.code + '.')));
  return {
    as_of: today, ...(year ? { year } : {}),
    totals: { items: rows.length, leaf_items: leaves.length, plan_done: leaves.filter(r => r.plan.status === '완료').length,
      with_work: leaves.filter(r => r.actual.rows).length, work_done: leaves.filter(r => r.actual.status === '완료').length,
      late: rows.filter(r => r.flags.includes('late')).length, flagged: rows.filter(r => r.flags.length).length, shared_rows: work.length },
    items: rows, unplanned, lines,
  };
}

// ---------------------------------------------------------------- the service
export class Plans {
  constructor(private store: Store, private spaces: Spaces) {
    spaces.left = (space, uid) => this.dropShared(space, uid);
  }

  /** The plan items the caller may see, in code order, with their latest changes (who changed them only for those who
   *  may see the member list). */
  async list(caller: Caller, space: string, year?: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    const items = (await this.store.plan(space)).filter(visibleTo(e.projects)).filter(p => !year || p.year === year).sort(byCode);
    return { space, items: items.map(p => ({ ...p, by: e.named ? p.by : undefined, log: p.log.map(l => ({ at: l.at, change: l.change, ...(e.named ? { by: l.by, via: l.via } : {}) })) })) };
  }

  /** Plan vs actual for the space (see planActual). */
  async actual(caller: Caller, space: string, year?: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    const vis = visibleTo(e.projects);
    const [items, work] = await Promise.all([this.store.plan(space), this.store.shared(space)]);
    return { space, ...planActual(items.filter(vis), work.filter(w => vis(splitPlan(w.plan))), todayKst(), e.named, year) };
  }

  /** Owners and members add plan items or change them; only the fields given change. Parents come before children
   *  (the batch is applied in code order), prerequisites name items of the same plan year, and codes never go away. */
  async put(caller: Caller, space: string, raw: z.input<typeof PlanPutInput>) {
    await this.spaces.enter(caller, space, 'plan.write');
    const input = PlanPutInput.parse(raw), who = callerUid(caller)!, now = Date.now(), thisYear = todayKst().slice(0, 4);
    const via = caller.kind === 'agent' ? { via: caller.client } : {};   // who recorded it: the person, and the agent acting for them
    const batch = input.items.map(it => ({ ...it, year: it.year || thisYear })).sort(byCode);
    const seen = new Set<string>();
    for (const it of batch) { const k = planKey(it.year, it.code); if (seen.has(k)) throw new LedgerError('invalid', `Plan item ${it.year} ${it.code} appears twice`); seen.add(k); }
    return this.store.planTx(space, async cur => {
      const all = new Map(cur.map(p => [planKey(p.year, p.code), p])), put: PlanItem[] = [], created: string[] = [], changed: string[] = [];
      for (const it of batch) {
        const k = planKey(it.year, it.code), old = all.get(k);
        if (!old && !it.scope) throw new LedgerError('invalid', `New plan item ${it.year} ${it.code} needs a scope`);
        const parent = ancestorsOf(it.code).at(-1);
        if (!old && parent && !all.has(planKey(it.year, parent))) throw new LedgerError('invalid', `Plan item ${it.year} ${it.code}: its parent ${parent} is not in the plan`);
        const p: PlanItem = old ? structuredClone(old)
          : { year: it.year, code: it.code, scope: '', deliverable: '', done: '', depends_on: [], owners: [], status: '백로그', start: '', due: '', updated: now, by: who, log: [] };
        const changes: string[] = [];
        const set = <K extends keyof PlanItem>(f: K, v: PlanItem[K] | undefined) => {
          if (v === undefined || JSON.stringify(p[f]) === JSON.stringify(v)) return;
          changes.push(f === 'status' ? `상태 ${p.status} → ${v}` : f === 'due' ? `마감 ${p.due || '없음'} → ${v || '없음'}` : String(f));
          p[f] = v;
        };
        set('scope', clean(it.scope)); set('deliverable', clean(it.deliverable)); set('done', clean(it.done));
        set('depends_on', it.depends_on && [...new Set(it.depends_on)].sort((a, b) => codeKey(a).localeCompare(codeKey(b))));
        set('owners', it.owners && [...new Set(it.owners.map(o => o.replace(/\s+/g, ' ').trim()).filter(Boolean))]);
        set('status', it.status); set('start', it.start); set('due', it.due);
        if (p.start && p.due && p.due < p.start) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code}: due is before start`);
        if (p.depends_on.includes(p.code)) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code} cannot depend on itself`);
        if (old && !changes.length) continue;
        p.updated = now; p.by = who;
        p.log = [...p.log, { at: now, by: who, ...via, change: (old ? changes.join(', ') : '생성') + (input.memo ? ` — ${input.memo}` : '') }].slice(-LOG_KEEP);
        all.set(k, p); put.push(p); (old ? changed : created).push(`${p.year} ${p.code}`);
      }
      for (const p of put) for (const d of p.depends_on) {
        if (!all.has(planKey(p.year, d))) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code} depends on ${d}, which is not in the plan`);
      }
      return { put, out: { space, created, changed, unchanged: batch.length - created.length - changed.length } };
    });
  }

  /** A person links one of their own rows to a plan item and chooses what the team sees of it; linking again changes
   *  the fields or the item. Returns exactly what the team now sees. */
  async share(caller: Caller, raw: z.input<typeof ShareInput>) {
    const input = ShareInput.parse(raw), uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no rows of its own');
    await this.spaces.enter(caller, input.space, 'work.share');
    const row = await this.store.row(uid, input.year, input.code);
    if (!row) throw new LedgerError('not_found', `No row ${input.year} ${input.code} in your ledger`);
    const planYear = input.plan_year || input.year;
    if (!(await this.store.plan(input.space)).some(p => p.year === planYear && p.code === input.plan)) {
      throw new LedgerError('not_found', `No plan item ${planYear} ${input.plan} in this space`);
    }
    const want = new Set<ShareField>(['status', ...(input.share ?? DEFAULT_SHARE)]), share = SHARE_FIELDS.filter(f => want.has(f));
    const prev = (await this.store.links(uid)).find(l => l.year === input.year && l.code === input.code);
    if (prev && prev.space !== input.space) await this.store.removeShared(prev.space, workId(uid, prev.year, prev.code));
    const link: PlanLink = { year: input.year, code: input.code, space: input.space, plan: planKey(planYear, input.plan), share, at: Date.now() };
    await this.store.putLink(uid, link);
    const w = project(uid, row, link);
    await this.store.putShared(input.space, w);
    return { linked: { year: link.year, code: link.code, space: link.space, plan: link.plan, share }, team_sees: w.fields };
  }

  /** Withdraws a row from the team: its link goes, and the team's copy too while the person is in the space (a copy
   *  frozen by leaving stays with the team). Always allowed for one's own rows. */
  async unshare(caller: Caller, raw: z.input<typeof UnshareInput>) {
    const input = UnshareInput.parse(raw), uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no rows of its own');
    const link = (await this.store.links(uid)).find(l => l.year === input.year && l.code === input.code);
    if (!link) throw new LedgerError('not_found', `Row ${input.year} ${input.code} is not linked to a team plan`);
    const id = workId(uid, link.year, link.code), copy = (await this.store.shared(link.space)).find(w => w.id === id);
    const keep = !!copy?.frozen;   // shared before leaving: the team keeps its copy (the charter); only the link goes
    if (!keep) await this.store.removeShared(link.space, id);
    await this.store.removeLink(uid, link.year, link.code);
    return { unlinked: { year: link.year, code: link.code, space: link.space, plan: link.plan }, team_copy: keep ? 'kept (shared before you left)' : 'removed' };
  }

  /** The caller's own links: which rows serve which team plan items, the fields shared, and the team's copy: live
   *  (follows the row), frozen (kept by the team after the person left or became a guest) or none. */
  async mine(caller: Caller) {
    const uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no rows of its own');
    const links = (await this.store.links(uid)).sort(byCode);
    const copies = new Map<string, SharedWork[]>();
    for (const sp of new Set(links.map(l => l.space))) copies.set(sp, await this.store.shared(sp));
    return links.map(l => {
      const c = copies.get(l.space)?.find(w => w.id === workId(uid, l.year, l.code));
      return { year: l.year, code: l.code, space: l.space, plan: l.plan, share: l.share, team_copy: !c ? 'none' : c.frozen ? 'frozen' : 'live' };
    });
  }

  /** The ledger's hook (service.ts): rows of a personal ledger changed; the team copies of linked ones follow while the
   *  person is an owner or member of the space and the copy is live. */
  async touched(uid: string, keys: { year: string; code: string }[]) {
    const links = await this.store.links(uid);
    for (const k of keys) {
      const l = links.find(x => x.year === k.year && x.code === k.code);
      if (!l) continue;
      const [m, row] = await Promise.all([this.store.membership(l.space, uid), this.store.row(uid, k.year, k.code)]);
      if (!m || m.role === 'guest') continue;   // no longer sharing: the team's copy stays frozen (dropShared)
      if (!row) { await this.store.removeShared(l.space, workId(uid, k.year, k.code)); continue; }
      const copy = (await this.store.shared(l.space)).find(w => w.id === workId(uid, k.year, k.code));
      if (copy?.frozen) continue;   // frozen before a return to the space: share again to make it live
      await this.store.putShared(l.space, project(uid, row, l));
    }
  }

  /** Spaces' hook: someone left a space or became a guest there. What they shared stays with the team, frozen as it
   *  was (the charter); their links stay too, so they can share again on return. */
  private async dropShared(space: string, uid: string) { await this.store.freezeSharedBy(space, uid, Date.now()); }
}
