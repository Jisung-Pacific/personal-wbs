// The ledger's shape: column order and Korean headers of wbs.csv / events.csv, CSV reading and writing that matches
// Python's csv module (QUOTE_MINIMAL, CRLF) byte for byte, and the small helpers every write path shares.
import type { LedgerEvent, Row } from '../store/types.js';

/** wbs.csv v6: [key in the API, Korean header in the file], in file order. */
export const ROW_COLUMNS: [keyof Row, string][] = [
  ['year', '연도'], ['code', 'WBS'], ['level', '레벨'], ['area', '대분류'], ['package', '중분류'], ['parent', '상위 작업'],
  ['task', '작업·산출물'], ['start', '시작일'], ['end', '종료일'], ['date_text', '일자(원문)'], ['start_month', '시작월'],
  ['status', '상태'], ['key_result', '핵심성과'], ['source', '출처'], ['due', '마감일'], ['importance', '중요도'], ['size', '크기'],
  ['depends_on', '선행'], ['blocker', '막힘 사유'], ['last_progress', '최근 진행일'], ['goal', '목표'], ['evidence', '근거'],
];
export const EVENT_COLUMNS: [keyof LedgerEvent, string][] = [
  ['date', '일자'], ['year', '연도'], ['code', 'WBS'], ['event', '이벤트'], ['from', '이전 상태'], ['to', '새 상태'],
  ['memo', '메모'], ['source', '출처'], ['estimated', '추정'],
];

export const STATUSES = ['완료', '진행 중', '대기·심사', '백로그'] as const;
export const EVENTS = ['생성', '상태', '보강', '정정', '이동'] as const;
export const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

export const emptyRow = (): Row => Object.fromEntries(ROW_COLUMNS.map(([k]) => [k, ''])) as unknown as Row;

// ---------------------------------------------------------------- CSV
/** Parses RFC 4180 CSV (quoted fields may hold commas, quotes and line breaks). A leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, ''), out: string[][] = [];
  let row: string[] = [], field = '', i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = ''; out.push(row); row = [];
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}

/** Python csv.writer defaults: quote only when needed, double inner quotes, CRLF line ends. */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function rowsFromCsv(text: string): Row[] {
  const [head, ...body] = parseCsv(text);
  const idx = ROW_COLUMNS.map(([, h]) => head.indexOf(h));
  if (idx.some(i => i < 0)) throw new Error('wbs.csv: missing columns ' + ROW_COLUMNS.filter((_, j) => idx[j] < 0).map(([, h]) => h).join(', '));
  return body.filter(r => r.some(Boolean)).map(r => Object.fromEntries(ROW_COLUMNS.map(([k], j) => [k, r[idx[j]] ?? ''])) as unknown as Row);
}
export function eventsFromCsv(text: string): LedgerEvent[] {
  const [head, ...body] = parseCsv(text);
  const idx = EVENT_COLUMNS.map(([, h]) => head.indexOf(h));
  if (idx.some(i => i < 0)) throw new Error('events.csv: missing columns');
  return body.filter(r => r.some(Boolean)).map(r => Object.fromEntries(EVENT_COLUMNS.map(([k], j) => [k, r[idx[j]] ?? ''])) as unknown as LedgerEvent);
}

/** Codes compare numerically per segment (1.10 after 1.9). */
export const codeKey = (c: string) => c.split('.').map(n => n.padStart(4, '0')).join('.');
/** File order: newest year first, then code. */
export const sortRows = (rows: Row[]) => [...rows].sort((a, b) => b.year.localeCompare(a.year) || codeKey(a.code).localeCompare(codeKey(b.code)));

export function rowsToCsv(rows: Row[], bom = true): string {
  return (bom ? '﻿' : '') + toCsv([ROW_COLUMNS.map(([, h]) => h), ...sortRows(rows).map(r => ROW_COLUMNS.map(([k]) => r[k] ?? ''))]);
}
export function eventsToCsv(evs: LedgerEvent[], bom = true): string {
  return (bom ? '﻿' : '') + toCsv([EVENT_COLUMNS.map(([, h]) => h), ...evs.map(e => EVENT_COLUMNS.map(([k]) => e[k] ?? ''))]);
}

// ---------------------------------------------------------------- helpers shared by the write paths
/** The human date column: "2026-06-22 ~ 07-12" within a year, the full end date across years. */
export function dateText(start: string, end: string): string {
  if (!start) return end ? `~ ${end}` : '미기록';
  if (!end || end === start) return start;
  return start.slice(0, 4) === end.slice(0, 4) ? `${start} ~ ${end.slice(5)}` : `${start} ~ ${end}`;
}

/** Words that identify a task: Hangul runs of 2+ and latin tokens. Used to catch the same work logged twice. */
export function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[가-힣]{2,}|[a-z][a-z0-9.+-]+/g) || []));
}
export function overlap(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b); if (!ta.size) return 0;
  let n = 0; ta.forEach(t => { if (tb.has(t)) n++; });
  return n;
}

/** Joins source labels: Claude + GPT → "Claude·GPT", never repeating one. */
export function mergeSource(cur: string, add: string): string {
  const parts = cur ? cur.split('·') : [];
  if (!parts.includes(add)) parts.push(add);
  return parts.join('·');
}
/** Adds an evidence pointer once; the existing text is kept exactly as it is. */
export function appendEvidence(cur: string, add: string): string {
  if (!add) return cur;
  if (cur.split(';').map(s => s.trim()).includes(add)) return cur;
  return cur ? `${cur};${add}` : add;
}

/** Today in Korea, where the ledger's dates are kept. */
export const todayKst = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);

/** Source label for the agent behind an OAuth client, as the 출처 column spells it. */
export function agentLabel(clientName: string): string {
  const n = clientName.toLowerCase();
  if (/claude|anthropic/.test(n)) return 'Claude';
  if (/chatgpt|openai|\bgpt/.test(n)) return 'GPT';
  if (/gemini|google/.test(n)) return 'Gemini';
  if (/grok|xai/.test(n)) return 'Grok';
  if (/deepseek/.test(n)) return 'DeepSeek';
  if (/kimi|moonshot/.test(n)) return 'Kimi';
  if (/codex/.test(n)) return 'Codex';
  return clientName.replace(/[·;,]/g, ' ').trim().slice(0, 24) || 'Agent';
}
