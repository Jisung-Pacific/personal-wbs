# PP WBS browser extension

A collection channel for the places where no agent can write the ledger itself: AI chat sites without tools or
connectors (DeepSeek, Grok, Meta AI, Kimi, Perplexity, Qwen, …) and, only when you switch it on, your Google searches.
Everything goes to **your own account on your PP WBS Hub** and nowhere else.

| What | When | Where it goes |
|---|---|---|
| The conversation on the open tab (text, title, address without query) | only when you click **Send this chat**, use the context menu, or press Alt+Shift+W | the hub inbox; an agent later turns what is work into ledger rows |
| `PP-WBS-RECORD {…}` lines in that conversation | same click | ledger rows directly (a near-duplicate is refused; a record the hub cannot place goes to the inbox) |
| Google search queries | only after you switch it on in the options (asks for google.com then) | the hub inbox, batched every 15 minutes; query and time only |

The extension asks for no site access at install time: a click grants access to that one tab (`activeTab`); the hub
address and google.com are asked for when you use them. Sign-in is OAuth 2.1 against your hub (dynamic registration,
authorization code with PKCE); tokens stay in this browser profile. The hub stores what it receives sealed with your
account's own key and deletes processed inbox items after 30 days.

## Assistants without tools: the instruction

Paste the instruction from the options page into the assistant's custom instructions. When you finish something
concrete, it ends its answer with one line per result:

```
PP-WBS-RECORD {"package":"4.3 Service development","task":"Release 1.2 of the iOS app with offline sync","start":"2026-11-06","status":"완료"}
```

Send the chat and the line becomes a ledger row.

## Develop

Load the folder as an unpacked extension (chrome://extensions → Developer mode → Load unpacked), open the options,
enter your hub address (`https://…`, or `http://localhost:8787` for a local hub started with `HUB_DEV_LOGIN=1`) and
sign in. A store build fixes the hub address and its host permission: `python3 scripts/build_extension.py
--hub https://your-hub.example --out dist/extension` (add `--icon your-icon.svg` to brand it).
