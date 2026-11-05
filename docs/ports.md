# Using the skills outside Claude

The five skills in `skills/` are plain Agent Skills (`<name>/SKILL.md` with `name` and `description` frontmatter) and the scripts are Python 3 with the standard library, so other agents that read Agent Skills can use them. Only what the vendors' own documentation confirmed (checked 2026-11-06) is listed here.

| Agent | How to install | What carries over | Source |
|---|---|---|---|
| **Claude Code, Cowork, Claude app** | `/plugin marketplace add Jisung-Pacific/personal-wbs`, then `/plugin install personal-wbs@personal-wbs`; in the apps, **Customize → Plugins** | Everything | https://code.claude.com/docs/en/plugins-reference |
| **Gemini CLI** | `gemini extensions install https://github.com/Jisung-Pacific/personal-wbs` | The skills: an extension root holds `gemini-extension.json` (this repository has one), and `skills/<name>/SKILL.md` exposes a skill named `<name>` | https://geminicli.com/docs/extensions/reference |
| **OpenAI Codex** | Copy or symlink the skill folders into `$HOME/.agents/skills/` (user) or `.agents/skills/` in a repository; Codex follows symlinks. `$skill-installer` can also fetch skills from other repositories | The skills | https://learn.chatgpt.com/docs/build-skills |
| **Grok Build** | Copy the skill folders into `~/.grok/skills/` or `~/.agents/skills/`; Grok also states that it reads Claude Code plugins and marketplaces without configuration | The skills; plugin loading per Grok's own compatibility | https://docs.x.ai/build/features/skills-plugins-marketplaces |

## What does not carry over

- **Script paths.** The skills look for the scripts in `scripts/` next to `SKILL.md`, then in `${CLAUDE_PLUGIN_ROOT}/scripts`, then in a clone of this repository. Outside Claude, either keep a clone and say where it is, or package each skill with its scripts: `python3 scripts/package_skills.py` writes `dist/<skill>.zip` with the scripts inside the skill folder.
- **Connectors.** Each agent reads only the sources it can reach; the sweep marks the others `unavailable` in `coverage.csv`.
- **Scheduling, hooks and agents.** The `wbs-schedule` steps and the optional `personal-wbs-autolog` plugin (hooks and a subagent) are written for Claude's apps and Claude Code. On other agents, schedule the prompts from `skills/wbs-schedule/SKILL.md` with that agent's own scheduler or with cron.
- **The dashboard** is a plain HTML file and works with any agent that writes the CSV files.

Not verified, so not shipped: an OpenAI `agents/openai.yaml` per skill, Grok-specific manifests, and command-line install commands for Grok marketplaces.
