// Ledger operations behind every surface (MCP tools, REST, import). Each call is scoped to one uid and runs inside a
// ledger transaction, so two agents logging at once can never take the same code. The rules are the ledger's own:
// one row per dated deliverable, permanent codes (max + 1 in the package or under the parent), every change logged.
import { z } from 'zod';
import type { LedgerEvent, Row, Store } from '../store/types.js';
import {
  DATE_RE, STATUSES, agentLabel, appendEvidence, codeKey, dateText, emptyRow, eventsFromCsv, eventsToCsv, mergeSource,
  overlap, rowsFromCsv, rowsToCsv, sortRows, todayKst, tokens,
} from './model.js';

/** Who is writing: the signed-in account and the agent (OAuth client) acting for it. */
export interface Actor { uid: string; clientName: string; evidence?: string }

export class LedgerError extends Error {
  constructor(public code: 'not_found' | 'invalid' | 'duplicate', message: string, public detail?: unknown) { super(message); }
}

const date = z.string().regex(DATE_RE, 'YYYY-MM-DD, or YYYY-MM when only the month is known');
export const AddInput = z.object({
  package: z.string().min(1).describe('Package as "<code> <name>", e.g. "4.3 서비스 개발"; the code alone works for an existing package'),
  area: z.string().optional().describe('Area as "<n> <name>" (e.g. "4 창업·제품"); needed only when the package does not exist yet in that year'),
  parent: z.string().optional().describe('Code of an existing task when this is a dated step under it (becomes a level-4 row)'),
  task: z.string().min(4).max(2000).describe('One concrete deliverable, decision or event, in the user\'s language, with numbers'),
  start: date.describe('Date the work happened or started'),
  end: date.optional().describe('Date it finished; omit when still open'),
  status: z.enum(STATUSES).describe('완료 done · 진행 중 in progress · 대기·심사 waiting on someone else · 백로그 parked by the user'),
  year: z.string().regex(/^\d{4}$/).optional().describe('Year tree; defaults to the year of start'),
  key_result: z.boolean().optional().describe('Headline result (paper accepted, launch, filing); level-3 tasks only'),
  due: date.optional(), importance: z.enum(['상', '중', '하']).optional(), size: z.enum(['S', 'M', 'L', 'XL']).optional(),
  depends_on: z.string().optional().describe('Codes that must finish first, ";"-separated; another year as 2025:1.2.3'),
  blocker: z.string().optional().describe('For 대기·심사 or 백로그: "분류: 내용", e.g. "외부 심사·승인: 학교 심사"'),
  goal: z.string().optional(),
  evidence: z.string().optional().describe('Where this came from, e.g. "gpt:<chat title>" or "gh:owner/repo#12"'),
  allow_duplicate: z.boolean().optional().describe('Set only after checking that a similar existing task is really different work'),
});
export const UpdateInput = z.object({
  year: z.string().regex(/^\d{4}$/), code: z.string().regex(/^\d+(\.\d+)+$/),
  status: z.enum(STATUSES).optional(), end: date.optional(), due: date.optional(),
  importance: z.enum(['상', '중', '하']).optional(),
  blocker: z.string().optional().describe('Set for 대기·심사 or 백로그; "" clears it'),
  memo: z.string().max(500).optional().describe('Why it changed; kept in the history, not in the task text'),
  evidence: z.string().optional(),
});
export const SearchInput = z.object({
  year: z.string().regex(/^\d{4}$/).optional(),
  status: z.array(z.enum(STATUSES)).optional(),
  package: z.string().optional().describe('Package code, e.g. "4.3"'),
  q: z.string().optional().describe('Words to look for in the task text or the code'),
  limit: z.number().int().min(1).max(200).optional(),
});

const leafSet = (rows: Row[]) => {
  const parents = new Set(rows.filter(r => r.parent).map(r => `${r.year}|${r.parent.split(' ')[0]}`));
  return rows.filter(r => !parents.has(`${r.year}|${r.code}`));
};
const brief = (r: Row) => ({
  year: r.year, code: r.code, level: r.level, package: r.package, task: r.task.length > 240 ? r.task.slice(0, 240) + '…' : r.task,
  status: r.status, start: r.start, end: r.end, due: r.due || undefined, blocker: r.blocker || undefined, source: r.source,
});

export class Ledger {
  constructor(private store: Store) {}

  async search(uid: string, input: z.infer<typeof SearchInput>) {
    const rows = await this.store.rows(uid, { year: input.year, status: input.status, packageCode: input.package });
    let hits = rows;
    if (input.q) {
      const q = input.q.toLowerCase(), qt = tokens(input.q);
      hits = rows.filter(r => r.code === input.q || r.task.toLowerCase().includes(q) || [...qt].some(t => r.task.toLowerCase().includes(t)));
    }
    const limit = input.limit ?? 50;
    return { total: hits.length, rows: sortRows(hits).slice(0, limit).map(brief) };
  }

