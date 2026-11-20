// The weekly team brief and personal coaching (execution WBS 4.3; the strategy: "팀 브리핑은 진척·병목·리스크·의도
// 어긋남을 팀 전체에, 개인 코칭은 본인의 속도와 업무 성향을 본인 에이전트가 본인에게만 전한다").
//
// The team brief is about the work, never about people: every line names a plan item or counts rows, and none names,
// counts or compares a person. Feedback that draws attention to the self rather than the task is the kind that most
// often backfires (Kluger & DeNisi, 1996, Psychological Bulletin 119(2), 254–284: across 607 effect sizes the mean
// was d = .41, yet over a third of feedback interventions lowered performance). It is generated once for each ISO week
// that has ended (Monday morning, by the scheduler) and then kept as it was, so the whole team reads the same text; if
// the scheduler has not run yet, the first reader of last week's brief generates it. The week in progress is shown live
// and never stored.
//
// Personal coaching is the person's own and goes only to them, through their own agent: their pace against their own
// past weeks (never anyone else's), what is open, due or stalled, and their part in each team. On a team connection
// it covers only the rows linked to that team.
import type { Intent, PlanItem, Row, SharedWork, Store, WeeklyBrief } from '../store/types.js';
import { buildBrief, leaves } from './brief.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller } from './access.js';
import type { Spaces } from './spaces.js';
import { intentAlignment, planActual } from './plan.js';
import { todayKst } from './model.js';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const full = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + '…' : s);
const mmdd = (d: string) => d.slice(5);
/** Weeks are kept half a year. */
export const KEEP_WEEKS = 26;

/** The ISO 8601 week a date falls in, with its Monday and Sunday. */
export function isoWeek(day: string) {
  const t = ms(day), mon = t - ((new Date(t).getUTCDay() + 6) % 7) * DAY, thu = mon + 3 * DAY, y = new Date(thu).getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4), w1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return { week: `${y}-W${String(1 + Math.round((mon - w1) / (7 * DAY))).padStart(2, '0')}`, from: ymd(mon), to: ymd(mon + 6 * DAY) };
}
/** The Monday-to-Sunday dates of an ISO week id. */
export function weekRange(week: string) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new LedgerError('invalid', 'A week is YYYY-Www, e.g. 2026-W47');
  const jan4 = Date.UTC(Number(m[1]), 0, 4), w1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY, mon = w1 + (Number(m[2]) - 1) * 7 * DAY;
  const r = { week, from: ymd(mon), to: ymd(mon + 6 * DAY) };
  if (isoWeek(r.from).week !== week) throw new LedgerError('invalid', `No week ${week}`);
  return r;
}
/** The last ISO week that has ended by `today`. */
export const lastFullWeek = (today: string) => isoWeek(ymd(ms(today) - 7 * DAY));

/** The team brief for one week, as of `asOf`: progress in the week, bottlenecks and risks as they stand, the intents,
 *  and what falls due in the next seven days. Task sentences only. */
