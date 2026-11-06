// The brief: a compact, fixed-shape picture of the ledger for planning and advising agents. A strategy agent starts from
// this instead of reading hundreds of rows: status, flow, focus, open and due work, what waits on others, work-style
// indicators and the signals worth acting on, then drills down with wbs_search / wbs_get where the brief points.
// Everything is computed from the person's own ledger (dates, statuses, packages); nothing is inferred about the person
// beyond how their recorded work moves. Kept to a few kilobytes so it costs a planner about a thousand tokens.
import type { Row } from '../store/types.js';

const DAY = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const full = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const short = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const monthsBack = (today: string, n: number) => {
  const [y, m] = today.slice(0, 7).split('-').map(Number), out: string[] = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
};

/** Rows without children: the unit every count uses (a parent's steps are counted, not the parent). */
export function leaves(rows: Row[]): Row[] {
  const parents = new Set(rows.filter(r => r.parent).map(r => `${r.year}|${r.parent.split(' ')[0]}`));
  return rows.filter(r => !parents.has(`${r.year}|${r.code}`));
}

export interface BriefOptions { today: string; year?: string; windowDays?: number }

export function buildBrief(all: Row[], { today, year, windowDays = 90 }: BriefOptions) {
  const scopeYear = year || today.slice(0, 4);
  const L = leaves(all), inYear = L.filter(r => r.year === scopeYear);
  const ref = (r: Row) => `${r.year}:${r.code}`;
  const lastMove = (r: Row) => [r.last_progress, r.end, r.start].filter(full).sort().pop() || r.start;
  const t0 = ms(today), from = new Date(t0 - windowDays * DAY).toISOString().slice(0, 10);
  const recent = L.filter(r => full(r.start) && r.start >= from && r.start <= today);
  const doneRecent = L.filter(r => r.status === '완료' && full(r.end) && r.end >= from && r.end <= today);

  const count = (xs: Row[], s: string) => xs.filter(r => r.status === s).length;
  const kpis = {
    year: scopeYear, tasks: inYear.length, done: count(inYear, '완료'), in_progress: count(inYear, '진행 중'),
    waiting: count(inYear, '대기·심사'), backlog: count(inYear, '백로그'),
    done_rate_pct: pct(count(inYear, '완료'), inYear.length - count(inYear, '백로그')),
    key_results: inYear.filter(r => r.key_result === 'Y').length,
  };

  const month_flow = monthsBack(today, 6).map(m => ({
    month: m, started: L.filter(r => r.start.slice(0, 7) === m).length,
    finished: L.filter(r => r.status === '완료' && r.end.slice(0, 7) === m).length,
  }));

  // where the effort went lately: packages ranked by rows started or finished in the window
  const pk = new Map<string, { package: string; started: number; finished: number; open: number }>();
  const bump = (r: Row, k: 'started' | 'finished') => {
    const key = `${r.year} ${r.package}`, v = pk.get(key) || { package: key, started: 0, finished: 0, open: 0 };
    v[k]++; pk.set(key, v);
  };
  recent.forEach(r => bump(r, 'started')); doneRecent.forEach(r => bump(r, 'finished'));
  for (const r of L) { const v = pk.get(`${r.year} ${r.package}`); if (v && (r.status === '진행 중' || r.status === '대기·심사')) v.open++; }
  const focus = [...pk.values()].sort((a, b) => (b.started + b.finished) - (a.started + a.finished)).slice(0, 5);

  const open = L.filter(r => r.status === '진행 중').sort((a, b) => lastMove(b).localeCompare(lastMove(a)));
  const waiting = L.filter(r => r.status === '대기·심사').sort((a, b) => lastMove(b).localeCompare(lastMove(a)));
  const notDone = L.filter(r => r.status !== '완료' && r.status !== '백로그');
  const soon = new Date(t0 + 14 * DAY).toISOString().slice(0, 10);
  const overdue = notDone.filter(r => full(r.due) && r.due < today).sort((a, b) => a.due.localeCompare(b.due));
  const dueSoon = notDone.filter(r => full(r.due) && r.due >= today && r.due <= soon).sort((a, b) => a.due.localeCompare(b.due));
  const stale = open.filter(r => full(lastMove(r)) && ms(lastMove(r)) < t0 - 30 * DAY);
  const blockers: Record<string, number> = {};
  for (const r of waiting) { const k = (r.blocker.split(':')[0] || '미기재').trim(); blockers[k] = (blockers[k] || 0) + 1; }
  const item = (r: Row) => ({ ref: ref(r), task: short(r.task), ...(r.due ? { due: r.due } : {}), ...(r.blocker ? { blocker: short(r.blocker, 60) } : {}), moved: lastMove(r) });

  // work style: how recorded work moves, over the window
  const spans = doneRecent.filter(r => full(r.start) && full(r.end)).map(r => (ms(r.end) - ms(r.start)) / DAY);
  const wd = Array(7).fill(0); recent.forEach(r => wd[new Date(ms(r.start)).getUTCDay()]++);
  const areas: Record<string, number> = {}; recent.forEach(r => { areas[r.area || '미분류'] = (areas[r.area || '미분류'] || 0) + 1; });
  const work_style = {
    window_days: windowDays,
    finished_per_week: Math.round((doneRecent.length / (windowDays / 7)) * 10) / 10,
    median_days_to_finish: median(spans),
    same_day_finish_pct: pct(spans.filter(d => d === 0).length, spans.length),
    long_runs_over_30d: spans.filter(d => d > 30).length,
    in_progress_now: open.length,
    step_rows_pct: pct(recent.filter(r => r.level === '4').length, recent.length),
    busiest_weekday: recent.length ? WEEKDAYS[wd.indexOf(Math.max(...wd))] : null,
    weekday_starts: Object.fromEntries(WEEKDAYS.map((d, i) => [d, wd[i]])),
    area_mix_pct: Object.fromEntries(Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [k, pct(v, recent.length)])),
  };

  const [prev, cur] = month_flow.slice(-2);
  const signals: string[] = [];
  if (overdue.length) signals.push(`마감 지난 일 ${overdue.length}개`);
  if (dueSoon.length) signals.push(`14일 안에 마감 ${dueSoon.length}개`);
  if (stale.length) signals.push(`30일 넘게 움직임 없는 진행 중 ${stale.length}개`);
  if (waiting.length && pct(waiting.length, notDone.length) >= 25) signals.push(`남의 결정을 기다리는 일이 열린 일의 ${pct(waiting.length, notDone.length)}%`);
  if (open.length > 12) signals.push(`동시에 진행 중 ${open.length}개`);
  if (prev && cur && prev.finished >= 5 && cur.finished < prev.finished / 2 && Number(today.slice(8, 10)) > 20)
    signals.push(`이번 달 완료 ${cur.finished}개, 지난달 ${prev.finished}개`);

  return {
    as_of: today, ledger: { rows: all.length, leaf_tasks: L.length, years: [...new Set(all.map(r => r.year))].sort().reverse() },
    kpis, month_flow, focus,
    open_now: open.slice(0, 8).map(item), overdue: overdue.slice(0, 6).map(item), due_soon: dueSoon.slice(0, 6).map(item),
    waiting: { count: waiting.length, by_blocker: blockers, latest: waiting.slice(0, 5).map(item) },
    stale_open: stale.slice(0, 5).map(item), backlog: count(L, '백로그'),
    work_style, signals,
    drill_down: 'wbs_search {year, package, status} for a package or status; wbs_get {year, code} for one task with its steps and history',
  };
}
