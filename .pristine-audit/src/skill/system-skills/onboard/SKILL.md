---
name: onboard
description: Cold-start understanding of an unfamiliar repo. Triggers on "onboard", "낯선 레포", "repo 파악", "where do I start", "explain this codebase", "구조 파악". Builds a repomap from file_tree_summary + repo-rules (AGENTS.md/CLAUDE.md) + entry points, WITHOUT editing anything.
userInvocable: true
allowedTools: ["Read", "Grep", "Glob", "Bash"]
category: skill
stability: experimental
---

# Cold-start repo onboarding

You are forming a working mental model of a repository you have not seen
before. The goal is a **repomap** the rest of the session can rely on —
structure, conventions, entry points, and the project's own rules. You do
**not** edit anything in this skill; it is read-only reconnaissance.

## When this skill activates

Any one trigger is enough:

- The user says "onboard" / "낯선 레포" / "repo 파악" / "구조 파악".
- The user asks "where do I start" / "explain this codebase" / "what is this".
- You are entering a repo with no prior context this session and the task
  spans more than a single known file.

## Procedure (do these in order, stop early if the answer is obvious)

1. **Read the project's own rules first.** Look for `AGENTS.md`, `CLAUDE.md`,
   `.cursor/rules/`, `.quanta/rules/`, `README.md` at the repo root and in the
   working subtree. These are authoritative — they tell you conventions the
   repo expects. Quote the load-bearing ones back.

2. **Get the shape, not every file.** Use `file_tree_summary` (if available)
   or `git ls-files | head` + a depth-limited tree. Identify: top-level
   layout, where source lives, where tests live, the build/package manifest
   (`package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod`).

3. **Find the entry points.** The `main` / `bin` / `scripts.start` in the
   manifest; the largest or most-imported modules; the CLI/server bootstrap.
   Name 2-4 files a newcomer would read first.

4. **Detect the stack + tooling.** Language(s), framework, test runner, lint
   formatter, package manager — infer from manifests + lockfiles, not guesses.

5. **Surface the invariants + gotchas.** Anything the rules file flags, any
   `CONTRIBUTING`/`ARCHITECTURE` doc, any obvious "do not touch" markers.

## Output

A tight repomap (not a wall of text):

- **Purpose** — one line on what the repo does.
- **Layout** — 3-6 bullets: src / tests / build / config locations.
- **Entry points** — 2-4 `path:line` references a newcomer reads first.
- **Stack** — language / framework / test / lint / package-manager.
- **Rules that bind** — the load-bearing lines from AGENTS.md/CLAUDE.md.
- **Open question** — the single thing you would confirm with the user
  before making changes.

Keep it scannable. The point is to make the *next* task cheap, not to
exhaustively document the repo. Read-only — never edit during onboarding.
