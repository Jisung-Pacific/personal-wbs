#!/usr/bin/env python3
"""SessionEnd hook of personal-wbs-autolog: remember that a session ended.

Reads the hook's JSON input from stdin and appends one line to $CLAUDE_PLUGIN_DATA/queue.jsonl
holding only {session_id, time, cwd, transcript_path}. It never opens the transcript, never uses
the network, and always exits 0 quickly, so it cannot block or slow down the end of a session.
Python 3.8+, standard library only.
"""
import datetime
import json
import os
import sys

KEEP = ('session_id', 'cwd', 'transcript_path')   # the only input fields ever stored
MAX_INPUT = 1 << 16                               # hook input is small; read at most 64 KiB


def main():
    data_dir = os.environ.get('CLAUDE_PLUGIN_DATA')
    if not data_dir:
        return
    try:
        event = json.loads(sys.stdin.read(MAX_INPUT) or '{}')
    except ValueError:
        return
    if not isinstance(event, dict) or not event.get('session_id'):
        return
    entry = {k: str(event[k]) for k in KEEP if event.get(k)}
    entry['time'] = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    os.makedirs(data_dir, exist_ok=True)
    line = (json.dumps(entry, ensure_ascii=False) + '\n').encode('utf-8')
    # O_APPEND keeps concurrent writers from interleaving a single short line
    fd = os.open(os.path.join(data_dir, 'queue.jsonl'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:   # a logging aid must never disturb the session
        pass
    sys.exit(0)
