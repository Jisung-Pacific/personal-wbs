#!/usr/bin/env python3
"""Write summary.json and llms.txt for agents from a personal WBS ledger.

Usage:
  python3 make_agent_files.py <folder> [--as-of YYYY-MM-DD]

Reads wbs.csv (required) and plan.csv, events.csv, coverage.csv when present, in
English or Korean. Writes into the same folder:
  summary.json  precomputed state: counts, open tasks with every field, packages,
                recent completions, plan, sweep coverage and the weekly health check
  llms.txt      what the files are, the schema, and how to answer common questions
                (llmstxt.org style), in the ledger's language
A folder without wbs.csv is searched one level down (sample/ -> sample/en, sample/ko).
JSON keys and enumerated values are always English codes; `labels` maps them to the
ledger's language. Free text stays as written.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbs_schema as S  # noqa: E402

D1 = dt.timedelta(days=1)
IMP_RANK = {'high': 0, 'medium': 1, 'low': 2}
MENTION = re.compile(r'(?:^|[^\d-])(?:(20\d\d)-)?(\d\d)-(\d\d)(?![\d-])')


# ------------------------------------------------------------------ dates per row
def day(s):
    return S.to_day(s)


def start_approx(r):
    s = r['start']
    if not s:
        return None
    return day(s) if S.is_day(s) else S.month_first(s[:7])


def done_approx(r):
    if r['st'] != 'done':
        return None
    e, s = r['end'], r['start']
    if e:
        return day(e) if S.is_day(e) else S.month_last(e[:7])
    if s:
        return day(s) if S.is_day(s) else S.month_last(s[:7])
    return None


def done_day(r):
    if r['st'] != 'done':
        return None
    if S.is_day(r['end']):
        return day(r['end'])
    if not r['end'] and S.is_day(r['start']):
        return day(r['start'])
    return None


def lead_days(r):
    """Cycle time in days, start and finish inclusive (done rows with exact dates)."""
    if r['st'] != 'done' or not S.is_day(r['start']):
        return None
    e = r['end'] or r['start']
    if not S.is_day(e):
        return None
    return max(1, (day(e) - day(r['start'])).days + 1)


def mention_days(r):
    y, s0, out = int(r['year']) if r['year'].isdigit() else 0, start_approx(r), []
    for m in MENTION.finditer(r['task']):
        try:
            d = dt.date(int(m.group(1) or y), int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        if not m.group(1) and s0 and d < s0:
            d = d.replace(year=d.year + 1)   # a task that ran into the next year
        out.append(d)
    return out


def activity_days(r, as_of):
    """Days something was recorded on the row: start, finish, last progress, dates in the text."""
    last = day(r['last_progress'])
    ds = [start_approx(r), day(r['end']) if day(r['end']) and day(r['end']) <= as_of else None, last]
    ds += [d for d in mention_days(r) if d <= as_of and (not last or d <= last)]
    return sorted({d for d in ds if d})


def last_at(r, d):
    x = None
    for a in r['adays']:
        if a > d:
            break
        x = a
    return x


def open_at(r, d):
    """Was the row open on day d? Finished work counts between its start and finish."""
    a = start_approx(r)
    if a and a > d:
        return False
    if r['st'] == 'done':
        b = done_approx(r)
        return a is not None and (b is None or b > d)
    if r['st'] == 'backlog':
        last = day(r['last_progress']) or a
        return a is not None and d < last
    return True   # open today; an undated open row counts at every date


def quantile(s, p):
    if not s:
        return None
    h = (len(s) - 1) * p
    lo = int(h)
    return s[lo] + (s[min(lo + 1, len(s) - 1)] - s[lo]) * (h - lo)


# ------------------------------------------------------------------ health check
TEXT = {
    'en': {
        'stale': ('Stale share', 'SLE · ageing WIP (Vacanti 2015)'),
        'wip': ('Work in progress', "Little's law (Little 1961)"),
        'rho': ('Arrivals ÷ completions (ρ)', 'Queueing theory'),
        'thr': ('Weekly completions', 'XmR throughput (Wheeler 2000)'),
        'ct': ('Cycle time, 85th percentile', 'SLE (Vacanti 2015)'),
        'sw': ('Context switching', 'Weinberg (1992) rule of thumb'),
        'focus': ('Focus share', 'Time allocation · strategy alignment'),
        'wait': ('Waiting with no news 30+ days', 'Blocker clustering'),
        'due': ('Deadline risk', 'Due dates (schema v6)'),
        'undated': ('Missing dates', 'Data quality'),
        'level': {'normal': 'normal', 'caution': 'caution', 'risk': 'risk'},
        'pattern': {'scattered': 'scattered', 'stalled': 'stalled', 'overloaded': 'overloaded', 'slow_flow': 'slow flow'},
    },
    'ko': {
        'stale': ('정체율', 'SLE·노화 WIP (Vacanti 2015)'),
        'wip': ('동시 진행(WIP)', '리틀의 법칙 (Little 1961)'),
        'rho': ('유입÷처리 ρ', '대기행렬 이론'),
        'thr': ('주간 완료', 'XmR 처리량 (Wheeler 2000)'),
        'ct': ('사이클 타임 85%', 'SLE (Vacanti 2015)'),
        'sw': ('맥락 전환', 'Weinberg (1992) 경험칙'),
        'focus': ('집중 비중', '시간 배분 · 전략 정렬'),
        'wait': ('대기 무소식 30일+', '차단 요인 군집'),
        'due': ('마감 위험', '마감일(v6)'),
        'undated': ('날짜 결측', '데이터 품질'),
        'level': {'normal': '정상', 'caution': '주의', 'risk': '위험'},
        'pattern': {'scattered': '분산', 'stalled': '정체', 'overloaded': '과부하', 'slow_flow': '흐름 저하'},
    },
}


def band(v, a, b, higher_worse=True):
    if higher_worse:
        return 'normal' if v <= a else 'caution' if v <= b else 'risk'
    return 'normal' if v >= a else 'caution' if v >= b else 'risk'


def indicators_at(d, lim, leaves, focus_keys):
    pkg = lambda r: (r['year'], S.package_of(r['code']))
    back = lambda n: d - dt.timedelta(days=n)
    in_win = lambda x, n: x is not None and back(n) < x <= d
    opened = [r for r in leaves if open_at(r, d)]
    run = [r for r in opened if r['st'] != 'waiting']
    idle = lambda r: (d - last_at(r, d)).days if last_at(r, d) else None
    run_k = [r for r in run if idle(r) is not None]
    stale = [r for r in run_k if idle(r) > lim]
    arr = sum(in_win(start_approx(r), 30) for r in leaves)
    dep = sum(in_win(done_approx(r), 30) for r in leaves)
    lt = sorted(r['lead'] for r in leaves if r['lead'] is not None and in_win(done_day(r), 90))
    base = sorted(r['lead'] for r in leaves if r['lead'] is not None and done_day(r) and done_day(r) <= d)
    weeks = []
    for k in range(4):
        hi, lo = back(7 * k), back(7 * k + 7)
        weeks.append(len({pkg(r) for r in leaves for x in (start_approx(r), done_approx(r)) if x and lo < x <= hi}))
    fo = total = 0
    per_pkg = {}
    for r in leaves:
        for x in (start_approx(r), done_approx(r)):
            if in_win(x, 28):
                total += 1
                per_pkg[pkg(r)] = per_pkg.get(pkg(r), 0) + 1
                fo += pkg(r) in focus_keys
    top2 = sorted(per_pkg.values(), reverse=True)[:2]
    return {
        'wip': len(opened), 'stale': len(stale), 'run_known': len(run_k),
        'stale_rate': len(stale) / len(run_k) if run_k else 0.0, 'stale_rows': stale,
        'rho': arr / dep if dep else (9.0 if arr else 1.0), 'arr': arr, 'dep': dep,
        'thr': sum(in_win(done_approx(r), 28) for r in leaves) / 4,
        'ct85': quantile(lt, 0.85) if len(lt) >= 5 else None,
        'ct_base': quantile(base, 0.85) if base else None,
        'sw': sum(weeks) / 4,
        'focus': ((fo if focus_keys else sum(top2)) / total) if total else None, 'focus_n': total,
        'wait_old': sum(1 for r in opened if r['st'] == 'waiting' and idle(r) is not None and idle(r) > 30),
    }


def ref_ranges(d, leaves):
    """Personal reference ranges from the past year, like a lab's reference interval."""
    wip = sorted(sum(open_at(r, d - dt.timedelta(days=i)) for r in leaves) for i in range(365))
    thr = []
    for k in range(52):
        e = d - dt.timedelta(days=7 * k)
        s = e - dt.timedelta(days=7)
        thr.append(sum(1 for r in leaves if done_approx(r) and s < done_approx(r) <= e))
    thr.sort()
    return {'wip': {q: quantile(wip, v) for q, v in (('p50', .5), ('p75', .75), ('p90', .9))},
            'thr': {q: quantile(thr, v) for q, v in (('p10', .1), ('p25', .25), ('p50', .5))}}


