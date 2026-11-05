"""Shared definitions for the personal WBS ledger, schema v6.

Every file can be kept in English or Korean. Readers accept either header set
and either set of values and map them to one internal form: English column keys
and English value codes. Writers translate back into the file's language.

Python 3.8+, standard library only. Imported by validate.py,
make_agent_files.py and sample_data.py (keep it in the same folder).
"""
import calendar
import csv
import datetime as dt
import io
import re

SCHEMA_VERSION = 6

# ------------------------------------------------------------------ columns
# (internal key = English header, Korean header), in file order.
WBS_COLUMNS = [
    ('year', '연도'), ('code', 'WBS'), ('level', '레벨'), ('area', '대분류'),
    ('package', '중분류'), ('parent', '상위 작업'), ('task', '작업·산출물'),
    ('start', '시작일'), ('end', '종료일'), ('date_text', '일자(원문)'),
    ('start_month', '시작월'), ('status', '상태'), ('key_result', '핵심성과'),
    ('source', '출처'), ('due', '마감일'), ('importance', '중요도'), ('size', '크기'),
    ('depends_on', '선행'), ('blocker', '막힘 사유'), ('last_progress', '최근 진행일'),
    ('goal', '목표'), ('evidence', '근거'),
]
COVERAGE_COLUMNS = [
    ('year', '연도'), ('month', '월'), ('source', '소스'), ('state', '상태'),
    ('passes', '패스 수'), ('new_last_pass', '최근 신규'), ('last_checked', '마지막 확인'),
    ('memo', '메모'),
]
PLAN_COLUMNS = [
    ('kind', '종류'), ('year', '연도'), ('target', '대상'), ('note', '내용'),
    ('decided', '결정일'), ('recheck', '재검일'),
]
EVENT_COLUMNS = [
    ('date', '일자'), ('year', '연도'), ('code', 'WBS'), ('event', '이벤트'),
    ('from_status', '이전 상태'), ('to_status', '새 상태'), ('memo', '메모'),
    ('source', '출처'), ('estimated', '추정'),
]
TABLES = {'wbs': WBS_COLUMNS, 'coverage': COVERAGE_COLUMNS,
          'plan': PLAN_COLUMNS, 'events': EVENT_COLUMNS}
FILES = {'wbs': 'wbs.csv', 'coverage': 'coverage.csv', 'plan': 'plan.csv', 'events': 'events.csv'}

# ------------------------------------------------------------------ values
# internal code -> (English label, Korean label)
VOCAB = {
    'status': {
        'done': ('done', '완료'),
        'in_progress': ('in_progress', '진행 중'),
        'waiting': ('waiting', '대기·심사'),       # waiting on someone else
        'backlog': ('backlog', '백로그'),          # deliberately parked
    },
    'importance': {'high': ('high', '상'), 'medium': ('medium', '중'), 'low': ('low', '하')},
    'blocker': {  # category before the ':' in the blocker column
        'external_review': ('external review', '외부 심사·승인'),
        'external_reply': ('external reply', '외부 응답'),
        'external_dependency': ('external dependency', '외부 의존·차단'),
        'prerequisite': ('prerequisite', '선행 조건'),
        'scheduled_later': ('scheduled later', '일정·연기'),
        'on_hold': ('on hold', '보류'),
        'result_unconfirmed': ('result unconfirmed', '결과 미확인'),
    },
    'event': {
        'create': ('create', '생성'), 'status': ('status', '상태'), 'enrich': ('enrich', '보강'),
        'correct': ('correct', '정정'), 'move': ('move', '이동'),
    },
    'coverage_state': {
        'not_started': ('not_started', '미착수'), 'partial': ('partial', '부분'),
        'complete': ('complete', '완료'), 'unavailable': ('unavailable', '불가'),
    },
    'plan_kind': {
        'goal': ('goal', '목표'), 'focus': ('focus', '집중'),
        'checkup': ('checkup', '검진'), 'config': ('config', '설정'),
    },
}
SIZES = ('S', 'M', 'L', 'XL')            # S <= 1 day, M <= 1 week, L <= 1 month, XL > 1 month
DATE_WORDS = {'planned': ('planned', '예정'), 'not_recorded': ('not recorded', '미기록')}
CONTINUED = {'en': '(continued)', 'ko': '(계속)'}


def norm(kind, value):
    """Map a value in either language (or an internal code) to its code.
    Returns '' for blank and None for an unknown value."""
    v = (value or '').strip()
    if not v:
        return ''
    low = v.lower()
    for code, (en, ko) in VOCAB[kind].items():
        if v == ko or low == code or low == en.lower():
            return code
    return None


def value_lang(kind, value):
    """'ko' or 'en' when the value is a label of that language, else None."""
    v = (value or '').strip()
    for code, (en, ko) in VOCAB[kind].items():
        if v == ko:
            return 'ko'
        if v.lower() in (code, en.lower()):
            return 'en'
    return None


def label(kind, code, lang):
    """Display label of an internal code in the given language ('' for blank)."""
    if not code:
        return ''
    en, ko = VOCAB[kind][code]
    return ko if lang == 'ko' else en


def labels(kind, lang):
    return {code: label(kind, code, lang) for code in VOCAB[kind]}


# ------------------------------------------------------------------ dates
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
MONTH_RE = re.compile(r'^\d{4}-\d{2}$')


def is_day(s):
    return bool(s) and bool(DAY_RE.match(s)) and to_day(s) is not None


