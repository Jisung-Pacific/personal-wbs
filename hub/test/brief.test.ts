// The brief counts leaves only, flags overdue / soon-due / stale / waiting work, measures pace over the window, and
// stays small enough for a planner to read first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief } from '../src/wbs/brief.js';
import { emptyRow } from '../src/wbs/model.js';
import type { Row } from '../src/store/types.js';

const row = (o: Partial<Row>): Row => ({ ...emptyRow(), year: '2026', level: '3', area: '4 창업·제품', package: '4.3 서비스 개발', ...o });

test('brief: leaves, flow, due and stale work, work style, signals', () => {
  const rows: Row[] = [
    row({ code: '4.3.1', task: '부모 작업', start: '2026-09-01', status: '진행 중' }),
    row({ code: '4.3.1.1', level: '4', parent: '4.3.1 부모 작업', task: '단계 하나', start: '2026-10-02', end: '2026-10-02', status: '완료' }),
    row({ code: '4.3.1.2', level: '4', parent: '4.3.1 부모 작업', task: '단계 둘', start: '2026-10-05', end: '2026-10-09', status: '완료' }),
    row({ code: '4.3.2', task: '마감 지난 일', start: '2026-10-10', due: '2026-11-01', status: '진행 중', last_progress: '2026-10-20' }),
    row({ code: '4.3.3', task: '곧 마감', start: '2026-11-02', due: '2026-11-10', status: '진행 중' }),
    row({ code: '4.3.4', task: '오래 멈춤', start: '2026-08-01', status: '진행 중' }),
    row({ code: '4.3.5', task: '심사 대기', start: '2026-10-15', status: '대기·심사', blocker: '외부 심사·승인: 학회' }),
    row({ code: '4.3.6', task: '보류', start: '2026-07-01', status: '백로그' }),
    row({ code: '4.3.7', task: '핵심', start: '2026-11-03', end: '2026-11-03', status: '완료', key_result: 'Y' }),
  ];
  const b = buildBrief(rows, { today: '2026-11-06' });
  assert.equal(b.kpis.tasks, 8, 'the parent with steps is not counted');
  assert.equal(b.kpis.done, 3);
  assert.equal(b.kpis.key_results, 1);
  assert.equal(b.kpis.done_rate_pct, 43);   // 3 of 7 (backlog left out)
  assert.deepEqual(b.month_flow.at(-1), { month: '2026-11', started: 2, finished: 1 });
  assert.deepEqual(b.overdue.map(x => x.ref), ['2026:4.3.2']);
  assert.deepEqual(b.due_soon.map(x => x.ref), ['2026:4.3.3']);
  assert.deepEqual(b.stale_open.map(x => x.ref), ['2026:4.3.4']);
  assert.deepEqual(b.waiting.by_blocker, { '외부 심사·승인': 1 });
  assert.equal(b.work_style.median_days_to_finish, 0);    // spans 0, 4, 0
  assert.equal(b.work_style.same_day_finish_pct, 67);
  assert.equal(b.work_style.in_progress_now, 3);
  assert.ok(b.signals.some(s => s.includes('마감 지난 일 1개')) && b.signals.some(s => s.includes('30일 넘게')));
  assert.equal(b.open_now[0].ref, '2026:4.3.3', 'most recently moved first');
});

test('brief stays small on a large ledger', () => {
  const rows: Row[] = [];
  for (let i = 1; i <= 2000; i++) rows.push(row({ code: `4.3.${i}`, task: '긴 작업 설명 '.repeat(30), start: '2026-10-01', status: i % 3 ? '완료' : '진행 중', end: i % 3 ? '2026-10-02' : '' }));
  const size = Buffer.byteLength(JSON.stringify(buildBrief(rows, { today: '2026-11-06' })));
  assert.ok(size < 8000, `brief is ${size} bytes`);
});