def n1(v):
    return f'{v:.1f}'.rstrip('0').rstrip('.') if v is not None else '-'


def health(leaves, as_of, lang, focus_keys, focus_names, next_checkup):
    t = TEXT[lang]
    sle = quantile(sorted(r['lead'] for r in leaves if r['lead'] is not None), 0.85)
    lim = max(14, round(sle if sle is not None else 21))
    now = indicators_at(as_of, lim, leaves, focus_keys)
    was = indicators_at(as_of - dt.timedelta(days=28), lim, leaves, focus_keys)
    R = ref_ranges(as_of, leaves)
    pct = lambda v: f'{round(v * 100)}%'
    open_nb = [r for r in leaves if r['st'] in ('in_progress', 'waiting')]
    dated = [r for r in open_nb if r['days_to_due'] is not None]
    late = sum(1 for r in dated if r['days_to_due'] < 0)
    soon = sum(1 for r in dated if 0 <= r['days_to_due'] <= 7)
    undated = sum(1 for r in open_nb if not r['adays'])
    fname = ' · '.join(focus_names)
    ko = lang == 'ko'
    p50, p75, p90 = (round(R['wip'][k]) for k in ('p50', 'p75', 'p90'))
    tp10, tp25, tp50 = (R['thr'][k] for k in ('p10', 'p25', 'p50'))
    ct_lv = lambda x: 'normal' if x['ct85'] is None or not x['ct_base'] else band(x['ct85'] / x['ct_base'], 1.25, 1.6)
    base = now['ct_base'] or 20
    rows = [
        dict(id='stale', value=now['stale_rate'], was=was['stale_rate'], display=pct(now['stale_rate']),
             range='≤ 15%', level=band(now['stale_rate'], .15, .3), level_4w=band(was['stale_rate'], .15, .3),
             why=(f"진행 중 {now['run_known']}개 중 {now['stale']}개가 {lim}일 넘게 기록 없음" if ko else
                  f"{now['stale']} of {now['run_known']} running tasks have had nothing recorded for over {lim} days"),
             prescription=(f"정체 {now['stale']}개를 하나씩 끝내기·백로그·쪼개기로 결정" if ko else
                           f"Decide each of the {now['stale']} stale tasks: finish it, park it in backlog, or split it"),
             target='≤ 15%'),
        dict(id='wip', value=now['wip'], was=was['wip'], display=str(now['wip']),
             range=(f'≤ {p75}개 (지난 1년 75%)' if ko else f'≤ {p75} (your past-year 75th percentile)'),
             level=band(now['wip'], p75, p90), level_4w=band(was['wip'], p75, p90),
             why=(f'지난 1년 하루 열린 작업 중앙 {p50}개, 90% {p90}개' if ko else
                  f'Past year: median {p50} open tasks per day, 90th percentile {p90}'),
             prescription=('새 작업 시작을 멈추고 열린 작업부터 닫기' if ko else 'Stop starting new work and close open tasks first'),
             target=(f'열린 작업 ≤ {p50}개' if ko else f'≤ {p50} open tasks')),
        dict(id='rho', value=round(now['rho'], 2), was=round(was['rho'], 2), display=f"{now['rho']:.2f}",
             range='≤ 1.15', level=band(now['rho'], 1.15, 1.4), level_4w=band(was['rho'], 1.15, 1.4),
             why=(f"30일 시작 {now['arr']} · 완료 {now['dep']}" if ko else
                  f"Last 30 days: {now['arr']} started, {now['dep']} finished"),
             prescription=('하나를 시작하면 하나를 닫는 규칙' if ko else 'One in, one out: start a task only after closing one'),
             target='ρ ≤ 1.0'),
        dict(id='thr', value=now['thr'], was=was['thr'], display=(f"{n1(now['thr'])}개/주" if ko else f"{n1(now['thr'])}/week"),
             range=(f'≥ {n1(tp25)}개 (지난 1년 25%)' if ko else f'≥ {n1(tp25)}/week (your past-year 25th percentile)'),
             level=band(now['thr'], tp25, tp10, False), level_4w=band(was['thr'], tp25, tp10, False),
             why=(f'최근 4주 평균 · 지난 1년 주간 중앙 {n1(tp50)}개' if ko else
                  f'Average of the last 4 weeks; past-year weekly median {n1(tp50)}'),
             prescription=('작업을 1~3일 크기로 쪼개 자주 닫기' if ko else 'Split work into 1–3 day pieces and close them often'),
             target=(f'주 {n1(tp50)}개 이상' if ko else f'≥ {n1(tp50)}/week')),
        dict(id='ct', value=now['ct85'], was=was['ct85'], display=(f"{n1(now['ct85'])}일" if ko else f"{n1(now['ct85'])} days"),
             range=(f'≤ {n1(base * 1.25)}일 (전체 85% × 1.25)' if ko else f'≤ {n1(base * 1.25)} days (all-time 85th percentile × 1.25)'),
             level=ct_lv(now), level_4w=ct_lv(was),
             why=(f"최근 90일 완료 작업의 85% 지점 · 전체 기준 {n1(now['ct_base'])}일" if ko else
                  f"85th percentile of tasks finished in the last 90 days; all-time {n1(now['ct_base'])} days"),
             prescription=('SLE를 넘긴 작업부터 마감' if ko else 'Finish the tasks that are past the service level first'),
             target=(f'85% ≤ {n1(now["ct_base"])}일' if ko else f'≤ {n1(now["ct_base"])} days')),
        dict(id='sw', value=now['sw'], was=was['sw'], display=(f"{n1(now['sw'])}개/주" if ko else f"{n1(now['sw'])}/week"),
             range=('≤ 4개/주' if ko else '≤ 4 packages/week'), level=band(now['sw'], 4, 7), level_4w=band(was['sw'], 4, 7),
             why=('한 주에 시작·완료 기록이 있는 패키지 수(최근 4주 평균)' if ko else
                  'Packages with a start or finish in a week (4-week average)'),
             prescription=('주마다 집중 패키지 2~3개만 열고, 행정은 하루에 묶기' if ko else
                           'Open only 2–3 focus packages per week and batch admin into one day'),
             target=('주당 ≤ 4개' if ko else '≤ 4/week')),
        dict(id='focus', value=now['focus'], was=was['focus'], display=pct(now['focus'] or 0), range='≥ 50%',
             level=band(now['focus'] or 0, .5, .3, False), level_4w=band(was['focus'] or 0, .5, .3, False),
             why=(f"최근 28일 시작·완료 기록 {now['focus_n']}건 중" if ko else
                  f"Share of the {now['focus_n']} starts and finishes in the last 28 days"),
             prescription=((f'{fname}에 하루 첫 작업 블록 배정' if focus_keys else '집중 패키지 2개를 정하기') if ko else
                           (f'Give {fname} the first work block of each day' if focus_keys else 'Choose 2 focus packages in plan.csv')),
             target='≥ 50%'),
        dict(id='wait', value=now['wait_old'], was=was['wait_old'], display=str(now['wait_old']), range='0',
             level=band(now['wait_old'], 0, 2), level_4w=band(was['wait_old'], 0, 2),
             why=('대기·심사 중 30일 넘게 기록 없음' if ko else 'Waiting tasks with nothing recorded for over 30 days'),
             prescription=('대기 건마다 후속 연락일 정하기' if ko else 'Set a follow-up date for each waiting task'),
             target='0'),
        dict(id='due', value=late + soon, was=None, display=str(late + soon),
             range=('지남 0 · 7일 안 0' if ko else '0 overdue · 0 due within 7 days'),
             level='risk' if late else 'caution' if soon else 'normal', level_4w=None,
             why=(f'마감이 적힌 열린 작업 {len(dated)}개 중 지남 {late} · 7일 안 {soon}' if ko else
                  f'{len(dated)} open tasks with a due date: {late} overdue, {soon} due within 7 days'),
             prescription=('마감 지난 작업은 오늘 끝내거나 마감을 다시 정하기' if ko else
                           'Finish overdue tasks today or agree a new date'),
             target='0'),
        dict(id='undated', value=undated / len(open_nb) if open_nb else 0.0, was=None,
             display=pct(undated / len(open_nb) if open_nb else 0), range='≤ 10%',
             level='caution' if open_nb and undated / len(open_nb) > .1 else 'normal', level_4w=None,
             why=(f'열린 작업 {len(open_nb)}개 중 {undated}개가 날짜 없음' if ko else
                  f'{undated} of {len(open_nb)} open tasks have no dates'),
             prescription=('시작일·최근 진행일 기록' if ko else 'Record the start date and the last progress date'),
             target='≤ 10%'),
    ]
    for r in rows:
        r['name'], r['technique'] = t[r['id']]
        if r['id'] == 'focus':
            r['name'] = (f'{r["name"]}({fname})' if ko else f'{r["name"]} ({fname})') if focus_keys else \
                ('상위 2개 패키지 비중' if ko else 'Top-2 package share')
        r['core'] = r['level_4w'] is not None
        for k in ('value', 'was'):
            if isinstance(r[k], float):
                r[k] = round(r[k], 3)
    score = {'normal': 1, 'caution': .5, 'risk': 0}
    core = [r for r in rows if r['core']]
    index = round(100 * sum(score[r['level']] for r in core) / len(core))
    index_4w = round(100 * sum(score[r['level_4w']] for r in core) / len(core))
    level = 'normal' if index >= 75 else 'caution' if index >= 50 else 'risk'
    bad = lambda i: next(r for r in rows if r['id'] == i)['level'] != 'normal'
    patterns = []
    if bad('sw') or bad('focus'):
        patterns.append('scattered')
    if bad('stale') or bad('wait'):
        patterns.append('stalled')
    if bad('wip') or bad('rho'):
        patterns.append('overloaded')
    if bad('thr') or bad('ct'):
        patterns.append('slow_flow')
    where = fname if focus_keys else ('상위 2개 패키지' if ko else 'your top 2 packages')
    if 'scattered' in patterns:
        strategy = (f'집중이 필요합니다. {where}에 시간의 절반 이상을 쓰고, 나머지 열린 작업은 대기·백로그로 돌리세요.' if ko else
                    f'Focus: spend at least half your time on {where} and move the rest of the open work to waiting or backlog.')
    elif 'stalled' in patterns:
        strategy = ('전략은 유지하되, 이번 주는 정체·대기 건 정리에 씁니다.' if ko else
                    'Keep the strategy, and spend this week clearing stale and waiting items.')
    elif patterns:
        strategy = ('흐름을 먼저 회복합니다: 새 일 시작을 줄이고 열린 일을 닫습니다.' if ko else
                    'Restore flow first: start less, close more.')
    else:
        strategy = '지금 배분과 흐름을 유지합니다.' if ko else 'Keep the current allocation and flow.'
    return {
        'as_of': as_of.isoformat(), 'index': index, 'index_4w_ago': index_4w, 'level': level,
        'patterns': patterns, 'pattern_labels': [t['pattern'][p] for p in patterns],
        'level_label': t['level'][level], 'strategy': strategy, 'stale_limit_days': lim,
        'stale_tasks': [f"{r['year']} {r['code']}" for r in now['stale_rows']],
        'next_checkup': next_checkup or (as_of + dt.timedelta(days=7)).isoformat(),
        'indicators': [{k: r[k] for k in ('id', 'name', 'technique', 'value', 'display', 'range', 'level',
                                          'level_4w', 'why', 'prescription', 'target', 'core')} for r in rows],
        'note': ('대시보드의 검진 탭과 같은 정의(P1 적체 지표 제외). PM 지수 = 핵심 8개 지표의 정상 1·주의 0.5·위험 0 평균 × 100.' if ko else
                 "Same definitions as the dashboard's health check (without its P1 indicator). "
                 'Index = mean over the 8 core indicators of normal 1, caution 0.5, risk 0, × 100.'),
    }