def to_day(s):
    """date for a valid YYYY-MM-DD string, else None."""
    try:
        return dt.date.fromisoformat(s) if s and DAY_RE.match(s) else None
    except ValueError:
        return None


def valid_date(s):
    """True for '' or a valid YYYY-MM-DD / YYYY-MM."""
    if not s:
        return True
    if DAY_RE.match(s):
        return to_day(s) is not None
    if MONTH_RE.match(s):
        return 1 <= int(s[5:7]) <= 12
    return False


def month_first(s):
    return dt.date(int(s[:4]), int(s[5:7]), 1)


def month_last(s):
    y, m = int(s[:4]), int(s[5:7])
    return dt.date(y, m, calendar.monthrange(y, m)[1])


def date_range_text(start, end, lang, open_ended=False):
    """Human form for the date_text column: '2026-06-22 ~ 07-12', '2025-12-28 ~ 2026-01-03'."""
    if not start:
        return DATE_WORDS['planned'][1 if lang == 'ko' else 0]
    if open_ended:
        return f'{start} ~'
    if not end or end == start:
        return start
    if start[:4] == end[:4]:
        return f'{start} ~ {end[5:]}'
    return f'{start} ~ {end}'


# ------------------------------------------------------------------ codes
CODE_RE = re.compile(r'^\d+(?:\.\d+){2,3}$')     # area.package.task(.step)


def code_key(code):
    try:
        return tuple(int(x) for x in code.split('.'))
    except ValueError:
        return (10 ** 9,)


def ledger_sort_key(rec):
    """Newest year first, then code numerically per segment."""
    y = rec.get('year', '')
    return (-int(y) if y.isdigit() else 0, code_key(rec.get('code', '')))


def parent_of(code):
    return code.rsplit('.', 1)[0]


def package_of(code):
    return '.'.join(code.split('.')[:2])


def lead_token(text):
    """First token of '<code> <name>' fields (area, package, parent)."""
    return (text or '').strip().split(' ', 1)[0]


def split_list(text):
    """';'-separated list (depends_on, evidence)."""
    return [t.strip() for t in (text or '').split(';') if t.strip()]


def parse_dep(token, year):
    """'1.2.3' -> (year, '1.2.3'); '2025:1.2.3' -> ('2025', '1.2.3')."""
    if ':' in token:
        y, c = token.split(':', 1)
        return y.strip(), c.strip()
    return year, token.strip()


def split_blocker(text):
    """'<category>: <what>' -> (category code or None, what). Blank -> ('', '')."""
    t = (text or '').strip()
    if not t:
        return '', ''
    m = re.match(r'^([^:：]+?)\s*[:：]\s*(.*)$', t)
    if not m:
        return None, t
    return norm('blocker', m.group(1)), m.group(2).strip()


def leaf_rows(rows):
    """Rows without level-4 children. Counts and indicators use these."""
    parents = {(r['year'], parent_of(r['code'])) for r in rows if r.get('level') == '4'}
    return [r for r in rows if (r['year'], r['code']) not in parents]


# ------------------------------------------------------------------ CSV I/O
class Table:
    """A CSV read in either language. rows: dicts keyed by internal names,
    plus '_row' (1-based data row number) and '_cells' (cell count)."""

    def __init__(self, kind, lang, has_bom, header, rows, issues):
        self.kind, self.lang, self.has_bom = kind, lang, has_bom
        self.header, self.rows, self.issues = header, rows, issues


def read_table(path, kind):
    columns = TABLES[kind]
    with open(path, 'rb') as f:
        raw = f.read()
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    text = raw.decode('utf-8-sig')
    lines = [r for r in csv.reader(io.StringIO(text))]
    issues = []
    if not lines:
        return Table(kind, 'en', has_bom, [], [], ['empty file'])
    header = [h.strip() for h in lines[0]]
    keys, n_en, n_ko = [], 0, 0
    for h in header:
        key = None
        for en, ko in columns:
            if h == ko:
                key, n_ko = en, n_ko + 1
                break
            if h.lower() == en:
                key, n_en = en, n_en + 1
                break
        if key is None:
            issues.append(f'unknown column "{h}"')
        keys.append(key)
    lang = 'ko' if n_ko > n_en else 'en'
    if n_en and n_ko:
        issues.append('header mixes English and Korean names')
    expected = [en for en, _ in columns]
    missing = [k for k in expected if k not in keys]
    if missing:
        issues.append('missing columns: ' + ', '.join(missing))
    elif [k for k in keys if k] != expected or len(keys) != len(expected):
        issues.append('columns are not in schema order: '
                      + ', '.join(ko if lang == 'ko' else en for en, ko in columns))
    rows = []
    for i, cells in enumerate(lines[1:], start=1):
        if not any(c.strip() for c in cells):
            continue
        rec = {k: '' for k in expected}
        for k, c in zip(keys, cells):
            if k:
                rec[k] = c.strip()
        rec['_row'], rec['_cells'] = i, len(cells)
        rows.append(rec)
    return Table(kind, lang, has_bom, header, rows, issues)


def write_table(path, kind, rows, lang):
    """Write rows (dicts keyed by internal names) with the header in `lang`, UTF-8 with BOM."""
    columns = TABLES[kind]
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow([ko if lang == 'ko' else en for en, ko in columns])
        for r in rows:
            w.writerow([r.get(en, '') for en, _ in columns])
