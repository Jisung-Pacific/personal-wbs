// The inbox through the service: validation, idempotent ids, listing newest first, marking, and per-account isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { Inbox, inboxId } from '../src/wbs/inbox.js';

test('inbox: add is idempotent, list is per account and newest first, mark moves items out of new', async () => {
  const store = new MemoryStore(), inbox = new Inbox(store);
  const a = { kind: 'chat', source: 'deepseek', at: '2026-11-06T10:00:00+09:00', title: '논문 표 정리', text: '…', url: 'https://chat.deepseek.com/a/chat/s/1' };
  const r1 = await inbox.add('u1', { items: [a] }), r2 = await inbox.add('u1', { items: [a, { ...a, title: '다른 대화', url: 'https://chat.deepseek.com/a/chat/s/2' }] });
  assert.deepEqual([r1.added, r1.existing, r2.added, r2.existing], [1, 0, 1, 1]);
  assert.equal(r1.ids[0], inboxId(a as never));
  assert.equal((await inbox.list('u2')).count, 0, 'another account sees nothing');
  const l = await inbox.list('u1'); assert.equal(l.count, 2);
  assert.equal((await inbox.mark('u1', { ids: [r1.ids[0]], status: 'merged', ref: '2026 4.3.42' })).marked, 1);
  assert.equal((await inbox.list('u1')).count, 1);
  assert.equal((await inbox.list('u1', { status: 'merged' })).items[0].ref, '2026 4.3.42');
});

test('inbox: rejects bad input', async () => {
  const inbox = new Inbox(new MemoryStore());
  await assert.rejects(inbox.add('u', { items: [{ kind: 'chat', source: 'Deep Seek', at: '2026-11-06' }] }));
  await assert.rejects(inbox.add('u', { items: [{ kind: 'tweet', source: 'x', at: '2026-11-06' }] }));
  await assert.rejects(inbox.add('u', { items: [{ kind: 'note', source: 'note', at: 'yesterday' }] }));
  await assert.rejects(inbox.add('u', { items: [{ kind: 'note', source: 'note', at: '2026-11-06', url: 'javascript:alert(1)' }] }));
  await assert.rejects(inbox.add('u', { items: [] }));
});