# ------------------------------------------------------------------ summary.json
def load(folder):
    t = S.read_table(os.path.join(folder, 'wbs.csv'), 'wbs')
    if t.issues:
        print('warning: wbs.csv ' + '; '.join(t.issues), file=sys.stderr)
    opt = {}
    for kind in ('plan', 'events', 'coverage'):
        p = os.path.join(folder, S.FILES[kind])
        opt[kind] = S.read_table(p, kind) if os.path.exists(p) else None
    return t, opt


def build(folder, as_of):
    t, opt = load(folder)
    lang, rows = t.lang, t.rows
    for r in rows:
        r['st'] = S.norm('status', r['status']) or 'in_progress'
        r['imp'] = S.norm('importance', r['importance']) or 'medium'
        r['lead'] = lead_days(r)
        r['adays'] = activity_days(r, as_of)
        due = day(r['due'])
        r['days_to_due'] = (due - as_of).days if due and r['st'] != 'done' else None
    parents = {(r['year'], S.parent_of(r['code'])) for r in rows if r['level'] == '4'}
    leaves = [r for r in rows if (r['year'], r['code']) not in parents]
    key = lambda r: (r['year'], r['code'])
    pkg_name = {(r['year'], S.package_of(r['code'])): r['package'] for r in rows}

    # plan
    plan = {'goals': [], 'focus': [], 'last_checkup': '', 'next_checkup': '', 'config': {}}
    focus_keys, focus_names = set(), []
    if opt['plan']:
        for p in opt['plan'].rows:
            kind = S.norm('plan_kind', p['kind'])
            if kind == 'goal':
                plan['goals'].append({'name': p['target'], 'note': p['note'], 'decided': p['decided'], 'recheck': p['recheck']})
            elif kind == 'focus':
                focus_keys.add((p['year'], p['target']))
                name = pkg_name.get((p['year'], p['target']), p['target'])
                focus_names.append(name)
                plan['focus'].append({'year': p['year'], 'code': p['target'], 'package': name, 'note': p['note'],
                                      'decided': p['decided'], 'recheck': p['recheck']})
            elif kind == 'checkup':
                plan['last_checkup'] = max(plan['last_checkup'], p['decided'])
                plan['next_checkup'] = max(plan['next_checkup'], p['recheck'])
            elif kind == 'config':
                plan['config'][p['target']] = p['note']

    # open tasks, most urgent first; backlog last
    def public(r):
        out = {k: r[k] for k, _ in S.WBS_COLUMNS}
        out['status'], out['importance'] = r['st'], r['imp']
        last = last_at(r, as_of)
        cat, _ = S.split_blocker(r['blocker'])
        out.update({
            'has_steps': key(r) in parents,
            'blocker_category': cat or '',
            'last_activity': last.isoformat() if last else '',
            'days_since_progress': (as_of - last).days if last else None,
            'days_to_due': r['days_to_due'],
            'overdue': r['days_to_due'] is not None and r['days_to_due'] < 0,
            'focus': (r['year'], S.package_of(r['code'])) in focus_keys,
        })
        return out
    open_rows = [public(r) for r in rows if r['st'] != 'done']
    open_rows.sort(key=lambda o: (o['status'] == 'backlog', not o['overdue'],
                                  o['days_to_due'] if o['days_to_due'] is not None else 10 ** 6,
                                  IMP_RANK[o['importance']], -(o['days_since_progress'] or 0)))

    # counts (leaves)
    by_status = {c: 0 for c in S.VOCAB['status']}
    by_year = {}
    for r in leaves:
        by_status[r['st']] += 1
        y = by_year.setdefault(r['year'], {'leaves': 0, **{c: 0 for c in S.VOCAB['status']}, 'key_results': 0})
        y['leaves'] += 1
        y[r['st']] += 1
    for r in rows:
        if r['key_result'] == 'Y' and r['year'] in by_year:
            by_year[r['year']]['key_results'] += 1
    for y in by_year.values():
        y['completion_rate'] = round(y['done'] / y['leaves'], 3) if y['leaves'] else 0

    # packages
    packages = {}
    for r in rows:
        pk = (r['year'], S.package_of(r['code']))
        p = packages.setdefault(pk, {'year': pk[0], 'code': pk[1], 'name': r['package'].split(' ', 1)[-1],
                                     'area': r['area'], 'leaves': 0, 'done': 0,
                                     'open': {'in_progress': 0, 'waiting': 0, 'backlog': 0},
                                     'key_results': 0, 'last_progress': '', 'focus': pk in focus_keys})
        if r['key_result'] == 'Y':
            p['key_results'] += 1
        last = last_at(r, as_of)
        if last and last.isoformat() > p['last_progress']:
            p['last_progress'] = last.isoformat()
    for r in leaves:
        p = packages[(r['year'], S.package_of(r['code']))]
        p['leaves'] += 1
        if r['st'] == 'done':
            p['done'] += 1
        else:
            p['open'][r['st']] += 1
    for p in packages.values():
        p['days_since_progress'] = (as_of - day(p['last_progress'])).days if p['last_progress'] else None
    pkg_list = sorted(packages.values(), key=lambda p: (-int(p['year']), S.code_key(p['code'] + '.0')))

    # recent completions (leaves with an exact end date)
    def recent(n):
        lo = as_of - dt.timedelta(days=n - 1)
        out = [{'year': r['year'], 'code': r['code'], 'task': r['task'], 'end': r['end'],
                'package': r['package'], 'key_result': r['key_result'] == 'Y'}
               for r in leaves if r['st'] == 'done' and S.is_day(r['end']) and lo <= day(r['end']) <= as_of]
        return sorted(out, key=lambda o: (o['end'], o['code']), reverse=True)

    # coverage
    coverage = None
    if opt['coverage']:
        cov = {}
        for c in opt['coverage'].rows:
            s = S.norm('coverage_state', c['state']) or 'not_started'
            y = cov.setdefault(c['year'], {k: 0 for k in S.VOCAB['coverage_state']})
            y[s] += 1
        for y in cov.values():
            usable = sum(y.values()) - y['unavailable']
            y['percent_complete'] = round(100 * y['complete'] / usable) if usable else 0
        coverage = {'by_year': dict(sorted(cov.items(), reverse=True)),
                    'open_windows': sum(y['partial'] + y['not_started'] for y in cov.values())}

    events = None
    if opt['events']:
        ev = opt['events'].rows
        events = {'count': len(ev), 'estimated': sum(e['estimated'] == 'Y' for e in ev),
                  'last_date': max((e['date'] for e in ev), default='')}

    labels = {k: S.labels(k, lang) for k in ('status', 'importance', 'blocker')}
    labels['level'] = TEXT[lang]['level']
    years = sorted(by_year, reverse=True)
    return {
        'generator': 'personal-wbs make_agent_files.py',
        'schema_version': S.SCHEMA_VERSION,
        'as_of': as_of.isoformat(),
        'language': lang,
        'files': {f: os.path.exists(os.path.join(folder, f)) for f in
                  ('wbs.csv', 'plan.csv', 'events.csv', 'coverage.csv', 'index.html')},
        'labels': labels,
        'counts': {'rows': len(rows), 'leaves': len(leaves), 'parents': len(parents),
                   'steps': sum(1 for r in rows if r['level'] == '4'),
                   'by_status': by_status, 'by_year': {y: by_year[y] for y in years}},
        'open_tasks': open_rows,
        'packages': pkg_list,
        'recent_completions': {'7d': recent(7), '30d': recent(30)},
        'plan': plan,
        'coverage': coverage,
        'events': events,
        'health': health(leaves, as_of, lang, focus_keys, focus_names, plan['next_checkup']),
    }