export function teamWeekly(input: { items: PlanItem[]; work: SharedWork[]; intents: Intent[]; week: { week: string; from: string; to: string }; asOf: string }): WeeklyBrief {
  const { items, work, intents, week, asOf } = input, inWeek = (d?: string) => full(d) && d! >= week.from && d! <= week.to;
  const f = work.map(w => w.fields);
  const rowsDone = f.filter(x => x.status === '완료' && inWeek(x.end)).length, rowsStarted = f.filter(x => inWeek(x.start)).length;
  // plan items whose own status turned 완료 during the week (the plan's change log)
  const kst = (t: number) => ymd(t + 9 * 3600e3);
  const turnedDone = (c: string) => /상태 [^,—]* → 완료/.test(c) || /^생성/.test(c);   // the log joins several changes with ", "
  const itemsDone = items.filter(p => p.status === '완료' && p.log.some(l => turnedDone(l.change) && inWeek(kst(l.at))))
    .map(p => ({ code: p.code, scope: p.scope }));
  const pa = planActual(items, work, asOf, false), byCode = new Map(pa.items.map(r => [`${r.year} ${r.code}`, r]));
  const WHY: Record<string, string> = { late: '마감 지남', waiting: '대기 중인 작업', parked_but_active: '보류인데 작업 진행', work_done_plan_open: '작업은 끝났는데 계획은 열림', plan_done_work_open: '계획은 완료인데 작업이 남음', no_work: '진행 중인데 공유된 작업 없음' };
  const bottlenecks = pa.items.filter(r => r.flags.length).map(r => ({ code: r.code, scope: r.scope, flags: [...r.flags], slip_days: r.slip_days ?? null,
    why: r.flags.map(fl => fl === 'late' && r.slip_days ? `마감 ${r.slip_days}일 지남` : WHY[fl] ?? fl) }));
  const blockers = [...new Set(f.filter(x => x.status !== '완료' && x.blocker).map(x => short(String(x.blocker))))].slice(0, 3);
  // risks: open items due within the next seven days with no work yet, or waiting on an unfinished item
  const horizon = ymd(ms(asOf) + 7 * DAY), open = items.filter(p => p.status !== '완료' && p.status !== '백로그');
  const done = new Set(items.filter(p => p.status === '완료').map(p => `${p.year} ${p.code}`));
  const risks = open.filter(p => full(p.due) && p.due >= asOf && p.due <= horizon).map(p => {
    const a = byCode.get(`${p.year} ${p.code}`)?.actual, why: string[] = [];
    if (!a?.rows) why.push('공유된 작업 없음'); else if (a.status !== '완료') why.push(`작업 ${a.done}/${a.rows}행`);
    const pending = p.depends_on.filter(d => !done.has(d.includes(' ') ? d : `${p.year} ${d}`));
    if (pending.length) why.push(`선행 ${pending.join(', ')} 미완료`);
    return { code: p.code, scope: p.scope, due: p.due, rows: a?.rows ?? 0, done: a?.done ?? 0, pending, why };
  }).filter(r => r.why.length);
  const next = open.filter(p => full(p.due) && p.due > asOf && p.due <= horizon).sort((a, b) => a.due.localeCompare(b.due)).map(p => ({ code: p.code, scope: p.scope, due: p.due }));
  const al = intentAlignment(items, intents, work, false);
  const intentLines = al.intents.filter(i => i.flags.length).map(i => `${i.rank}순위 "${short(i.why, 30)}" — ${i.flags.map(fl => ({ no_plan: '계획 없음', no_work: '작업 없음', focus_drift: '순위보다 작업이 적음' }[fl])).join(', ')} (작업 비중 ${Math.round(i.share * 100)}%)`);
  const list = (xs: { code: string; scope: string }[], n = 4) => xs.slice(0, n).map(x => `${x.code} ${x.scope}`).join(', ') + (xs.length > n ? ` 외 ${xs.length - n}` : '');
  const lines = [
    `진척: 공유 행 완료 ${rowsDone} · 시작 ${rowsStarted}${itemsDone.length ? ` · 계획 항목 완료 ${itemsDone.length} (${list(itemsDone)})` : ' · 완료된 계획 항목 없음'}`,
    bottlenecks.length ? `병목: ${bottlenecks.slice(0, 5).map(b => `${b.code} ${b.scope} — ${b.why.join(', ')}`).join('; ')}${bottlenecks.length > 5 ? ` 외 ${bottlenecks.length - 5}` : ''}` : '병목: 없음',
    ...(blockers.length ? [`막힘 사유(공유된 것): ${blockers.map(x => `"${x}"`).join(', ')}`] : []),
    risks.length ? `리스크(7일 안): ${risks.slice(0, 5).map(r => `${r.code} ${r.scope} ~${mmdd(r.due)} — ${r.why.join(', ')}`).join('; ')}` : '리스크(7일 안): 없음',
    intentLines.length || al.off_intent_work || al.unanchored.length
      ? `의도: ${[...intentLines, ...(al.unanchored.length ? [`의도 없는 계획 ${al.unanchored.length}개`] : []), ...(al.off_intent_work ? [`의도 밖 작업 ${al.off_intent_work}행`] : [])].join('; ')}`
      : (al.intents.length ? '의도: 어긋남 없음' : '의도: 팀 의도가 아직 없음'),
    next.length ? `다음 7일 마감: ${next.slice(0, 6).map(x => `${x.code} ${x.scope} ~${mmdd(x.due)}`).join(', ')}` : '다음 7일 마감: 없음',
  ];
  return { week: week.week, from: week.from, to: week.to, as_of: asOf, generated: Date.now(),
    progress: { rows_done: rowsDone, rows_started: rowsStarted, items_done: itemsDone }, bottlenecks, blockers, risks,
    intents: { lines: intentLines, items: al.intents.filter(i => i.flags.length).map(i => ({ id: i.id, rank: i.rank, why: i.why, flags: [...i.flags], share: i.share })),
      active: al.intents.length, off_intent_rows: al.off_intent_work, unanchored: al.unanchored.length }, next, lines };
}

