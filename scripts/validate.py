#!/usr/bin/env python3
"""Validate a personal WBS ledger (schema v6) and its companion files.

Usage:
  python3 validate.py <folder | wbs.csv> [--strict] [--atomize] [--max N] [--today YYYY-MM-DD]

Checks wbs.csv and, when they sit next to it, plan.csv, coverage.csv and events.csv.
Headers and values may be English or Korean. A folder without wbs.csv is searched
one level down, so `validate.py sample` checks sample/en and sample/ko.

Prints a short report. Exit code 1 on errors (with --strict, also on warnings).
--atomize lists the rows the range-row atomization pass should re-check: leaf rows
whose dates span several days and whose text lists several outcomes, rows with
dates written inside the text, long rows without dated steps, undated rows.
"""
import argparse
import datetime as dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbs_schema as S  # noqa: E402

LIMIT_SPAN_DAYS = 31     # a leaf longer than this should have dated level-4 steps
EVIDENCE_RE = re.compile(r'^[a-z][a-z0-9+._-]*:\S')
DATE_IN_TEXT = re.compile(r'(?:^|[^\d-])(?:20\d\d-)?(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])(?![\d-])')
# privacy lint: things that should not be in a shared ledger
PRIVACY = [
    ('e-mail address', re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+')),
    ('@handle', re.compile(r'(?<![\w.])@[A-Za-z0-9_][\w.-]{1,}')),
    ('phone number', re.compile(r'(?<![\d-])(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{4}(?![\d-])')),
    ('long number (account or card?)', re.compile(r'(?<![\d.,-])\d{10,}(?![\d.,-])')),
]


class Report:
    def __init__(self, name):
        self.name, self.errors, self.warnings, self.notes, self.summary = name, [], [], [], ''

    def err(self, where, msg):
        self.errors.append(f'{where}: {msg}')

    def warn(self, where, msg):
        self.warnings.append(f'{where}: {msg}')


def where(r):
    tag = f" ({r.get('year', '')} {r.get('code', '')})" if r.get('code') else ''
    return f"row {r['_row']}{tag}"


def check_dates(rep, r, fields):
    ok = True
    for f in fields:
        if not S.valid_date(r[f]):
            rep.err(where(r), f'{f} "{r[f]}" is not YYYY-MM-DD or YYYY-MM')
            ok = False
    return ok


def outcome_segments(text):
    """Pieces of a task text that read like separate outcomes (';' or ' + ' separated)."""
    return [p for p in re.split(r';|\s\+\s', text) if p.strip()]


# ------------------------------------------------------------------ wbs.csv
def check_wbs(path, today, goals):
    rep = Report('wbs.csv')
    t = S.read_table(path, 'wbs')
    for msg in t.issues:
        rep.err('header', msg)
    if not t.has_bom:
        rep.warn('file', 'no UTF-8 BOM (spreadsheet apps may garble non-ASCII text)')
    rows, lang = t.rows, t.lang
    idx, first = {}, {}
    other_lang = 0
    pkg_names, area_names = {}, {}

    for r in rows:
        w = where(r)
        if r['_cells'] != len(S.WBS_COLUMNS):
            rep.err(w, f"{r['_cells']} cells, expected {len(S.WBS_COLUMNS)}")
        key = (r['year'], r['code'])
        if key in first:
            rep.err(w, f'duplicate key, first seen at row {first[key]}')
        else:
            first[key], idx[key] = r['_row'], r
        if not re.fullmatch(r'\d{4}', r['year']):
            rep.err(w, f'year "{r["year"]}" is not a 4-digit year')
        code = r['code']
        if not S.CODE_RE.match(code):
            rep.err(w, f'code "{code}" is not area.package.task(.step)')
            continue
        depth = code.count('.') + 1
        if r['level'] != str(depth):
            rep.err(w, f'level "{r["level"]}" does not match code depth {depth}')
        # area and package carry the code prefix: "1 Research", "1.2 Workshop paper"
        a, p = S.lead_token(r['area']), S.lead_token(r['package'])
        if a != code.split('.')[0] or ' ' not in r['area'].strip():
            rep.err(w, f'area "{r["area"]}" should read "{code.split(".")[0]} <name>"')
        if p != S.package_of(code) or ' ' not in r['package'].strip():
            rep.err(w, f'package "{r["package"]}" should read "{S.package_of(code)} <name>"')
        pkg_names.setdefault((r['year'], p), set()).add(r['package'])
        area_names.setdefault(a, set()).add(r['area'])
        # dates
        if check_dates(rep, r, ('start', 'end', 'due', 'last_progress')):
            s, e = r['start'], r['end']
            if r['start_month'] != s[:7]:
                rep.err(w, f'start_month "{r["start_month"]}" should be "{s[:7]}"')
            if s and r['year'] != s[:4]:
                rep.err(w, f'year {r["year"]} differs from the start year {s[:4]}')
            if s and e and e[:len(s)] < s[:len(e)]:
                rep.err(w, f'end {e} is before start {s}')
            lp = r['last_progress']
            if lp and s and lp[:len(s)] < s[:len(lp)]:
                rep.warn(w, f'last_progress {lp} is before start {s}')
            for f in ('start', 'end', 'last_progress'):
                d = S.to_day(r[f])
                if d and d > today:
                    rep.warn(w, f'{f} {r[f]} is in the future')
        # enumerations
        st = S.norm('status', r['status'])
        if not r['status']:
            rep.err(w, 'status is blank')
        elif st is None:
            rep.err(w, f'status "{r["status"]}" is not one of done, in_progress, waiting, backlog (or Korean)')
        if r['key_result'] not in ('', 'Y'):
            rep.err(w, f'key_result "{r["key_result"]}" must be Y or blank')
        if r['key_result'] == 'Y' and depth == 4:
            rep.err(w, 'level-4 steps never carry key_result')
        if S.norm('importance', r['importance']) is None:
            rep.err(w, f'importance "{r["importance"]}" must be high/medium/low (상/중/하) or blank')
        if r['size'] not in ('',) + S.SIZES:
            rep.err(w, f'size "{r["size"]}" must be S, M, L, XL or blank')
        cat, what = S.split_blocker(r['blocker'])
        if cat is None:
            rep.err(w, f'blocker "{r["blocker"]}" should read "<category>: <what or who>" with a known category')
        elif cat and not what:
            rep.warn(w, 'blocker names a category but not what or who')
        for kind, field in (('status', 'status'), ('importance', 'importance')):
            vl = S.value_lang(kind, r[field])
            if vl and vl != lang and r[field] not in ('',):
                other_lang += 1
        if r['blocker'] and S.value_lang('blocker', r['blocker'].split(':')[0]) not in (None, lang):
            other_lang += 1
        # status hygiene
        if st == 'done' and r['start'] and not r['end']:
            rep.warn(w, 'done without an end date')
        if st == 'waiting' and not r['blocker']:
            rep.warn(w, 'waiting without a blocker (who or what is it waiting on?)')
        if st == 'done' and r['blocker']:
            rep.warn(w, 'done but still has a blocker (clear it)')
        if not r['source']:
            rep.warn(w, 'source (who wrote the row) is blank')
        if goals is not None and r['goal'] and r['goal'] not in goals:
            rep.warn(w, f'goal "{r["goal"]}" is not in the goal list of plan.csv')
        ev = S.split_list(r['evidence'])
        if not ev:
            rep.warn(w, 'no evidence pointer (source:id) to re-verify the row')
        for tok in ev:
            if not EVIDENCE_RE.match(tok):
                rep.warn(w, f'evidence "{tok}" should read <source>:<id>')
        for field in ('task', 'blocker', 'evidence', 'goal'):
            for name, rx in PRIVACY:
                if field == 'evidence' and name != 'e-mail address':
                    continue   # evidence holds IDs (hashes, message ids), so only e-mail addresses are flagged
                if rx.search(r[field]):
                    rep.warn(w, f'possible personal data ({name}) in {field}')

    # second pass: structure across rows
    for r in rows:
        code, y, w = r['code'], r['year'], where(r)
        if not S.CODE_RE.match(code):
            continue
        if r['level'] == '4':
            pc = S.parent_of(code)
            par = idx.get((y, pc))
            if not par:
                rep.err(w, f'parent {pc} does not exist in {y}')
            elif par['level'] != '3':
                rep.err(w, f'parent {pc} is not a level-3 row')
            if S.lead_token(r['parent']) != pc:
                rep.err(w, f'parent column should start with "{pc} "')
        elif r['parent']:
            rep.err(w, 'parent column must be blank on level-3 rows')
        deps = S.split_list(r['depends_on'])
        for tok in deps:
            dy, dc = S.parse_dep(tok, y)
            if (dy, dc) == (y, code):
                rep.err(w, 'depends on itself')
            elif (dy, dc) not in idx:
                rep.err(w, f'depends_on "{tok}" does not exist')

    # parents and steps
    steps = {}
    for r in rows:
        if r['level'] == '4':
            steps.setdefault((r['year'], S.parent_of(r['code'])), []).append(r)
    for key, kids in steps.items():
        par = idx.get(key)
        if par and S.norm('status', par['status']) == 'done' and any(S.norm('status', k['status']) != 'done' for k in kids):
            rep.warn(where(par), 'parent is done but has open steps')

    # dependency cycles
    graph = {k: [S.parse_dep(t, k[0]) for t in S.split_list(r['depends_on'])] for k, r in idx.items()}
    state, cyc = {}, set()

    def visit(k, stack):
        state[k] = 1
        for d in graph.get(k, []):
            if d not in graph:
                continue
            if state.get(d) == 1:
                cyc.add(' -> '.join(f'{a}:{b}' for a, b in stack[stack.index(d):] + [d]))
            elif not state.get(d):
                visit(d, stack + [d])
        state[k] = 2
    for k in graph:
        if not state.get(k):
            visit(k, [k])
    for c in sorted(cyc):
        rep.err('depends_on', f'cycle {c}')

    # naming consistency
    for (y, p), names in sorted(pkg_names.items()):
        if len(names) > 1:
            rep.warn(f'{y} package {p}', 'written in more than one way: ' + ' | '.join(sorted(names)))
    for a, names in sorted(area_names.items()):
        if len(names) > 1:
            rep.warn(f'area {a}', 'written in more than one way: ' + ' | '.join(sorted(names)))
    if other_lang:
        rep.warn('values', f'{other_lang} values are in the other language (accepted; keep one language per file)')
    keys = [(r['year'], r['code']) for r in rows]
    if keys != [(r['year'], r['code']) for r in sorted(rows, key=S.ledger_sort_key)]:
        rep.warn('order', 'rows are not sorted (newest year first, then code)')

    rep.notes = atomicity_candidates(rows, today)
    leaves = S.leaf_rows(rows)
    n4 = sum(1 for r in rows if r['level'] == '4')
    n_par = len(rows) - len(leaves)
    years = sorted({r['year'] for r in rows if r['year'].isdigit()})
    span = f'{years[0]}–{years[-1]}' if len(years) > 1 else (years[0] if years else '-')
    rep.summary = (f'{lang} · {len(rows)} rows ({len(leaves)} leaves, {n_par} parents, {n4} steps) · {span}')
    return rep, rows, lang


def atomicity_candidates(rows, today):
    """Rows the atomization pass should re-check against their sources."""
    has_steps = {(r['year'], S.parent_of(r['code'])) for r in rows if r['level'] == '4'}
    out = []
    for r in rows:
        key = (r['year'], r['code'])
        leaf = key not in has_steps
        st = S.norm('status', r['status'])
        s, e = S.to_day(r['start']), S.to_day(r['end'])
        why = []
        if leaf and s and e and e > s and len(outcome_segments(r['task'])) > 1:
            why.append('range row listing several outcomes')
        if DATE_IN_TEXT.search(r['task']):
            why.append('date written inside the task text')
        if leaf and s and st in ('done', 'in_progress'):
            last = e if st == 'done' else today
            if last and (last - s).days > LIMIT_SPAN_DAYS:
                why.append(f'spans {(last - s).days} days without dated steps')
        if not r['start']:
            dt_word = r['date_text'].strip().lower()
            if dt_word not in [w.lower() for w in S.DATE_WORDS['planned']]:
                why.append('no start date (flagged for the sweep)')
        elif S.MONTH_RE.match(r['start']):
            why.append('month-only start date (find the exact day)')
        if why:
            out.append(f"{where(r)}: {', '.join(why)}")
    return out


# ------------------------------------------------------------------ plan.csv
def check_plan(path, wbs_rows):
    rep = Report('plan.csv')
    t = S.read_table(path, 'plan')
    for msg in t.issues:
        rep.err('header', msg)
    packages = {(r['year'], S.package_of(r['code'])) for r in wbs_rows if S.CODE_RE.match(r['code'])}
    goals, n = set(), {'goal': 0, 'focus': 0, 'checkup': 0, 'config': 0}
    next_check = ''
    for r in t.rows:
        w = f"row {r['_row']}"
        kind = S.norm('plan_kind', r['kind'])
        if not kind:
            rep.err(w, f'kind "{r["kind"]}" must be goal, focus, checkup or config (or Korean)')
            continue
        n[kind] += 1
        if r['year'] and not re.fullmatch(r'\d{4}', r['year']):
            rep.err(w, f'year "{r["year"]}" is not a 4-digit year')
        for f in ('decided', 'recheck'):
            if r[f] and not S.is_day(r[f]):
                rep.err(w, f'{f} "{r[f]}" is not YYYY-MM-DD')
        if kind == 'goal':
            if not r['target']:
                rep.err(w, 'goal rows need the goal name in target')
            goals.add(r['target'])
        if kind == 'focus' and wbs_rows and (r['year'], r['target']) not in packages:
            rep.warn(w, f'focus package {r["year"]} {r["target"]} does not exist in wbs.csv')
        if kind == 'checkup' and r['recheck']:
            next_check = max(next_check, r['recheck'])
    rep.summary = (f"{n['goal']} goals, {n['focus']} focus, {n['checkup']} checkup"
                   + (f' (next {next_check})' if next_check else ''))
    return rep, goals


# ------------------------------------------------------------------ coverage.csv
def check_coverage(path, today):
    rep = Report('coverage.csv')
    t = S.read_table(path, 'coverage')
    for msg in t.issues:
        rep.err('header', msg)
    seen, count = set(), {}
    for r in t.rows:
        w = f"row {r['_row']} ({r['year']}-{r['month']} {r['source']})"
        if not re.fullmatch(r'\d{4}', r['year']):
            rep.err(w, 'year is not a 4-digit year')
            continue
        if not (r['month'].isdigit() and 1 <= int(r['month']) <= 12):
            rep.err(w, f'month "{r["month"]}" must be 01-12')
            continue
        key = (r['year'], int(r['month']), r['source'])
        if key in seen:
            rep.err(w, 'duplicate window')
        seen.add(key)
        state = S.norm('coverage_state', r['state'])
        if not state:
            rep.err(w, f'state "{r["state"]}" must be not_started, partial, complete or unavailable (or Korean)')
            continue
        count[state] = count.get(state, 0) + 1
        for f in ('passes', 'new_last_pass'):
            if r[f] and not r[f].isdigit():
                rep.err(w, f'{f} "{r[f]}" is not a whole number')
        if r['last_checked'] and not S.is_day(r['last_checked']):
            rep.err(w, f'last_checked "{r["last_checked"]}" is not YYYY-MM-DD')
        if state == 'complete':
            over = (int(r['year']), int(r['month'])) < (today.year, today.month)
            if not over or int(r['passes'] or 0) < 2 or (r['new_last_pass'] or '0') != '0':
                rep.warn(w, 'complete needs a finished month, 2+ passes and 0 new items in the last pass')
    total = sum(count.values())
    usable = total - count.get('unavailable', 0)
    pct = round(100 * count.get('complete', 0) / usable) if usable else 0
    parts = ', '.join(f'{count[k]} {k}' for k in ('complete', 'partial', 'not_started', 'unavailable') if count.get(k))
    rep.summary = f'{total} windows ({parts}) · {pct}% complete'
    return rep


# ------------------------------------------------------------------ events.csv
def check_events(path, wbs_keys):
    rep = Report('events.csv')
    t = S.read_table(path, 'events')
    for msg in t.issues:
        rep.err('header', msg)
    est = 0
    unknown = set()
    for r in t.rows:
        w = f"row {r['_row']}"
        if not S.is_day(r['date']):
            rep.err(w, f'date "{r["date"]}" is not YYYY-MM-DD')
        if not S.norm('event', r['event']):
            rep.err(w, f'event "{r["event"]}" must be create, status, enrich, correct or move (or Korean)')
        for f in ('from_status', 'to_status'):
            if S.norm('status', r[f]) is None:
                rep.err(w, f'{f} "{r[f]}" is not a status')
        if r['estimated'] not in ('', 'Y'):
            rep.err(w, f'estimated "{r["estimated"]}" must be Y or blank')
        est += r['estimated'] == 'Y'
        if wbs_keys is not None and (r['year'], r['code']) not in wbs_keys:
            unknown.add(f"{r['year']} {r['code']}")
    if unknown:
        rep.warn('codes', f'{len(unknown)} codes are not in wbs.csv (retired?): ' + ', '.join(sorted(unknown)[:8]))
    rep.summary = f'{len(t.rows)} events ({est} estimated)'
    return rep


# ------------------------------------------------------------------ driver
def validate_folder(folder, today, args):
    reps = []
    plan_p, wbs_p = os.path.join(folder, 'plan.csv'), os.path.join(folder, 'wbs.csv')
    goals = None
    wbs_rep, rows, _ = check_wbs(wbs_p, today, None)
    if os.path.exists(plan_p):
        plan_rep, goals = check_plan(plan_p, rows)
        wbs_rep, rows, _ = check_wbs(wbs_p, today, goals)   # re-run with the goal list
        reps += [wbs_rep, plan_rep]
    else:
        reps.append(wbs_rep)
    cov_p, ev_p = os.path.join(folder, 'coverage.csv'), os.path.join(folder, 'events.csv')
    if os.path.exists(cov_p):
        reps.append(check_coverage(cov_p, today))
    if os.path.exists(ev_p):
        reps.append(check_events(ev_p, {(r['year'], r['code']) for r in rows}))
    print(f'== {folder}')
    n_err = n_warn = 0
    for rep in reps:
        n_err, n_warn = n_err + len(rep.errors), n_warn + len(rep.warnings)
        status = 'OK' if not rep.errors and not rep.warnings else f'{len(rep.errors)} errors, {len(rep.warnings)} warnings'
        print(f'{rep.name:<13} {rep.summary} · {status}')
        for tag, items in (('E', rep.errors), ('W', rep.warnings)):
            for line in items[:args.max]:
                print(f'   {tag} {line}')
            if len(items) > args.max:
                print(f'   {tag} ... and {len(items) - args.max} more')
        if rep.name == 'wbs.csv':
            if args.atomize:
                print(f'   atomization candidates: {len(rep.notes)}')
                for line in rep.notes:
                    print(f'   A {line}')
            elif rep.notes:
                print(f'   note: {len(rep.notes)} atomization candidates (run with --atomize to list them)')
    verdict = 'OK' if not n_err and not (args.strict and n_warn) else 'FAILED'
    print(f'{verdict}: {n_err} errors, {n_warn} warnings')
    return n_err, n_warn


def main():
    ap = argparse.ArgumentParser(description='Validate a personal WBS ledger (schema v6).')
    ap.add_argument('path', help='folder holding wbs.csv (or a folder of such folders), or wbs.csv itself')
    ap.add_argument('--strict', action='store_true', help='fail on warnings too')
    ap.add_argument('--atomize', action='store_true', help='list rows for the range-row atomization pass')
    ap.add_argument('--max', type=int, default=20, help='issues to print per file (default 20)')
    ap.add_argument('--today', help='reference date YYYY-MM-DD (default: today)')
    args = ap.parse_args()
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    p = args.path
    if os.path.isfile(p):
        folders = [os.path.dirname(os.path.abspath(p))]
    elif os.path.exists(os.path.join(p, 'wbs.csv')):
        folders = [p]
    else:
        folders = sorted(os.path.join(p, d) for d in os.listdir(p)
                         if os.path.exists(os.path.join(p, d, 'wbs.csv')))
    if not folders:
        sys.exit(f'no wbs.csv found in {p}')
    total_err = total_warn = 0
    for f in folders:
        e, w = validate_folder(f, today, args)
        total_err, total_warn = total_err + e, total_warn + w
    sys.exit(1 if total_err or (args.strict and total_warn) else 0)


if __name__ == '__main__':
    main()