# ------------------------------------------------------------------ llms.txt
LLMS = {
    'en': """# Personal WBS ledger

> One ledger of all work across years, kept by AI agents. As of {as_of}: {leaves} leaf tasks over {years}; open now {in_progress} in progress, {waiting} waiting, {backlog} in backlog; health check {index}/100 ({level}), next check {next_checkup}.

This folder holds the raw ledger and two files written for agents. Read `summary.json` first; open `wbs.csv` for detail or history. The ledger is raw data: one row per concrete deliverable, decision or event, dated from its source and pointing to its evidence. Summaries, rollups and the health check are computed views, never rows. Files are UTF-8 CSV (with BOM) or JSON; this ledger is kept in English.

## Files

{files}

## Schema of wbs.csv

| column | meaning |
|---|---|
| year | the year tree the row belongs to (= year of `start`); key = (year, code) |
| code | WBS code `area.package.task` or `area.package.task.step`; permanent, gaps are retired codes |
| level | 3 = task, 4 = dated step under a level-3 parent |
| area / package | `<n> <name>` and `<n.m> <name>` |
| parent | level-4 rows only: `<parent code> <parent title>` |
| task | what was produced, decided or happened, with numbers; unverified outcomes say so |
| start / end | `YYYY-MM-DD` from the source timestamp; `end` blank while open; blank = unknown (never guessed) |
| date_text | the human form, e.g. `2026-06-22 ~ 07-12`, `planned`, `not recorded` |
| start_month | first 7 characters of `start` |
| status | `done`, `in_progress`, `waiting` (on someone else), `backlog` (parked on purpose) |
| key_result | `Y` for headline results only |
| source | who wrote the row (e.g. Claude, GPT, Claude·GPT) |
| due | real deadline or committed date |
| importance | `high`, `medium`, `low`; blank = medium |
| size | estimate when created: S ≤ 1 day, M ≤ 1 week, L ≤ 1 month, XL > 1 month |
| depends_on | prerequisite codes separated by `;` (`2025:1.2.3` for another year) |
| blocker | `<category>: <what or who>`; categories: external review, external reply, external dependency, prerequisite, scheduled later, on hold, result unconfirmed |
| last_progress | last day anything happened on the row |
| goal | one goal from the goal list in plan.csv |
| evidence | `;`-separated pointers such as `claude:<chat id8>`, `gpt:<conversation id>`, `gh:<owner/repo>#<PR>`, `drive:<file title>`, `cal:<date>` |

## How to answer common questions

- **What is blocked?** `summary.json` → `open_tasks` with `status` = `waiting` or a non-empty `blocker`. Quote the blocker; `blocker_category` is normalized.
- **What is overdue or due soon?** `open_tasks` with `overdue` = true; due within a week: `0 ≤ days_to_due ≤ 7`.
- **What did I finish this week (this month)?** `recent_completions["7d"]` (`["30d"]`). Rows with month-only end dates are not in these lists.
- **What should I work on next?** `open_tasks` are sorted by urgency (overdue, nearest due date, importance, idle days). Prefer `focus` packages, skip `backlog`, and check `depends_on`.
- **How am I doing?** `health`: index 0–100 and its value 4 weeks ago, level, patterns, each indicator with its value, reference range, level and prescription, and the next check-up date.
- **What happened to X?** Search `task` in `wbs.csv`; its history is in `events.csv` (rows with `estimated` = Y were reconstructed later). Follow `evidence` to re-verify.
- **How complete is the ledger?** `coverage.by_year[year].percent_complete` = complete windows ÷ windows that are not unavailable.

## Conventions

- Counts, completion rates and the health check use leaf rows (rows without steps).
- Each year has its own tree; a task that continues into a new year gets a new row there marked "(continued)".
- One row per deliverable, decision or event. Never merge several outcomes into a range row; separately dated steps are level-4 rows.
- Answer in the user's language; when writing rows, keep the ledger's language (English here).
- In `summary.json`, keys and enumerated values (status, importance, blocker category, level) are English codes; `labels` gives their display labels.
- `summary.json` is generated: never edit it by hand. Regenerate it with `make_agent_files.py` after changing the CSV files.
{optional}""",
    'ko': """# 개인 WBS 원장

> 여러 해에 걸친 모든 작업을 한 원장에 모으고 AI 에이전트가 관리합니다. {as_of} 기준: {years} 리프 작업 {leaves}개, 지금 열린 작업 진행 중 {in_progress} · 대기·심사 {waiting} · 백로그 {backlog}, 검진 {index}/100({level}), 다음 검진 {next_checkup}.

이 폴더에는 원본 원장과 에이전트용 파일 두 개가 있습니다. 먼저 `summary.json`을 읽고, 세부 내용이나 이력이 필요할 때 `wbs.csv`를 엽니다. 원장은 원자료입니다. 한 행은 하나의 구체적 산출물·결정·사건이고, 출처의 시각으로 날짜를 적고, 근거를 가리킵니다. 요약·집계·검진은 계산된 보기일 뿐 행이 아닙니다. 파일은 UTF-8 CSV(BOM 포함) 또는 JSON이며, 이 원장은 한국어로 기록합니다.

## 파일

{files}

## wbs.csv 스키마

| 열 | 뜻 |
|---|---|
| 연도 | 행이 속한 연도 트리(= 시작일의 연도). 키 = (연도, WBS) |
| WBS | `대분류.중분류.작업` 또는 `대분류.중분류.작업.단계` 코드. 한 번 쓰면 바꾸지 않으며, 빈 번호는 폐기된 코드 |
| 레벨 | 3 = 작업, 4 = 레벨 3 상위 작업 아래의 날짜 있는 단계 |
| 대분류 / 중분류 | `<n> <이름>`, `<n.m> <이름>` |
| 상위 작업 | 레벨 4 행만: `<상위 코드> <상위 제목>` |
| 작업·산출물 | 무엇을 만들었고 정했고 무슨 일이 있었는지, 숫자와 함께. 확인 안 된 결과는 그렇다고 적음 |
| 시작일 / 종료일 | 출처 시각의 `YYYY-MM-DD`. 열린 작업은 종료일 비움. 모르면 비움(추측 금지) |
| 일자(원문) | 사람이 쓰는 형태: `2026-06-22 ~ 07-12`, `예정`, `미기록` |
| 시작월 | 시작일의 앞 7자 |
| 상태 | `완료`, `진행 중`, `대기·심사`(다른 사람을 기다림), `백로그`(일부러 미룸) |
| 핵심성과 | 대표 성과만 `Y` |
| 출처 | 행을 쓴 주체(예: Claude, GPT, Claude·GPT) |
| 마감일 | 실제 마감 또는 약속한 날짜 |
| 중요도 | `상`, `중`, `하`. 비우면 중 |
| 크기 | 만들 때의 추정: S ≤ 1일, M ≤ 1주, L ≤ 1달, XL > 1달 |
| 선행 | 선행 작업 코드를 `;`로 구분(다른 연도는 `2025:1.2.3`) |
| 막힘 사유 | `<분류>: <무엇 또는 누구>`. 분류: 외부 심사·승인, 외부 응답, 외부 의존·차단, 선행 조건, 일정·연기, 보류, 결과 미확인 |
| 최근 진행일 | 그 행에 마지막으로 무언가 일어난 날 |
| 목표 | plan.csv 목표 목록 중 하나 |
| 근거 | `;`로 구분한 포인터: `claude:<대화 id8>`, `gpt:<대화 id>`, `gh:<owner/repo>#<PR>`, `drive:<파일 제목>`, `cal:<날짜>` |

## 자주 받는 질문에 답하는 법

- **무엇이 막혀 있나?** `summary.json` → `open_tasks` 중 `status`가 `waiting`이거나 `blocker`가 있는 것. 막힘 사유를 그대로 인용하고, `blocker_category`는 정규화된 분류.
- **마감이 지났거나 다가오는 것은?** `open_tasks` 중 `overdue`가 true인 것, 일주일 안: `0 ≤ days_to_due ≤ 7`.
- **이번 주(이번 달)에 끝낸 것은?** `recent_completions["7d"]`(`["30d"]`). 종료일이 월까지만 있는 행은 빠짐.
- **다음에 무엇을 할까?** `open_tasks`는 긴급도 순(마감 지남, 가까운 마감, 중요도, 정체 일수). `focus` 패키지를 먼저, `backlog`는 건너뛰고, `depends_on`을 확인.
- **나 요즘 어때?** `health`: 0–100 지수와 4주 전 값, 판정, 패턴, 지표별 값·기준 범위·판정·처방, 다음 검진일.
- **X는 어떻게 됐나?** `wbs.csv`의 작업·산출물에서 찾고, 이력은 `events.csv`(추정 = Y는 나중에 복원한 기록). `근거`를 따라가 다시 확인.
- **원장이 얼마나 완전한가?** `coverage.by_year[연도].percent_complete` = 완료 창 ÷ 불가가 아닌 창.

## 규칙

- 개수·완료율·검진은 리프 행(단계가 없는 행) 기준.
- 연도마다 트리가 따로 있고, 새해로 이어진 작업은 새해 트리에 "(계속)"을 붙인 새 행으로 기록.
- 한 행 = 산출물·결정·사건 하나. 여러 결과를 기간 행 하나로 합치지 않고, 따로 날짜가 있는 단계는 레벨 4 행으로 기록.
- 답은 사용자의 언어로, 행을 쓸 때는 원장의 언어(여기서는 한국어)를 지킴.
- `summary.json`의 키와 열거형 값(상태, 중요도, 막힘 분류, 판정)은 영어 코드이며, `labels`에 한국어 표기가 있음.
- `summary.json`은 생성 파일이므로 손으로 고치지 않고, CSV를 바꾼 뒤 `make_agent_files.py`로 다시 만듦.
{optional}""",
}

