# Privacy policy: Personal WBS (personal-wbs)

Effective 2026-11-06. This policy covers everything in this repository: the Agent Skills, the scripts, the dashboard and the optional autolog plugin.

## Summary

Personal WBS runs entirely inside your own Claude environment and your own files. The author operates no server, receives none of your data and keeps none of it.

## What the plugin reads

- Your past Claude chats (through chat search), Claude Code session transcripts on your machine, and exports you upload yourself (ChatGPT, Claude).
- The apps you have connected to Claude: Google Drive, Gmail, Google Calendar, Slack, Notion and GitHub.

Reading is read-only. The skills never send, edit, share or delete anything in a connected app.

## Why it reads them

To find the work you did and record it as dated rows in your ledger, each with a pointer to its evidence (for example a chat id, a pull request number or a file title).

## What it writes, and where

The ledger files (`wbs.csv` and its companions) go only to the location you choose: a claude.ai artifact, a local folder, or your own private Git repository.

## What it sends

Nothing is sent to the author or to any other service: there is no server, no telemetry and no analytics. The only write that leaves Claude is a commit to your own Git repository, made only when you chose that location and asked for it. The bundled scripts use the Python standard library only and make no network calls.

## Optional autolog plugin

`personal-wbs-autolog` is a separate plugin in this repository for Claude Code; it is not part of the core plugin and is installed only if you choose it. When a Claude Code session ends, its hook writes four fields (session ID, time, working folder and transcript path) to `queue.jsonl` in the plugin's own data folder on your computer. It never reads the conversation and never uses the network. The transcripts are read later, in a session on the same computer, only when you approve the `wbs-autolog-drain` skill, and only to log your work with the rules below. Uninstalling the plugin deletes its data folder.

## Personal data

Personal data such as names, e-mail addresses and phone numbers is read through your connectors only while looking for your work, and is not stored. Rows describe the work and name organisations and roles instead of people. `validate.py` warns when an e-mail address, handle, phone number or account-like number appears in the ledger. By default the skills also skip health matters, relationships, financial account numbers and personal income amounts. You can change these defaults.

## Retention and deletion

All data stays in your own files. Delete those files, or the artifact, to remove it. The author retains nothing.

## Third parties

When Claude reads your connected apps on your behalf, those providers (for example Google, Slack, Notion or GitHub) and Anthropic process the data under their own terms.

## Children

The plugin is not directed to people under 18.

## Changes and contact

Changes to this policy are made in this file, with the date above, and are visible in the Git history. For questions, open an issue at https://github.com/Jisung-Pacific/personal-wbs/issues.