  async get(uid: string, year: string, code: string) {
    const row = await this.store.row(uid, year, code);
    if (!row) throw new LedgerError('not_found', `No row ${year} ${code}`);
    const steps = (await this.store.rows(uid, { year, parentCode: code })).map(brief);
    const history = (await this.store.events(uid, year, code)).slice(-20);
    return { row, steps, history };
  }

  async packages(uid: string, year: string) {
    const rows = await this.store.rows(uid, { year }), by = new Map<string, Row[]>();
    for (const r of rows) { const k = r.package; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
    return [...by.entries()].sort((a, b) => codeKey(a[0].split(' ')[0]).localeCompare(codeKey(b[0].split(' ')[0]))).map(([pkg, rs]) => {
      const top = rs.filter(r => r.level === '3').map(r => Number(r.code.split('.').pop()));
      const leaves = leafSet(rs);
      return { package: pkg, area: rs[0].area, goal: rs.find(r => r.goal)?.goal || '', tasks: leaves.length,
        open: leaves.filter(r => r.status !== '완료').length, next_code: `${pkg.split(' ')[0]}.${Math.max(0, ...top) + 1}` };
    });
  }

  async summary(uid: string, year?: string) {
    const rows = await this.store.rows(uid, year ? { year } : undefined), leaves = leafSet(rows);
    const byYear: Record<string, Record<string, number>> = {};
    for (const r of leaves) { (byYear[r.year] ||= {})[r.status] = (byYear[r.year][r.status] || 0) + 1; }
    const open = sortRows(leaves.filter(r => r.status === '진행 중' || r.status === '대기·심사'))
      .sort((a, b) => (b.last_progress || b.start).localeCompare(a.last_progress || a.start)).slice(0, 15).map(brief);
    const recent = (await this.store.events(uid)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
    return { leaf_tasks: leaves.length, by_year_status: byYear, open_recent: open, recent_events: recent };
  }

  /** Adds one row with the next free code. Refuses an obvious duplicate unless the caller says it is different work. */
  async add(actor: Actor, raw: z.input<typeof AddInput>) {
    const input = AddInput.parse(raw), src = agentLabel(actor.clientName), today = todayKst();
    const year = input.year || input.start.slice(0, 4);
    if (input.end && input.end < input.start) throw new LedgerError('invalid', 'end is before start');
    if (input.year && input.start.slice(0, 4) !== input.year) throw new LedgerError('invalid', 'start must fall in the row\'s year');
    const pkgCode = input.package.split(' ')[0];
    if (!/^\d+\.\d+$/.test(pkgCode)) throw new LedgerError('invalid', 'package must start with its code, e.g. "4.3 …"');

    return this.store.ledgerTx(actor.uid, async tx => {
      const inPkg = await tx.rows({ year, packageCode: pkgCode });
      let row = emptyRow(), parent: Row | null = null;
      if (input.parent) {
        parent = await tx.get(year, input.parent);
        if (!parent) throw new LedgerError('not_found', `Parent ${year} ${input.parent} does not exist`);
        if (parent.level !== '3') throw new LedgerError('invalid', 'Steps go under a level-3 task');
        const kids = inPkg.filter(r => r.parent.split(' ')[0] === parent!.code);
        const n = Math.max(0, ...kids.map(r => Number(r.code.split('.').pop()))) + 1;
        row = { ...row, code: `${parent.code}.${n}`, level: '4', area: parent.area, package: parent.package,
          parent: kids[0]?.parent || `${parent.code} ${parent.task.split(/[:;]/)[0].trim()}`, goal: input.goal || parent.goal };
      } else if (inPkg.length) {
        const n = Math.max(0, ...inPkg.filter(r => r.level === '3').map(r => Number(r.code.split('.').pop()))) + 1;
        row = { ...row, code: `${pkgCode}.${n}`, level: '3', area: inPkg[0].area, package: inPkg[0].package,
          goal: input.goal || inPkg.find(r => r.goal)?.goal || '' };
      } else {   // a new package in this year: its code must belong to the given area
        if (!input.area || !/^\d+ /.test(input.area) || !/^\d+\.\d+ \S/.test(input.package)) throw new LedgerError('invalid', 'New package: give area "<n> <name>" and package "<code> <name>"');
        if (input.area.split(' ')[0] !== pkgCode.split('.')[0]) throw new LedgerError('invalid', 'package code must start with the area number');
        row = { ...row, code: `${pkgCode}.1`, level: '3', area: input.area, package: input.package, goal: input.goal || '' };
      }

      // the same work logged twice by two agents is the common failure; stop it unless the caller checked
      const peers = parent ? inPkg.filter(r => r.parent.split(' ')[0] === parent!.code) : inPkg.filter(r => r.level === '3');
      const nt = tokens(input.task).size;
      const similar = peers.filter(r => { const o = overlap(input.task, r.task); return o >= 3 && o / Math.max(1, nt) >= 0.5; });
      if (similar.length && !input.allow_duplicate) {
        throw new LedgerError('duplicate', 'A similar task already exists; update it, add a step under it, or pass allow_duplicate after checking', similar.map(brief));
      }

      const start = input.start, end = input.end || (input.status === '완료' ? input.start : '');
      row = { ...row, year, task: input.task.trim(), start, end, date_text: dateText(start, end), start_month: start.slice(0, 7),
        status: input.status, key_result: input.key_result && row.level === '3' ? 'Y' : '', source: src,
        due: input.due || '', importance: input.importance || '', size: input.size || '', depends_on: input.depends_on || '',
        blocker: input.status === '대기·심사' || input.status === '백로그' ? input.blocker || '' : '',
        last_progress: (end || start).slice(0, 10), evidence: appendEvidence('', input.evidence || actor.evidence || '') };
      tx.put(row);
      tx.event({ date: today, year, code: row.code, event: '생성', from: '', to: row.status, memo: '생성', source: src, estimated: 'N' });

      if (parent) {   // the parent follows its steps: latest progress, and it reopens when an open step arrives
        const p = { ...parent, last_progress: [parent.last_progress, row.last_progress].sort().pop() || '', source: mergeSource(parent.source, src) };
        if (parent.status === '완료' && row.status !== '완료') {
          p.status = '진행 중';
          tx.event({ date: today, year, code: p.code, event: '상태', from: '완료', to: '진행 중', memo: `새 단계 ${row.code}`, source: src, estimated: 'N' });
        }
        tx.put(p);
      }
      return { created: brief(row) };
    });
  }

  /** Status, dates, blocker, due and importance; every change lands in the history. Task text is never rewritten here. */
  async update(actor: Actor, raw: z.input<typeof UpdateInput>) {
    const input = UpdateInput.parse(raw), src = agentLabel(actor.clientName), today = todayKst();
    return this.store.ledgerTx(actor.uid, async tx => {
      const r = await tx.get(input.year, input.code);
      if (!r) throw new LedgerError('not_found', `No row ${input.year} ${input.code}`);
      const was = { ...r }, evs: LedgerEvent[] = [];
      if (input.status && input.status !== r.status) {
        r.status = input.status;
        if (r.status === '완료' && !r.end && !input.end) r.end = today;
        if (r.status === '완료' || r.status === '진행 중') r.blocker = '';
        evs.push({ date: today, year: r.year, code: r.code, event: '상태', from: was.status, to: r.status, memo: input.memo || '', source: src, estimated: 'N' });
      }
      if (input.end) { if (input.end < r.start) throw new LedgerError('invalid', 'end is before start'); r.end = input.end; }
      if (input.due !== undefined) r.due = input.due;
      if (input.importance !== undefined) r.importance = input.importance;
      if (input.blocker !== undefined) r.blocker = input.blocker;
      r.date_text = dateText(r.start, r.end);
      r.last_progress = [r.last_progress, today].sort().pop() || today;
      r.source = mergeSource(r.source, src);
      r.evidence = appendEvidence(r.evidence, input.evidence || actor.evidence || '');
      const filled = (['end', 'due', 'importance', 'blocker'] as const).filter(k => r[k] !== was[k]);
      if (filled.length && !evs.length) evs.push({ date: today, year: r.year, code: r.code, event: '보강', from: '', to: r.status, memo: input.memo || filled.join(', '), source: src, estimated: 'N' });
      if (!evs.length) return { updated: brief(r), changed: false };
      tx.put(r); evs.forEach(e => tx.event(e));
      return { updated: brief(r), changed: true };
    });
  }

  async exportCsv(uid: string) {
    const [rows, evs] = await Promise.all([this.store.rows(uid), this.store.events(uid)]);
    return { wbs: rowsToCsv(rows), events: eventsToCsv(evs) };
  }

  /** Bulk import of an existing wbs.csv (+ events.csv) into an empty ledger: the migration path from the file era. */
  async importCsv(uid: string, wbsText: string, eventsText?: string) {
    const rows = rowsFromCsv(wbsText), evs = eventsText ? eventsFromCsv(eventsText) : [];
    if ((await this.store.rows(uid)).length) throw new LedgerError('invalid', 'Import only into an empty ledger');
    await this.store.bulkImport(uid, rows, evs);
    return { rows: rows.length, events: evs.length };
  }
}