FILE_LINES = {
    'en': {
        'summary.json': 'precomputed state: counts by status, open tasks with every field and days since last progress, packages, recent completions (7 and 30 days), plan (goals, focus, next check-up), sweep coverage and the health check',
        'wbs.csv': 'the ledger and source of truth: one row per task or dated step, all years in one file',
        'plan.csv': 'goals, focus packages, health-check dates and settings (`kind,year,target,note,decided,recheck`)',
        'events.csv': 'append-only log of creations, status changes, corrections and moves',
        'coverage.csv': 'how completely each year × month × source window has been swept',
        'index.html': 'the dashboard: board, health check, flow, rhythm, topics and forecasts, computed in the browser from these files',
        'sweep_state.json': 'resumable state of the sweep (item IDs already reviewed)',
        'digest': 'one line per reviewed source item for that year',
    },
    'ko': {
        'summary.json': '미리 계산한 상태: 상태별 개수, 모든 열과 마지막 진행 후 경과일을 담은 열린 작업, 패키지, 최근 완료(7일·30일), 계획(목표·집중·다음 검진), 수집 완전성, 검진',
        'wbs.csv': '원장이자 기준 자료: 작업이나 날짜 있는 단계마다 한 행, 모든 연도를 한 파일에',
        'plan.csv': '목표, 집중 패키지, 검진일과 설정(`종류,연도,대상,내용,결정일,재검일`)',
        'events.csv': '생성·상태 변경·정정·이동을 덧붙이기만 하는 기록',
        'coverage.csv': '연도 × 월 × 소스 창마다 얼마나 빠짐없이 수집했는지',
        'index.html': '대시보드: 보드, 검진, 흐름, 리듬, 주제, 예측을 이 파일들로 브라우저에서 계산',
        'sweep_state.json': '수집 작업의 이어 하기 상태(이미 본 항목 ID)',
        'digest': '그해 검토한 출처 항목마다 한 줄',
    },
}


