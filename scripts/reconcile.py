#!/usr/bin/env python3
"""Onboarding reconciliation: confirm the current status of open tasks with the user.

Imported records lag reality: work finished outside the sources still looks open.
This helper lists the open tasks in small batches for the user to confirm, and
writes the answers back into the ledger.

Usage:
  python3 reconcile.py list  <folder> [--batch 10] [--as-of YYYY-MM-DD] [--json]
  python3 reconcile.py apply <folder> <answers.json> [--today YYYY-MM-DD] [--source Claude] [--dry-run]

list   prints open leaf tasks (in progress, waiting, undated) grouped by package,
       undated and oldest first, in batches of up to --batch items, each with a hint
       when the ledger itself suggests an answer (a task that depends on it has
       started or finished, a later row in the package looks like its result, long
       silence).
apply  reads answers and updates wbs.csv and events.csv. answers.json is a list
       (or {"answers": [...]}) of objects:
         {"year": "2026", "code": "3.2.7", "status": "done", "end": "2026-10-20"}
         {"year": "2026", "code": "2.1.3", "status": "waiting", "blocker": "external reply: admissions office"}
         {"year": "2026", "code": "1.3.4", "status": "backlog", "blocker": "on hold: after the deadline"}
       status: done, in_progress, waiting (blocked), backlog (parked), in English or Korean.
       A done task without "end" gets today's date. Each change adds an events.csv row
       with the memo "onboarding reconciliation". A parent whose steps are now all done
       is closed too. The dashboard's status check mode can export answers in this form.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbs_schema as S  # noqa: E402

MEMO = {'en': 'onboarding reconciliation', 'ko': '온보딩 상태 확인'}
DEFAULT_CAT = {'waiting': 'external_reply', 'backlog': 'on_hold'}
TOKENS = re.compile(r'[가-힣]{2,}|[a-z][a-z0-9-]{3,}')


def last_activity(r):
    days = [d for d in (r['start'], r['end'], r['last_progress']) if S.is_day(d)]
    return max(days) if days else ''


def hints(rows):
    """Clues from the ledger itself; the agent adds evidence-based ones before asking."""
    out = {}
    by_key = {(r['year'], r['code']): r for r in rows}
    for r in rows:   # a task that depends on X has started or finished -> X is probably done
        for tok in S.split_list(r['depends_on']):
            dep = by_key.get(S.parse_dep(tok, r['year']))
            st = S.norm('status', r['status'])
            if dep and st in ('done', 'in_progress'):
                out.setdefault((dep['year'], dep['code']), []).append(
                    ('likely done', f"{r['year']} {r['code']} depends on it and is {st}"))
    for r in rows:   # a later row in the same package that shares its key words
        if S.norm('status', r['status']) == 'done':
            continue
        mine = set(TOKENS.findall(r['task'].lower()))
        for o in rows:
            if o is r or o['year'] != r['year'] or S.package_of(o['code']) != S.package_of(r['code']):
                continue
            if S.norm('status', o['status']) == 'done' and o['start'] > (r['start'] or '0') \
                    and len(mine & set(TOKENS.findall(o['task'].lower()))) >= 2:
                out.setdefault((r['year'], r['code']), []).append(
                    ('check', f"later row {o['code']} may record its result"))
    return out


def open_items(rows, as_of):
    has_steps = {(r['year'], S.parent_of(r['code'])) for r in rows if r['level'] == '4'}
    hint = hints(rows)
    items = []
    for r in rows:
        st = S.norm('status', r['status'])
        if (r['year'], r['code']) in has_steps or st not in ('in_progress', 'waiting'):
            continue
        last = last_activity(r)
        idle = (as_of - S.to_day(last)).days if last else None
        h = list(hint.get((r['year'], r['code']), []))
        if idle is not None and idle >= 60:
            h.append(('check', f'nothing recorded for {idle} days'))
        items.append({'year': r['year'], 'code': r['code'], 'package': r['package'], 'status': st,
                      'task': r['task'], 'start': r['start'], 'last_activity': last, 'idle_days': idle,
                      'due': r['due'], 'blocker': r['blocker'],
                      'hint': '; '.join(f'{a}: {b}' for a, b in h)})
    # packages ordered by their most urgent item; inside a package undated first, then oldest activity
    urg = lambda i: (0, '') if not i['last_activity'] else (1, i['last_activity'])
    groups = {}
    for i in items:
        groups.setdefault((i['year'], S.package_of(i['code'])), []).append(i)
    for g in groups.values():
        g.sort(key=urg)
    return [g for _, g in sorted(groups.items(), key=lambda kv: urg(kv[1][0]))]


def batches(groups, size):
    out, cur = [], []
    for g in groups:
        if len(g) > size:                       # a big package is split on its own
            if cur:
                out.append(cur)
                cur = []
            out += [g[i:i + size] for i in range(0, len(g), size)]
        elif len(cur) + len(g) > size:
            out.append(cur)
            cur = list(g)
        else:
            cur += g
    if cur:
        out.append(cur)
    return out


def cmd_list(args):
    t = S.read_table(os.path.join(args.folder, 'wbs.csv'), 'wbs')
    as_of = dt.date.fromisoformat(args.as_of) if args.as_of else dt.date.today()
    bs = batches(open_items(t.rows, as_of), args.batch)
    if args.json:
        print(json.dumps({'as_of': as_of.isoformat(), 'language': t.lang, 'batches': bs}, ensure_ascii=False, indent=1))
        return
    total = sum(len(b) for b in bs)
    print(f'{total} open tasks in {len(bs)} batches (as of {as_of})')
    for n, b in enumerate(bs, start=1):
        print(f'\n## Batch {n}')
        pkg = None
        for i in b:
            if i['package'] != pkg:
                pkg = i['package']
                print(f'{i["year"]} {pkg}')
            idle = f"{i['idle_days']}d idle" if i['idle_days'] is not None else 'no date'
            due = f", due {i['due']}" if i['due'] else ''
            print(f"  - {i['code']} [{i['status']}, {idle}{due}] {i['task']}")
            if i['blocker']:
                print(f"      blocker: {i['blocker']}")
            if i['hint']:
                print(f"      hint: {i['hint']}")


def cmd_apply(args):
    folder = args.folder
    t = S.read_table(os.path.join(folder, 'wbs.csv'), 'wbs')
    lang, rows = t.lang, t.rows
    today = args.today or dt.date.today().isoformat()
    with open(args.answers, encoding='utf-8') as f:
        data = json.load(f)
    answers = data['answers'] if isinstance(data, dict) else data
    idx = {(r['year'], r['code']): r for r in rows}
    ev_path = os.path.join(folder, 'events.csv')
    events = S.read_table(ev_path, 'events').rows if os.path.exists(ev_path) else []
    new_events, changed = [], 0

    def log(r, old, new):
        new_events.append({'date': today, 'year': r['year'], 'code': r['code'],
                           'event': S.label('event', 'status', lang), 'from_status': S.label('status', old, lang),
                           'to_status': S.label('status', new, lang), 'memo': MEMO[lang],
                           'source': args.source, 'estimated': ''})

    def close(r, end):
        r['end'] = end
        r['last_progress'] = max(r['last_progress'], end) if r['last_progress'] else end
        r['blocker'] = ''
        r['date_text'] = S.date_range_text(r['start'], end, lang) if r['start'] else r['date_text']

    for a in answers:
        key = (str(a.get('year', '')), str(a.get('code', '')))
        r = idx.get(key)
        new = S.norm('status', a.get('status', ''))
        if not r or not new:
            sys.exit(f'answer {a}: unknown row or status')
        old = S.norm('status', r['status'])
        blocker = ''
        if a.get('blocker'):
            cat, what = S.split_blocker(a['blocker'])
            if not cat:   # no known category: use the default for this status
                cat, what = DEFAULT_CAT.get(new, 'external_dependency'), a['blocker']
            blocker = f"{S.label('blocker', cat, lang)}: {what}"
        if new == old:    # confirmed as it is; only a new blocker text is taken
            if blocker and new in ('waiting', 'backlog'):
                r['blocker'] = blocker
            continue
        if new == 'done':
            end = a.get('end') or today
            if not S.is_day(end) or (r['start'] and end < r['start']):
                sys.exit(f'answer {a}: end date must be YYYY-MM-DD and not before the start {r["start"]}')
            close(r, end)
        else:
            r['blocker'] = blocker or (r['blocker'] if new in ('waiting', 'backlog') else '')
            r['end'] = ''
            if S.is_day(r['start']):
                r['date_text'] = S.date_range_text(r['start'], '', lang, open_ended=True)
        r['status'] = S.label('status', new, lang)
        log(r, old, new)
        changed += 1

    # close parents whose steps are now all done
    steps = {}
    for r in rows:
        if r['level'] == '4':
            steps.setdefault((r['year'], S.parent_of(r['code'])), []).append(r)
    closed = 0
    for key, kids in steps.items():
        par = idx.get(key)
        if par and S.norm('status', par['status']) != 'done' and all(S.norm('status', k['status']) == 'done' for k in kids):
            old = S.norm('status', par['status'])
            close(par, max(k['end'] for k in kids if k['end']) if any(k['end'] for k in kids) else today)
            par['status'] = S.label('status', 'done', lang)
            log(par, old, 'done')
            closed += 1

    print(f'{changed} tasks updated, {closed} parents closed, {len(new_events)} events')
    if args.dry_run:
        print('dry run: nothing written')
        return
    S.write_table(os.path.join(folder, 'wbs.csv'), 'wbs', rows, lang)
    S.write_table(ev_path, 'events', events + new_events, lang)
    print('next: python3 validate.py <folder> && python3 make_agent_files.py <folder>')


def main():
    ap = argparse.ArgumentParser(description='Confirm the status of open tasks with the user.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('list', help='list open tasks in batches')
    a.add_argument('folder')
    a.add_argument('--batch', type=int, default=10)
    a.add_argument('--as-of')
    a.add_argument('--json', action='store_true')
    b = sub.add_parser('apply', help='write confirmed statuses into the ledger')
    b.add_argument('folder')
    b.add_argument('answers')
    b.add_argument('--today')
    b.add_argument('--source', default='Claude', help='value for the events source column')
    b.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    cmd_list(args) if args.cmd == 'list' else cmd_apply(args)


if __name__ == '__main__':
    main()
