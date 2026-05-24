# ADR-0181: debug/blame skills trio (debug-trace, explain-stack-trace, blame-section)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Source analysis**: `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧
- **Related ADRs**: ADR-0111 (CTK git-skill bundle — workflow-shaped sibling pattern), ADR-0134 (engineering-task skills bundle — debug-error/add-tests/explain-code/extract-function), ADR-0173 (git-log-search system skill — direct sibling, same prompt-only seam)
- **References**: `src/skill/system-skills/{debug-trace,explain-stack-trace,blame-section}/{SKILL.md,index.ts}`, `src/skill/system-skills/index.ts`, `src/skill/index.ts`, `tests/unit/system-skills-new-trio-hellgate.test.ts`, `tools/feature-catalog/features/06-tier1/debug-blame-skills-trio.yaml`

## Research grounding (≤ 100 words)

`docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧ ("CTK git 스킬 7") catalogues Cursor's CTK skills as **workflow-shaped** (`fix-merge-conflicts`, `make-pr-easy-to-review`, `pr-review-canvas`, `babysit`, `loop-on-ci`, `new-branch-and-pr`, `review-and-ship`, `get-pr-comments`) — pure prompt + `gh`/`git` shell, "exploratory queries need user iteration on a narrative workflow, not single-shot atomic execution". The 7 are not tools because each step's parameters depend on the previous step's output that the user inspects. (No separate `cursor-bugbot-review.md` exists in this tree — `cursor-git.md` is the sole grounding for this ADR.) Memory `cursor-3.2-absorption.md` confirms the SKILL vs TOOL split.

## Context

Quanta already shipped two sibling clusters of workflow-shaped system skills:

- **ADR-0111 (CTK git bundle)** — 8 PR/CI workflow skills (`babysit`, `fix-merge-conflicts`, `loop-on-ci`, `make-pr-easy-to-review`, `new-branch-and-pr`, `pr-review-canvas`, `review-and-ship`, `get-pr-comments`).
- **ADR-0134 (engineering-task bundle)** — 4 generic engineering skills (`debug-error`, `add-tests`, `explain-code`, `extract-function`).
- **ADR-0173 (git-log-search)** — single archaeology skill, established the per-skill ADR pattern beside a bundle (sibling, not member).

Three workflow-shaped gaps remained, each cleanly partitioned by audience:

1. **`debug-trace`** — "this crashed / investigate this error" workflow. Distinct from `debug-error` (which reproduces + patches): debug-trace is the focused parse→read→hypothesize step that produces ranked `file:line + cause + fix` candidates without applying the patch. Composable with `debug-error` for full reproduce-and-fix loops.
2. **`explain-stack-trace`** — pure read-only narrative explainer. One paragraph, no fix proposal. Distinct from both debug skills because the user wants **understanding**, not action. Mis-attributing this to `debug-trace` causes the model to propose fixes the user didn't ask for.
3. **`blame-section`** — multi-line / section-scoped `git blame`. Wraps the existing `git_blame_heatmap` tool's `start_line`/`end_line` range form (added in ADR-0096) with a workflow: group by author + commit, surface top-3, cite ≥2 SHAs (most-touched + most-recent), distinguish **original author** (pickaxe via `git log -S` / `-L:funcname:file`) vs **recent editor** (the default `git blame` answer). Sibling of `git-log-search` (ADR-0173) — both are read-only git exploration workflows.

## Decision

Ship three system skills under `src/skill/system-skills/<name>/`, each:

1. **Prompt-only.** No new tools added to `src/tool/**`. Each skill's `allowedTools` is narrow — `debug-trace`: `[Bash, Read, Grep, parse_test_failure, file_tree_summary]`; `explain-stack-trace`: `[Read, Grep, parse_test_failure]`; `blame-section`: `[Bash, Read, git_blame, git_blame_heatmap]`.
2. **P0 rules cite the SPECIFIC tool names** they depend on. `parse_test_failure` in rule 1 of both debug skills; `git_blame_heatmap` + `start_line`/`end_line` + ADR-0096 in rule 1 of `blame-section`. Generic phrasing ("use the parser") is hellgated against (HELL-3).
3. **Mirror the existing seam shape** — `SKILL.md` (strict + lenient frontmatter) + `index.ts` (`<NAME>_SKILL_NAME` literal + `<Name>Trigger` interface + `trigger<Name>()` + `find<Name>Skill()`) — byte-identical to `git-log-search/index.ts` (ADR-0173) and `debug-error/index.ts` (ADR-0134).
4. **Five required sections** in the body: `## When this skill activates` / `## P0 rules` / `## Procedure` / `## What NOT to do` / `## Common queries`. Identical to `git-log-search/SKILL.md`. Drift caught by HELL-3.
5. **Composability declared in prose.** `debug-trace` defers to `explain-stack-trace` for narrative-only requests and to `debug-error` for reproduce+patch. `explain-stack-trace` ends its output with a `debug-trace` handoff sentence if the user might want a fix. Cross-skill references are first-class — handoff is part of each skill's contract, not implicit.

## Hellgate (9 cases, 3 per skill)

`tests/unit/system-skills-new-trio-hellgate.test.ts` pins 9 invariants:

| # | Skill | Pinned invariant |
|---|---|---|
| HELL-debug-trace-1 | debug-trace | Frontmatter has name + description (≥40ch) + userInvocable:true + allowedTools ⊇ {Bash, Read, Grep, parse_test_failure, file_tree_summary} + tools mirror + category:skill + stability:stable; name matches directory |
| HELL-debug-trace-2 | debug-trace | `DEBUG_TRACE_SKILL_NAME === "debug-trace"`; `triggerDebugTrace() === {name:"debug-trace"}`; `findDebugTraceSkill()` resolves with `scope:"system"` + non-empty body; reachable via `discoverSystemSkills()` |
| HELL-debug-trace-3 | debug-trace | Body has all 5 required sections AND cites `parse_test_failure` + `Read` by name |
| HELL-explain-stack-trace-1 | explain-stack-trace | Frontmatter shape (allowedTools ⊇ {Read, Grep, parse_test_failure}, same field set) |
| HELL-explain-stack-trace-2 | explain-stack-trace | Router descriptor `EXPLAIN_STACK_TRACE_SKILL_NAME` + trigger + find + discovery |
| HELL-explain-stack-trace-3 | explain-stack-trace | 5 sections + cites `parse_test_failure` + `Read` |
| HELL-blame-section-1 | blame-section | Frontmatter (allowedTools ⊇ {Bash, Read, git_blame, git_blame_heatmap}) |
| HELL-blame-section-2 | blame-section | Router descriptor `BLAME_SECTION_SKILL_NAME` + trigger + find + discovery |
| HELL-blame-section-3 | blame-section | 5 sections + cites `git_blame_heatmap` + `start_line` + `end_line` |

Verification: `bun test tests/unit/system-skills-new-trio-hellgate.test.ts` → 9 pass / 0 fail; together with sibling git-log-search + git bundle smoke = 18 pass / 0 fail / 163 expect() calls.

## Default-OFF

The three skills only activate when a host invokes them (slash command, planner UI, or `Skill` tool with the matching `name`) OR when the per-turn skill activation gate matches the user query against the `description` field. Until then, they cost zero tokens — `Active skills` rendering shows only the `description` first line, body loaded on demand (ADR-0045 progressive disclosure).

No host code is changed by this ADR. The skills become live the moment a host's `discoverSystemSkills()` call rebuilds — which already happens at session start in every wired surface.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Tool form** (`src/tool/parse_and_diagnose.ts`, `src/tool/section_blame.ts`) | These are exploratory — the model picks which frame to read first, whether to grep for siblings, whether to pickaxe for original author, when to STOP and hand off. Atomic tools force single-shot execution and either re-entry per query (high friction, breaks ReAct flow) or a fat input schema (15+ optional fields) that drifts from the underlying `git blame -L` / `parse_test_failure` semantics. The CTK §⑧ pattern explicitly demonstrates skills win for this shape. |
| **Mega-skill `code-archaeology`** | Conflates four distinct user intents: explain (understand only), debug-trace (hypothesize), blame-section (ownership), git-log-search (history). The model + user would lose the choice signal in the trigger phrase. Cluster `git-log-search`/`blame-section` are both git-axis but with very different P0 rules (env hygiene + US-separator format for log search vs original-vs-recent distinction for blame); merging them ships weaker advice. |
| **Put in CTK git bundle (ADR-0111)** | Different audience — the CTK bundle is **PR/CI workflows** (review/ship/babysit/conflicts) for someone shipping code. The new trio is **debugging + code archaeology** for someone investigating code. Co-mingling dilutes both bundles' contracts and prevents independent evolution. `git-log-search` (ADR-0173) already established the sibling-ADR pattern beside the CTK bundle; the trio extends that pattern, not the bundle. |
| **Make `explain-stack-trace` a mode of `debug-trace`** | The "no fix proposal" contract IS the value — it's the only signal that tells the model to stop short of action. A mode-flag would be silently bypassed by an enthusiastic model. Separate skill with `What NOT to do: Don't propose a fix` as P0 rule 4 keeps the contract enforceable. |

## Follow-up

- **`add-types` skill** — TypeScript-specific "this is `any`, add a type" workflow. Sibling shape, allowedTools `[Read, Grep, Edit, lsp_hover]`. Distinct enough from `extract-function` (ADR-0134) to warrant its own ADR.
- **`profile-perf` skill** — "this is slow, find the hotspot" workflow. Orchestrates a profiler invocation + result interpretation. Defer until quanta ships a profile tool seam.
- **`audit-deps` skill** — "what depends on X" workflow. Orchestrates `Grep` + (future) `js_import_graph` tool. Defer until import-graph tool exists.
- If usage analytics show `blame-section` invoked frequently with the same `start_line`/`end_line` pattern (e.g. always a function boundary), consider promoting that pattern to a `blame_function` convenience tool while keeping `blame-section` for general ranges. Defer until 1k+ invocations.