def write_llms(folder, s):
    lang = s['language']
    present = sorted(os.listdir(folder))
    lines, optional = [], []
    for name in ('summary.json', 'wbs.csv', 'plan.csv', 'events.csv', 'coverage.csv'):
        if name in present:
            lines.append(f'- [{name}]({name}): {FILE_LINES[lang][name]}')
    for name in present:
        if name in ('index.html', 'index.ko.html', 'index.zh-CN.html'):
            optional.append(f"- [{name}]({name}): {FILE_LINES[lang]['index.html']}")
        elif name == 'sweep_state.json':
            optional.append(f'- [{name}]({name}): {FILE_LINES[lang][name]}')
        elif re.fullmatch(r'digest_\d{4}\.csv', name):
            optional.append(f"- [{name}]({name}): {FILE_LINES[lang]['digest']}")
    opt = ('\n## Optional\n\n' + '\n'.join(optional) + '\n') if optional else ''
    years = sorted(s['counts']['by_year'])
    span = f'{years[0]}–{years[-1]}' if len(years) > 1 else (years[0] if years else '-')
    b, h = s['counts']['by_status'], s['health']
    text = LLMS[lang].format(as_of=s['as_of'], leaves=s['counts']['leaves'], years=span,
                             in_progress=b['in_progress'], waiting=b['waiting'], backlog=b['backlog'],
                             index=h['index'], level=h['level_label'], next_checkup=h['next_checkup'],
                             files='\n'.join(lines), optional=opt)
    with open(os.path.join(folder, 'llms.txt'), 'w', encoding='utf-8') as f:
        f.write(text.rstrip('\n') + '\n')


