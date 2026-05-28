---
name: init
description: Generate or refresh an AGENTS.md / CLAUDE.md project-rules file from the actual repo. Triggers on "/init", "init project", "create CLAUDE.md", "AGENTS.md 만들어", "project rules 생성". Distills build/test/lint commands + conventions + structure into the rules file the agent loads every session.
userInvocable: true
allowedTools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"]
category: skill
stability: experimental
---

# Initialize project rules (AGENTS.md / CLAUDE.md)

You are producing the project-rules file the agent loads at the top of every
session (`repo-rules` reads `AGENTS.md` / `CLAUDE.md` / `.codex/CODEX-RULES.md`).
A good rules file makes every future session cheaper and more correct. This
skill DOES write a file — it is the one onboarding action that produces an
artifact.

## When this skill activates

- The user runs `/init` or says "init project" / "create CLAUDE.md" /
  "AGENTS.md 만들어" / "project rules 생성".
- A repo has no rules file and the user wants one bootstrapped.

## Procedure

1. **Check for an existing rules file.** If `AGENTS.md` or `CLAUDE.md` already
   exists, READ it first and *refresh* rather than overwrite — preserve any
   human-authored sections; only update the mechanical parts (commands,
   structure) that have drifted. Ask before clobbering hand-written content.

2. **Run the `onboard` reconnaissance** (or inline the same steps): layout,
   entry points, stack, test/build/lint commands. Derive commands from the
   manifest scripts + lockfile, never invent them.

3. **Verify the commands actually exist.** Before writing "run tests with
   `bun test`", confirm the script/binary is real (`package.json` scripts,
   `Justfile`, `Makefile`). A rules file with a wrong command is worse than none.

4. **Write a tight rules file.** Sections, in order:
   - **Project** — one line on what it is.
   - **Commands** — build / test / lint / typecheck, each a verified one-liner.
   - **Layout** — where source / tests / config live.
   - **Conventions** — the 3-6 non-obvious rules a contributor must follow
     (derived from observed patterns, not boilerplate).
   - **Do-not** — destructive or forbidden actions specific to this repo.

5. **Keep it short.** A rules file the agent re-reads every turn must earn its
   tokens. Prefer 40 tight lines over 200 generic ones. No filler, no
   "best practices" lecture — only repo-specific, verified facts.

## Output

- Write `AGENTS.md` (preferred — multi-vendor) at the repo root, OR refresh
  the existing rules file in place.
- Report the path written + a 3-bullet summary of what it captures.
- If you refreshed an existing file, show the diff of mechanical updates and
  confirm no human-authored section was lost.
