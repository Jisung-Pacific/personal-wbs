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
import { SHARE_FIELDS, type Intent, type PlanItem, type PlanLink, type Row, type ShareField, type SharedWork, type Store } from '../store/types.js';
import { DATE_RE, STATUSES, codeKey, todayKst } from './model.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller } from './access.js';
import type { Spaces } from './spaces.js';
import type { Views } from './views.js';

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
  intent: z.string().regex(/^(i\d+)?$/).optional().describe('The team intent it serves (an id from the intents); "" clears; children inherit their parent\'s'),
  accountable: z.string().regex(/^([A-Za-z0-9_-]{3,128})?$/).optional().describe('A: the one owner or member (account id) who approves agents\' proposals for this item; "" clears; unset → the parent\'s, else the team owner'),
});
export const MAX_INTENTS = 5;
export const IntentInput = z.object({
  id: z.string().regex(/^i\d+$/).optional().describe('An existing intent to change; omit to add one'),
  why: z.string().min(1).max(160).optional().describe('Why the team does this (needed when new)'),
  what: z.string().max(160).optional().describe('What it delivers'), how: z.string().max(160).optional().describe('How the team works on it'),
  rank: z.number().int().min(1).max(9).optional().describe('Priority, 1 first'),
  status: z.enum(['active', 'retired']).optional().describe('Retire instead of deleting; at most five are active'),
});
export const PlanPutInput = z.object({
  items: z.array(PlanItemInput).max(200).optional().describe('New items, or changes to existing ones (only the fields given change)'),
  intents: z.array(IntentInput).max(MAX_INTENTS * 2).optional().describe('The team\'s intents (why, what, how), written before the items'),
  memo: z.string().max(300).optional().describe('Why it changed; kept in each changed item\'s log'),
}).refine(x => (x.items?.length ?? 0) + (x.intents?.length ?? 0) > 0, 'Give items, intents, or both');
export const ShareInput = z.object({
  year: z.string().regex(YEAR), code: z.string().regex(/^\d+(\.\d+)+$/).describe('A row of your own ledger'),
  space: z.string().describe('The team space id (wbs_spaces)'),
  plan: z.string().regex(CODE).describe('The plan item the row serves'),
  plan_year: z.string().regex(YEAR).optional().describe('The plan year; defaults to the row\'s year'),
  share: z.array(z.enum(SHARE_FIELDS)).max(SHARE_FIELDS.length).optional()
    .describe('Fields the team may see; status is always included. Default (the charter\'s): title, status, start, end, due, last_progress, links. Add goal (the row\'s 목표, set beside the team\'s intents), blocker, evidence or task (the full text) only when the person chooses'),
});
export const UnshareInput = z.object({ year: z.string().regex(YEAR), code: z.string().regex(/^\d+(\.\d+)+$/) });
export const PlanReadInput = z.object({
  space: z.string(), view: z.enum(['actual', 'items', 'alignment']).optional(), year: z.string().regex(YEAR).optional(),
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

/** The accountable person (A, 4.5) for a plan item or a new one under a parent: its own, else its nearest parent's;
 *  null when none is set (the owner then decides). */
export function accountableFor(items: PlanItem[], year: string, code: string): string | null {
  const byKey = new Map(items.map(p => [planKey(p.year, p.code), p]));
  for (const c of [code, ...ancestorsOf(code).reverse()]) { const a = byKey.get(planKey(year, c))?.accountable; if (a) return a; }
  return null;
}

/** The intent a plan item serves: its own, else its nearest parent's (within the same plan year); '' for none. */
function intentOf(items: PlanItem[]) {
  const byKey = new Map(items.map(p => [planKey(p.year, p.code), p]));
  return (p: PlanItem | undefined): string => {
    if (!p) return '';
    if (p.intent) return p.intent;
    for (const a of ancestorsOf(p.code).reverse()) { const q = byKey.get(planKey(p.year, a)); if (q?.intent) return q.intent; }
    return '';
  };
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
 *  caller may see who did the work (a guest or the team's agent sees counts only). `live`: the active intents, for
 *  those who may see the intent alignment; each item then carries the intent it serves (own or inherited). */
export function planActual(items: PlanItem[], work: SharedWork[], today: string, named: boolean, year?: string, live?: Set<string>) {
  const its = items.filter(p => !year || p.year === year).sort(byCode), eff = intentOf(items);
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
    const intent = live ? (i => live.has(i) ? i : '')(eff(p)) : undefined;
    return { year: p.year, code: p.code, scope: p.scope, deliverable: p.deliverable, done: p.done, depends_on: p.depends_on, owners: p.owners,
      ...(live ? { intent, intent_inherited: !!intent && p.intent !== intent } : {}),
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

// ---------------------------------------------------------------- intent alignment (4.1)
export type IntentFlag = 'no_plan' | 'no_work' | 'focus_drift';
const INTENT_FLAG_KO: Record<IntentFlag, string> = { no_plan: '계획 없음', no_work: '작업 없음', focus_drift: '순위보다 작업이 적음' };

/** Each active intent (by rank) with the plan items that serve it (an item without an intent inherits its nearest
 *  parent's) and the shared work under those items: how much, done, by whom, its share of all shared work, and the
 *  goals (목표) the people gave their rows, where they shared them — the row's own why beside the team's. Flags: an
 *  intent with no plan, with plan but no work, or getting at least 20 points less of the work than a lower-ranked one.
 *  Then the plan items that serve no intent and the work on them (with its titles). `named`: per person, for owners and
 *  members. */
export function intentAlignment(items: PlanItem[], intents: Intent[], work: SharedWork[], named: boolean) {
  const active = intents.filter(i => i.status === 'active').sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)), live = new Set(active.map(i => i.id));
  const byKey = new Map(items.map(p => [planKey(p.year, p.code), p])), eff = intentOf(items);
  const few = (xs: (string | undefined)[], n = 5) => [...new Set(xs.map(x => (x || '').trim()).filter(Boolean))].slice(0, n).map(x => x.length > 80 ? x.slice(0, 80).trimEnd() + '…' : x);
  const leaves = items.filter(p => !items.some(o => o.year === p.year && o.code.startsWith(p.code + '.')));
  const of = (w: SharedWork) => { const i = eff(byKey.get(w.plan)); return live.has(i) ? i : ''; };
  const total = work.length, pct = (n: number) => total ? Math.round(n / total * 100) : 0;   // whole percents: no float drift in the comparison
  const rows = active.map(i => {
    const its = leaves.filter(p => eff(p) === i.id), ws = work.filter(w => of(w) === i.id), people = [...new Set(ws.map(w => w.uid))].sort();
    return { id: i.id, rank: i.rank, why: i.why, what: i.what, how: i.how, items: its.length, items_done: its.filter(p => p.status === '완료').length,
      work: ws.length, work_done: ws.filter(w => w.fields.status === '완료').length, share: pct(ws.length) / 100,
      people: named ? people : people.length, goals: few(ws.map(w => w.fields.goal)), flags: [] as IntentFlag[] };
  });
  rows.forEach((r, k) => {
    if (!r.items) r.flags.push('no_plan'); else if (!r.work) r.flags.push('no_work');
    if (rows.slice(k + 1).some(o => pct(o.work) >= pct(r.work) + 20)) r.flags.push('focus_drift');
  });
  const unanchored = leaves.filter(p => !live.has(eff(p))).sort(byCode).map(p => `${p.year} ${p.code}`);
  const offWork = work.filter(w => !of(w)), off = offWork.length;
  const byPerson = named ? [...new Set(work.map(w => w.uid))].sort().map(uid => {
    const ws = work.filter(w => w.uid === uid);
    return { uid, rows: ws.length, by_intent: Object.fromEntries(active.map(i => [i.id, ws.filter(w => of(w) === i.id).length])), off_intent: ws.filter(w => !of(w)).length };
  }) : undefined;
  const lines = [
    ...rows.map(r => `${r.rank}순위 ${r.why} — 계획 ${r.items}개 · 작업 ${r.work_done}/${r.work}행(${Math.round(r.share * 100)}%) · ${Array.isArray(r.people) ? r.people.length : r.people}명${r.flags.length ? ' | ' + r.flags.map(f => INTENT_FLAG_KO[f]).join(', ') : ''}`),
    ...(unanchored.length || off ? [`의도 없는 계획 ${unanchored.length}개${unanchored.length ? ` (${unanchored.slice(0, 6).map(x => x.split(' ')[1]).join(', ')}${unanchored.length > 6 ? ' …' : ''})` : ''} · 의도 밖 작업 ${off}행`] : []),
  ];
  return { intents: rows, unanchored, off_intent_work: off, off_intent_titles: few(offWork.map(w => w.fields.title)), total_work: total, ...(byPerson ? { by_person: byPerson } : {}), lines };
}

// ---------------------------------------------------------------- matching work to the plan (3.8)
/** Character bigrams of the words of a text, lower case: robust to Korean particles and spacing ("결제를" still has 결제). */
function grams(s: string) {
  const g = new Set<string>();
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length === 1) { g.add(w); continue; }
    for (let i = 0; i < w.length - 1; i++) g.add(w.slice(i, i + 2));
  }
  return g;
}
/** A link is made without asking only when the best item covers at least half of its own words in the work's text,
 *  with two or more of them, and leads the runner-up clearly. */
export const AUTO_LINK = 0.5, AUTO_MARGIN = 0.15;
/** Plan items ranked by how much of each item's own words (scope, deliverable, done criterion) the work's text carries;
 *  ties go to the deeper item (the more specific one). Only items still open are candidates. */
export function matchPlan(text: string, items: PlanItem[]) {
  const t = grams(text);
  return items.filter(p => p.status !== '완료' && p.status !== '백로그').map(p => {
    const own = grams(`${p.scope} ${p.deliverable} ${p.done}`);
    let hit = 0; own.forEach(x => { if (t.has(x)) hit++; });
    return { year: p.year, code: p.code, scope: p.scope, hits: hit, score: own.size && hit >= 2 ? Math.round(hit / own.size * 100) / 100 : 0 };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.code.split('.').length - a.code.split('.').length || byCode(a, b));
}

// ---------------------------------------------------------------- the service
export class Plans {
  constructor(private store: Store, private spaces: Spaces, private views?: Views) {
    spaces.left = (space, uid) => this.dropShared(space, uid);
  }

  /** The plan items the caller may see, in code order, with their latest changes (who changed them only for those who
   *  may see the member list). */
  async list(caller: Caller, space: string, year?: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    const items = (await this.store.plan(space)).filter(visibleTo(e.projects)).filter(p => !year || p.year === year).sort(byCode);
    return { space, items: items.map(p => ({ ...p, by: e.named ? p.by : undefined, log: p.log.map(l => ({ at: l.at, change: l.change, ...(e.named ? { by: l.by, via: l.via } : {}) })) })) };
  }

  /** Plan vs actual for the space (see planActual). The read is noted in the view log of every other person whose
   *  rows it carried (views.ts, execution WBS 3.5). */
  async actual(caller: Caller, space: string, year?: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    const vis = visibleTo(e.projects);
    const [items, work, intents] = await Promise.all([this.store.plan(space), this.store.shared(space), e.relation === 'guest' ? [] : this.store.intents(space)]);
    const seen = work.filter(w => vis(splitPlan(w.plan)));
    const live = e.relation === 'guest' ? undefined : new Set(intents.filter(i => i.status === 'active').map(i => i.id));
    const out = { space, ...planActual(items.filter(vis), seen, todayKst(), e.named, year, live) };
    if (this.views) {
      const owners = new Map<string, number>();
      for (const w of seen) if (!year || splitPlan(w.plan).year === year) owners.set(w.uid, (owners.get(w.uid) ?? 0) + 1);
      await this.views.saw(caller, e.relation, space, owners, 'work');
    }
    return out;
  }

  /** Owners and members add plan items or change them; only the fields given change. Parents come before children
   *  (the batch is applied in code order), prerequisites name items of the same plan year, and codes never go away. */
  async put(caller: Caller, space: string, raw: z.input<typeof PlanPutInput>) {
    await this.spaces.enter(caller, space, 'plan.write');
    const input = PlanPutInput.parse(raw), who = callerUid(caller)!;
    const via = caller.kind === 'agent' ? { via: caller.client } : {};   // who recorded it: the person, and the agent acting for them
    const intents = input.intents?.length ? await this.writeIntents(space, input.intents, who) : undefined;
    const { preview: _p, ...out } = await this.writeItems(space, input.items ?? [], who, via, input.memo, false);
    return { ...out, intents };
  }

  /** What a list of item changes would do, checked exactly as a write is, without writing anything (the team master
   *  agent's proposals, 4.5): each item created or changed and the changes in the plan log's own words. */
  async preview(space: string, items: z.input<typeof PlanItemInput>[]) {
    const r = await this.writeItems(space, z.array(PlanItemInput).max(20).parse(items), '', {}, undefined, true);
    if (!r.preview.length) throw new LedgerError('invalid', 'These changes would change nothing in the plan');
    return r.preview;
  }

  private async writeItems(space: string, items: z.infer<typeof PlanItemInput>[], who: string, via: { via?: string }, memo: string | undefined, dryRun: boolean) {
    const now = Date.now(), thisYear = todayKst().slice(0, 4);
    const live = new Set((await this.store.intents(space)).filter(i => i.status === 'active').map(i => i.id));
    const batch = items.map(it => ({ ...it, year: it.year || thisYear })).sort(byCode);
    const preview: { year: string; code: string; created: boolean; changes: string[] }[] = [];
    if (!batch.length) return { space, created: [] as string[], changed: [] as string[], unchanged: 0, preview };
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
        if (it.intent && !live.has(it.intent)) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code}: intent ${it.intent} is not an active intent`);
        if (it.intent !== undefined && (p.intent ?? '') !== it.intent) { changes.push(`의도 ${p.intent || '없음'} → ${it.intent || '없음'}`); p.intent = it.intent; }
        if (it.accountable !== undefined && (p.accountable ?? '') !== it.accountable) {
          const m = it.accountable ? await this.store.membership(space, it.accountable) : null;
          if (it.accountable && (!m || m.role === 'guest')) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code}: A must be an owner or member of this team`);
          changes.push(`A ${p.accountable || '없음'} → ${it.accountable || '없음'}`); p.accountable = it.accountable || undefined;
          if (!p.accountable) delete p.accountable;
        }
        if (p.start && p.due && p.due < p.start) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code}: due is before start`);
        if (p.depends_on.includes(p.code)) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code} cannot depend on itself`);
        if (old && !changes.length) continue;
        preview.push({ year: p.year, code: p.code, created: !old, changes: old ? changes : [`생성: ${p.scope}`, ...changes.filter(c => !['scope', 'deliverable', 'done'].includes(c))] });
        p.updated = now; p.by = who;
        p.log = [...p.log, { at: now, by: who, ...via, change: (old ? changes.join(', ') : '생성') + (memo ? ` — ${memo}` : '') }].slice(-LOG_KEEP);
        all.set(k, p); put.push(p); (old ? changed : created).push(`${p.year} ${p.code}`);
      }
      for (const p of put) for (const d of p.depends_on) {
        if (!all.has(planKey(p.year, d))) throw new LedgerError('invalid', `Plan item ${p.year} ${p.code} depends on ${d}, which is not in the plan`);
      }
      return { put: dryRun ? [] : put, out: { space, created, changed, unchanged: batch.length - created.length - changed.length, preview } };
    });
  }

  /** Adds or changes intents: a new one gets the next id and needs a why; at most five are active; retired ones stay.
   *  Written before the items (its own transaction), so a later item error leaves the intents in place; a retry is safe. */
  private async writeIntents(space: string, list: z.infer<typeof IntentInput>[], who: string) {
    return this.store.intentsTx(space, async cur => {
      const all = new Map(cur.map(i => [i.id, i])), put: Intent[] = [], created: string[] = [], changed: string[] = [];
      let next = Math.max(0, ...cur.map(i => Number(i.id.slice(1)))) + 1;
      for (const x of list) {
        // the same why sent again (a retried call) changes that intent instead of adding a second one
        const old = x.id ? all.get(x.id) : x.why ? [...all.values()].find(v => v.status === 'active' && v.why === clean(x.why)) : undefined;
        if (x.id && !old) throw new LedgerError('not_found', `No intent ${x.id}`);
        if (!old && !x.why) throw new LedgerError('invalid', 'A new intent needs a why');
        const i: Intent = old ? { ...old } : { id: `i${next++}`, why: '', what: '', how: '', rank: [...all.values()].filter(v => v.status === 'active').length + 1, status: 'active', updated: 0, by: who };
        for (const f of ['why', 'what', 'how'] as const) if (x[f] !== undefined) i[f] = clean(x[f])!;
        if (x.rank !== undefined) i.rank = x.rank;
        if (x.status) i.status = x.status;
        i.updated = Date.now(); i.by = who;
        all.set(i.id, i); put.push(i); (old ? changed : created).push(i.id);
      }
      if ([...all.values()].filter(v => v.status === 'active').length > MAX_INTENTS) throw new LedgerError('invalid', `At most ${MAX_INTENTS} intents are active; retire one first`);
      return { put, out: { created, changed } };
    });
  }

  /** Intent alignment (execution WBS 4.1): the team's intents against where the shared work actually goes. Shared among
   *  the owner and members, symmetrically (the charter); the team's agent reads it without names; guests do not. */
  async align(caller: Caller, space: string) {
    const e = await this.spaces.enter(caller, space, 'plan.read');
    if (e.relation === 'guest') throw new LedgerError('forbidden', 'Intent alignment is shared among the team\'s owner and members');
    const [items, intents, work] = await Promise.all([this.store.plan(space), this.store.intents(space), this.store.shared(space)]);
    return { space, as_of: todayKst(), ...intentAlignment(items, intents, work, e.named) };
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
  async mine(caller: Caller, space?: string) {
    const uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no rows of its own');
    const links = (await this.store.links(uid)).filter(l => !space || l.space === space).sort(byCode);
    const copies = new Map<string, SharedWork[]>();
    for (const sp of new Set(links.map(l => l.space))) copies.set(sp, await this.store.shared(sp));
    return links.map(l => {
      const c = copies.get(l.space)?.find(w => w.id === workId(uid, l.year, l.code));
      return { year: l.year, code: l.code, space: l.space, plan: l.plan, share: l.share, team_copy: !c ? 'none' : c.frozen ? 'frozen' : 'live',
        ...(l.plan ? {} : { pending: true }) };   // recorded through the team's connection, waiting for its plan item
    });
  }

  /** The link of one of the caller's rows, if any (pending ones included). */
  async linkOf(caller: Caller, year: string, code: string) {
    const uid = callerUid(caller);
    return uid ? (await this.store.links(uid)).find(l => l.year === year && l.code === code) ?? null : null;
  }

  /** Work recorded through a team's own connection (execution WBS 3.8): the row is the person's own, and it is linked to
   *  the plan item it serves — the one the agent named, else the one the hub matches with confidence — with the
   *  charter's default fields. Without a confident match it waits as a pending link (nothing reaches the team) and the
   *  best candidates come back as suggestions for the person to pick. */
  async recordFor(caller: Caller, space: string, row: { year: string; code: string; task: string; goal?: string }, plan?: string, planYear?: string) {
    const uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no rows of its own');
    if (plan) return { space, status: 'linked' as const, ...(await this.share(caller, { year: row.year, code: row.code, space, plan, plan_year: planYear })) };
    const all = await this.store.plan(space), year = planYear || row.year;
    const pool = all.some(p => p.year === year) ? all.filter(p => p.year === year) : all;
    const ranked = matchPlan(`${row.task} ${row.goal || ''}`, pool), [top, next] = ranked;
    if (top && top.score >= AUTO_LINK && (!next || top.score - next.score >= AUTO_MARGIN)) {
      const r = await this.share(caller, { year: row.year, code: row.code, space, plan: top.code, plan_year: top.year });
      return { space, status: 'linked' as const, matched: { plan: top.code, plan_year: top.year, scope: top.scope, score: top.score }, ...r };
    }
    await this.store.putLink(uid, { year: row.year, code: row.code, space, plan: '', share: [...DEFAULT_SHARE], at: Date.now() });
    return { space, status: 'pending' as const, suggestions: ranked.slice(0, 3).map(c => ({ plan: c.code, plan_year: c.year, scope: c.scope, score: c.score })),
      next: 'Nothing reached the team yet. Ask the person which plan item this serves, then wbs_share with that plan.' };
  }

  /** The ledger's hook (service.ts): rows of a personal ledger changed; the team copies of linked ones follow while the
   *  person is an owner or member of the space and the copy is live. */
  async touched(uid: string, keys: { year: string; code: string }[]) {
    const links = await this.store.links(uid);
    for (const k of keys) {
      const l = links.find(x => x.year === k.year && x.code === k.code);
      if (!l || !l.plan) continue;   // a pending link has nothing at the team yet
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
