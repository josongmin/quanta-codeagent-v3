# ADR-0172: git-log-search system skill (pickaxe/regex/author/since via shell git)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Source analysis**: `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑤ + §⑧
- **Related ADRs**: ADR-0105 (git env determinism + US-separator), ADR-0111 (CTK git-skill bundle), ADR-0102 (CTK absorption batch), ADR-0045 (system-skill seam pattern), ADR-0099 (Default-NO git posture — search is read-only so unaffected)
- **References**: `src/skill/system-skills/git-log-search/{SKILL.md,index.ts}`, `src/skill/system-skills/index.ts`, `src/skill/index.ts`, `tests/unit/system-skills-git-log-search-hellgate.test.ts`, `tools/feature-catalog/features/06-tier1/git-log-search-skill.yaml`

## Context

Cursor's git-axis taxonomy (cursor-git.md §⑤) makes a deliberate split:

| Operation | Surface | Why |
|---|---|---|
| `blame_by_file_path` | atomic **tool** (single-shot, structured) | one query → one result, no iteration |
| pickaxe / regex / author / since history search | CTK **skill** via `gh`/`git` shell | exploratory; user narrows query across turns |

§⑧ enumerates the 7 CTK git skills (`babysit`, `fix-merge-conflicts`, `loop-on-ci`, `make-pr-easy-to-review`, `new-branch-and-pr`, `pr-review-canvas`, `review-and-ship`, `get-pr-comments`) — all workflow-shaped, none atomic. The lesson: when the user's intent is "find / explore / search" rather than "give me X for path P", a SKILL beats a tool because the model can iterate (broaden / narrow / change mode / inspect a specific commit) within the skill's procedure without re-entering tool dispatch.

Quanta already shipped the 8 CTK git skills (ADR-0111) and the git-env-determinism quartet (ADR-0105) but had no first-class history-search workflow. Models that wanted code archaeology had to invent a Bash command per turn — losing the `GIT_OPTIONAL_LOCKS=0` / `GIT_PAGER=cat` / `GIT_TERMINAL_PROMPT=0` / `LC_ALL=C` env hygiene and the US-separator pretty-format that ADR-0105 standardized for parse safety.

## Decision

Ship `git-log-search` as a system skill (`src/skill/system-skills/git-log-search/`), NOT as a tool in `src/tool/git/`. The skill:

1. **Body teaches 4 search modes** — pickaxe (`-S` string COUNT change), regex (`-G` diff line match), `--author`, `--since` + path positional. Each with the canonical command shape and a worked example.
2. **Cites ADR-0105 env hygiene verbatim** — `GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 LC_ALL=C` quartet — and the US-separator format string `%H%x1f%an%x1f%ai%x1f%s`. Drift is hellgated (HELL-5).
3. **Declares minimal `allowedTools`** — `[Bash, Read]` only. No new tools. The skill's `progressive disclosure` model: SKILL.md teaches the command shape; the model composes the actual invocation per turn against the user's evolving query.
4. **Caps output at `-n 50`** by default in the body procedure, with explicit guidance to raise it on user request — pickaxe over a 10K-commit repo without `-n` is slow + floods context.
5. **Router seam matches the CTK bundle** — `GIT_LOG_SEARCH_SKILL_NAME` + `triggerGitLogSearch()` + `findGitLogSearchSkill()` exported, parallel to `triggerFixMergeConflicts()` et al. (ADR-0111 wiring pattern, ADR-0045 router-agnostic seam).
6. **Outcome enum** — `found` / `empty` / `blocked`. The string `complete` is forbidden until the command echoes back with one of those three states. (Consistent with the rest of the system-skill bundle.)

## Hellgate

`tests/unit/system-skills-git-log-search-hellgate.test.ts` pins 5 invariants:

| # | What it pins |
|---|---|
| HELL-1 | SKILL.md exists; frontmatter has `name`/`description`/`userInvocable:true`/`allowedTools⊇{Bash,Read}`/`tools⊇{Bash,Read}`/`category:skill`/`stability:stable` |
| HELL-2 | Body contains all 5 required sections (`## When this skill activates`, `## P0 rules`, `## Procedure`, `## What NOT to do`, `## Common queries`) — no silent restructuring |
| HELL-3 | Router descriptor: `GIT_LOG_SEARCH_SKILL_NAME === "git-log-search"`, `triggerGitLogSearch() === { name: "git-log-search" }`, `findGitLogSearchSkill()` resolves with `scope === "system"`, also reachable via `discoverSystemSkills()` |
| HELL-4 | Body mentions all 4 search modes: pickaxe (`-S` + word "pickaxe"), regex (`-G` + word "regex"), `--author`, `--since`, path positional `-- <path>` |
| HELL-5 | Body cites ADR-0105 env hygiene quartet verbatim + the US-separator format `%H%x1f%an%x1f%ai%x1f%s` + ADR-0105 string itself |

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Tool form** (`src/tool/git/log_search.ts`) | Forces atomic single-shot execution. Real archaeology is exploratory: user starts with `-S"parseConflicts"`, sees too many hits, adds `--since="3 months"`, then inspects one specific sha with `git show`. Each step is a separate decision — the skill body lets the model iterate; a tool would require either re-entry per query (high friction) or a fat input schema (15+ optional fields) that drifts from `git log` semantics. |
| **"Smart router" tool that picks pickaxe vs regex automatically** | Heuristic / regex collision risk. `-S".+"` matches almost every commit (flood); `-G` with a string containing regex metachar interprets it as a pattern silently. The model + user must consciously pick mode — that's a skill-level decision, not a tool-level one. |
| **Extend the existing CTK git-skill bundle in place** | Bundle scope (ADR-0111) is PR/CI workflows (review/ship/babysit), not history search. Co-mingling would dilute the bundle's contract and prevent independent evolution. Sibling skills with separate ADRs is the established pattern (`rewind` is its own ADR-0122 vs the `progress-audit` bundle). |
| **Hard-code the command in the agent prompt** | Loses progressive disclosure — every turn pays the body cost even when archaeology isn't the task. Skill activation gate is the right place. |

## Follow-up

- If usage analytics show the skill is invoked frequently with the same parameter pattern (e.g. always `-S` + `--since="N week"`), consider promoting **only that pattern** to a tool `git_recent_changes` while keeping the skill for general search. Per-skill execution metric via `instrumentTool` wrap is the right signal — defer until 1k+ invocations.
- `git log -L:<funcname>:<file>` (function-history range) is intentionally NOT in v1 — distinct enough to warrant a sibling `git-function-history` skill if/when needed (different P0 rules around function-boundary detection accuracy).
- The skill's `Bash` calls go through the standard admissibility 8-stage gate (ADR-0099 Default-NO git posture). Read-only `git log` should fall on `allow` under repo-rules; if a user runs with `noMatchPolicy:"deny"` and no rule covers `git log`, they'll see a HITL prompt — that's correct, not a bug.
