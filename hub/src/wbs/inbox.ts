// The inbox: raw material from places where no agent can write the ledger itself — chats on AI sites without tools
// (captured by the browser extension or pasted), searches, notes, imported exports — kept sealed for the account until an
// agent turns what is work into ledger rows (wbs_add) and marks each item merged or skipped.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InboxItem, Store } from '../store/types.js';

const KINDS = ['chat', 'search', 'note', 'file', 'event', 'record'] as const;
export const InboxIn = z.object({
  kind: z.enum(KINDS),
  source: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,39}$/, 'lowercase name, e.g. deepseek, google-search'),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/, 'YYYY-MM-DD or an ISO date-time'),
  title: z.string().max(300).default(''),
  text: z.string().max(20_000).default(''),
  url: z.string().max(2_000).refine(u => !u || /^https?:\/\//.test(u), 'http(s) URL or empty').default(''),
});
export const InboxAddInput = z.object({ items: z.array(InboxIn).min(1).max(100) });
export const InboxListInput = z.object({ status: z.enum(['new', 'merged', 'skipped']).default('new'), limit: z.number().int().min(1).max(200).default(50) });
export const InboxMarkInput = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{32}$/)).min(1).max(200), status: z.enum(['merged', 'skipped']), ref: z.string().max(200).default('') });

export const inboxId = (i: Pick<InboxItem, 'source' | 'url' | 'at' | 'title'>) => createHash('sha256').update([i.source, i.url, i.at, i.title].join('\u0000')).digest('hex').slice(0, 32);

export class Inbox {
  constructor(private store: Store) {}
  async add(uid: string, input: unknown) {
    const { items } = InboxAddInput.parse(input), now = Date.now();
    const rows: InboxItem[] = items.map(i => ({ ...i, id: inboxId(i), status: 'new', added: now, ref: '' }));
    const r = await this.store.putInbox(uid, rows);
    return { ...r, ids: rows.map(i => i.id) };
  }
  async list(uid: string, input: unknown = {}) {
    const f = InboxListInput.parse(input ?? {});
    const items = await this.store.inbox(uid, f);
    return { status: f.status, count: items.length, items };
  }
  async mark(uid: string, input: unknown) {
    const m = InboxMarkInput.parse(input);
    return { marked: await this.store.markInbox(uid, m.ids, m.status, m.ref) };
  }
}