/** The person's own coaching: pace against their own past weeks, what is open, due or stalled, the work style their
 *  rows show, and their part in each team. Task sentences, no comparison with anyone. */
export function coaching(rows: Row[], today: string, teams: { space: string; name: string; mine: { code: string; scope: string; due: string; late: boolean }[]; pending: number }[] = []) {
  const L = leaves(rows), week = isoWeek(today);
  const doneIn = (from: string, to: string) => L.filter(r => r.status === '완료' && full(r.end) && r.end >= from && r.end <= to).length;
  const past = Array.from({ length: 8 }, (_, i) => { const w = isoWeek(ymd(ms(week.from) - (i + 1) * 7 * DAY)); return doneIn(w.from, w.to); });
  const sorted = [...past].sort((a, b) => a - b), median = (sorted[3] + sorted[4]) / 2;
  const lastMove = (r: Row) => [r.last_progress, r.end, r.start].filter(full).sort().pop() || r.start;
  const open = L.filter(r => r.status === '진행 중'), stalled = open.filter(r => full(lastMove(r)) && ms(lastMove(r)) < ms(today) - 14 * DAY);
  const notDone = L.filter(r => r.status !== '완료' && r.status !== '백로그');
  const overdue = notDone.filter(r => full(r.due) && r.due < today).sort((a, b) => a.due.localeCompare(b.due));
  const soon = notDone.filter(r => full(r.due) && r.due >= today && r.due <= ymd(ms(today) + 7 * DAY)).sort((a, b) => a.due.localeCompare(b.due));
  const ws = buildBrief(rows, { today }).work_style, ref = (r: Row) => `${r.year} ${r.code} ${short(r.task, 30)}`;
  const pace = { this_week_so_far: doneIn(week.from, today), last_week: past[0], median_8_weeks: median };
  const lines = [
    `속도: 이번 주 완료 ${pace.this_week_so_far}건(진행 중인 주) · 지난주 ${pace.last_week}건 · 지난 8주 중앙값 ${pace.median_8_weeks}건`,
    ...(overdue.length ? [`마감 지난 ${overdue.length}건: ${overdue.slice(0, 3).map(r => `${ref(r)} ~${mmdd(r.due)}`).join('; ')}${overdue.length > 3 ? ` 외 ${overdue.length - 3}` : ''}`] : []),
    ...(soon.length ? [`7일 안에 마감 ${soon.length}건: ${soon.slice(0, 3).map(r => `${ref(r)} ~${mmdd(r.due)}`).join('; ')}${soon.length > 3 ? ` 외 ${soon.length - 3}` : ''}`] : []),
    `진행 중 ${open.length}건${stalled.length ? `, 그중 14일 넘게 움직임 없는 ${stalled.length}건(${stalled.slice(0, 3).map(ref).join('; ')}) — 닫을지, 백로그로 옮길지, 다음 한 걸음을 적을지 정하기` : ''}`,
    `업무 성향(최근 ${ws.window_days}일): 주당 완료 ${ws.finished_per_week}건 · 완료까지 중앙값 ${ws.median_days_to_finish ?? '—'}일 · 당일 완료 ${ws.same_day_finish_pct}% · 30일 넘은 일 ${ws.long_runs_over_30d}건${ws.busiest_weekday ? ` · 주로 ${ws.busiest_weekday}요일에 시작` : ''}`,
    ...teams.flatMap(t => {
      const late = t.mine.filter(m => m.late), parts = [
        ...(t.mine.length ? [`맡은 계획 항목 ${t.mine.length}개${late.length ? `(마감 지남 ${late.map(m => `${m.code} ${m.scope}`).slice(0, 3).join(', ')})` : ''}`] : []),
        ...(t.pending ? [`팀 계획 항목을 고르지 않은 연결 대기 ${t.pending}행`] : []),
      ];
      return parts.length ? [`팀 ${t.name}: ${parts.join(' · ')}`] : [];
    }),
  ];
  return { as_of: today, pace, open: open.length, stalled: stalled.map(ref), overdue: overdue.map(ref), due_7_days: soon.map(ref), work_style: ws, teams, lines,
    note: '본인에게만 전하는 코칭입니다. 팀 브리핑이나 다른 사람에게 옮기지 않습니다.' };
}

