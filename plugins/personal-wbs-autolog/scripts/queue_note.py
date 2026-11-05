#!/usr/bin/env python3
"""SessionStart hook (startup) of personal-wbs-autolog: one factual line when sessions are queued.

If $CLAUDE_PLUGIN_DATA/queue.jsonl holds sessions that have not been logged yet, prints one line
of plain text, which Claude Code adds to the new session's context. Prints at most once per
calendar day (the date is kept in note_state.json next to the queue) and nothing otherwise.
Never reads transcripts, never uses the network, always exits 0. Standard library only.
"""
import datetime
import json
import os
import sys


def main():
    data_dir = os.environ.get('CLAUDE_PLUGIN_DATA')
    if not data_dir:
        return
    queue = os.path.join(data_dir, 'queue.jsonl')
    if not os.path.isfile(queue):
        return
    ids, oldest = set(), ''
    with open(queue, encoding='utf-8') as f:
        for raw in f:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if isinstance(e, dict) and e.get('session_id'):
                ids.add(e['session_id'])
                t = str(e.get('time', ''))[:10]
                oldest = min(oldest, t) if oldest else t
    if not ids:
        return
    today = datetime.date.today().isoformat()
    state_path = os.path.join(data_dir, 'note_state.json')
    try:
        with open(state_path, encoding='utf-8') as f:
            if json.load(f).get('day') == today:
                return
    except (OSError, ValueError, AttributeError):
        pass
    with open(state_path, 'w', encoding='utf-8') as f:
        json.dump({'day': today}, f)
    n = len(ids)
    print(f'personal-wbs-autolog: {n} ended Claude Code session{"s" if n > 1 else ""} since {oldest or "earlier"} '
          f'{"are" if n > 1 else "is"} queued for the WBS ledger. The wbs-autolog-drain skill logs them when the user agrees.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
