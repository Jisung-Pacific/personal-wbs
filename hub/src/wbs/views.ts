// The view log (execution WBS 3.5; the charter: "열람은 본인에게 보인다. 누가 언제 내 행과 카드를 봤는지 본인이 본다").
// When someone else reads team content that carries a person's shared rows (plan vs actual today; work-style cards with
// 4.2), the hub notes it in that person's own space: who read (the account, through which agent, in which role, or the
// team's own agent), in which space, how many of the person's rows one read carried, and when — first and last time each
// day and how often. Only the person reads it (and agents acting for them); a person's own reads are not noted, and
// nothing is written for someone who no longer belongs to the space. Days are kept 180 days.
import { z } from 'zod';
import type { Store, ViewEntry } from '../store/types.js';
import { todayKst } from './model.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller, type Relation } from './access.js';

export const VIEW_KEEP_DAYS = 180;
export const ViewsInput = z.object({
  days: z.number().int().min(1).max(VIEW_KEEP_DAYS).optional().describe('How many days back, today included (default 30)'),
  space: z.string().optional().describe('Only this team space'),
});
const ROLE_KO: Record<string, string> = { owner: '소유자', member: '멤버', guest: '게스트', delegate: '팀 에이전트' };
const WHAT_KO: Record<ViewEntry['what'], string> = { work: '계획 대비 실적에서 내 행', card: '내 카드' };
const dayBefore = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
const hhmm = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);   // KST, like every date in the ledger

export class Views {
  constructor(private store: Store) {}

  /** After a read of team content: note it for every person whose shared rows it carried (`owners`: uid → how many of
   *  their rows), except the reader, and only for people still in the space. A failure here never fails the read. */
  async saw(caller: Caller, relation: Relation, space: string, owners: Map<string, number>, what: ViewEntry['what']) {
    const me = callerUid(caller), now = Date.now(), date = todayKst(now), keep = now + VIEW_KEEP_DAYS * 864e5;
    for (const [uid, rows] of owners) {
      if (uid === me || !rows) continue;
      try {
        if (!await this.store.membership(space, uid)) continue;   // left the space: nothing is written to an account outside it
        await this.store.logViews(uid, date, [{ viewer: me ?? '', kind: caller.kind, client: caller.kind === 'person' ? '' : caller.client,
          role: relation, space, what, rows, count: 1, first: now, last: now }], keep);
      } catch (e) { console.error('view not noted', e); }
    }
  }

  /** The caller's own view log, newest first, with a line per entry to read out. Space names are given for the spaces
   *  the person still belongs to. */
  async mine(caller: Caller, raw: z.input<typeof ViewsInput> = {}) {
    const input = ViewsInput.parse(raw), uid = callerUid(caller);
    if (!uid) throw new LedgerError('forbidden', 'A team agent has no view log of its own');
    const days = input.days ?? 30, today = todayKst(), since = dayBefore(today, days - 1);
    const log = (await this.store.views(uid, since))
      .map(d => ({ date: d.date, entries: d.entries.filter(e => !input.space || e.space === input.space).sort((a, b) => b.last - a.last) }))
      .filter(d => d.entries.length).sort((a, b) => b.date.localeCompare(a.date));
    const names = new Map<string, string>();
    for (const id of new Set(log.flatMap(d => d.entries.map(e => e.space)))) {
      const [s, m] = await Promise.all([this.store.space(id), this.store.membership(id, uid)]);
      names.set(id, s && m ? s.name : '(떠난 공간)');
    }
    const who = (e: ViewEntry) => e.kind === 'team_agent' ? `팀 에이전트 ${e.client}` : `${e.viewer}(${ROLE_KO[e.role] ?? e.role})${e.kind === 'agent' ? ` · ${e.client} 경유` : ''}`;
    const lines = log.flatMap(d => d.entries.map(e =>
      `${d.date} ${hhmm(e.first)}${e.last !== e.first ? `–${hhmm(e.last)}` : ''} ${who(e)} · ${names.get(e.space)} · ${WHAT_KO[e.what]} ${e.rows}개 · ${e.count}회`));
    const entries = log.flatMap(d => d.entries);
    return {
      since, until: today, days,
      totals: { reads: entries.reduce((n, e) => n + e.count, 0), readers: new Set(entries.map(e => `${e.kind}|${e.viewer}|${e.client}`)).size },
      log: log.map(d => ({ date: d.date, entries: d.entries.map(e => ({ ...e, space_name: names.get(e.space) })) })), lines,
    };
  }
}