def run(folder, as_of):
    s = build(folder, as_of)
    with open(os.path.join(folder, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
        f.write('\n')
    write_llms(folder, s)
    b, h = s['counts']['by_status'], s['health']
    print(f"{folder}: summary.json + llms.txt ({s['language']}, as of {s['as_of']}) · "
          f"{s['counts']['leaves']} leaves, open {b['in_progress']}/{b['waiting']}/{b['backlog']} "
          f"(in progress/waiting/backlog) · health {h['index']} {h['level']}")


def main():
    ap = argparse.ArgumentParser(description='Write summary.json and llms.txt from a WBS ledger.')
    ap.add_argument('folder', help='folder holding wbs.csv (or a folder of such folders)')
    ap.add_argument('--as-of', help='reference date YYYY-MM-DD (default: today)')
    args = ap.parse_args()
    as_of = dt.date.fromisoformat(args.as_of) if args.as_of else dt.date.today()
    f = args.folder
    if os.path.exists(os.path.join(f, 'wbs.csv')):
        folders = [f]
    else:
        folders = sorted(os.path.join(f, d) for d in os.listdir(f) if os.path.exists(os.path.join(f, d, 'wbs.csv')))
    if not folders:
        sys.exit(f'no wbs.csv found in {f}')
    for folder in folders:
        run(folder, as_of)


if __name__ == '__main__':
    main()