export class Briefs {
  /** `today`: the date in Korea (KST) the hub works in; tests fix it. */
  constructor(private store: Store, private spaces: Spaces, private today: () => string = todayKst) {}

  private async build(space: string, week: { week: string; from: string; to: string }, asOf: string) {
    const [items, work, intents] = await Promise.all([this.store.plan(space), this.store.shared(space), this.store.intents(space)]);
    return teamWeekly({ items, work, intents, week, asOf });
  }

  /** A team's brief for a week (default: the last week that has ended). A past week is the stored one; last week is
   *  generated on first read if the scheduler has not run; the week in progress is computed live and not kept. */
  async weekly(caller: Caller, space: string, week?: string) {
    await this.spaces.enter(caller, space, 'brief.read');
    const today = this.today(), w = week ? weekRange(week) : lastFullWeek(today);
    if (w.to >= today) return { space, live: true, ...(await this.build(space, w, today)) };
    const kept = await this.store.weekly(space, w.week);
    if (kept) return { space, ...kept };
    if (w.week !== lastFullWeek(today).week) throw new LedgerError('not_found', `No brief was generated for ${w.week}`);
    const b = await this.build(space, w, today);
    await this.store.putWeekly(space, b);
    return { space, ...b };
  }

  /** The scheduler's weekly run: last week's brief for every team that has none yet, and weeks older than half a year
   *  removed. Idempotent: running twice in a week generates nothing new. */
  async runWeekly(today = this.today()) {
    const w = lastFullWeek(today), keepFrom = isoWeek(ymd(ms(today) - KEEP_WEEKS * 7 * DAY)).week;
    let generated = 0, removed = 0;
    for (const id of await this.store.teamSpaceIds()) {
      const weeks = await this.store.weeklies(id);
      if (!weeks.includes(w.week)) { await this.store.putWeekly(id, await this.build(id, w, today)); generated++; }
      for (const old of weeks.filter(x => x < keepFrom)) { await this.store.removeWeekly(id, old); removed++; }
    }
    return { week: w.week, generated, removed };
  }

  /** Coaching for the caller only. `env`: a team connection's space — then only the rows linked to that team. */
  async coach(caller: Caller, env?: string) {
    const uid = callerUid(caller);
    if (!uid || caller.kind === 'team_agent') throw new LedgerError('forbidden', 'Coaching is for one person, through their own agent');
    if (caller.kind === 'agent' && !caller.scopes.includes('wbs.read')) throw new LedgerError('forbidden', 'Needs wbs.read');
    const today = this.today(), links = await this.store.links(uid), all = await this.store.rows(uid);
    const rows = env ? all.filter(r => links.some(l => l.space === env && l.year === r.year && l.code === r.code)) : all;
    const profile = await this.store.secret<{ name?: string }>(uid, 'profile');
    const mineOf = (p: PlanItem) => p.owners.some(o => o === uid || (!!profile?.name && o === profile.name));
    const teams = [];
    for (const s of await this.spaces.list(caller)) {
      if (s.kind !== 'team' || (env && s.id !== env) || s.role === 'guest') continue;
      try { await this.spaces.enter(caller, s.id, 'plan.read'); } catch { continue; }   // not yet agreed to its charter, say
      const items = await this.store.plan(s.id), pa = planActual(items, await this.store.shared(s.id), today, false);
      const mine = pa.items.filter(r => mineOf(items.find(p => p.year === r.year && p.code === r.code)!) && r.plan.status !== '완료')
        .map(r => ({ code: r.code, scope: r.scope, due: r.plan.due, late: r.flags.includes('late') }));
      teams.push({ space: s.id, name: (s as { name: string }).name, mine, pending: links.filter(l => l.space === s.id && !l.plan).length });
    }
    return { ...(env ? { space: env, scope: 'rows linked to this team' } : {}), ...coaching(rows, today, teams) };
  }
}
