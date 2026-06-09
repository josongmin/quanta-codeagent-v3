# ADR-0514: git_co_change — co-change / related-files signal (§7.2 long-tail)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - `src/tool/git/co-change.ts` (pure ranking core + thin spawn/format tool)
  - `src/tool/git/types.ts` (`gitCoChangeInputSchema` / `GitCoChangeInput`)
  - `src/tool/git/index.ts` (`gitTools(..., { coChange })` opt-in registration)
  - `src/apps/cli/internal.ts:655,1364` (`QUANTA_GIT_CO_CHANGE` gate read-site)
  - `src/tool/surface/manifest.ts:797` (tool-surface SSOT entry, gate `QUANTA_GIT_CO_CHANGE`)
  - Tests: `tests/unit/git-co-change.test.ts`, `tests/integration/longtail-new-tools-e2e.test.ts`
  - Absorbs: Codex change-impact / Cursor related-files.

## Context

`git_churn` (ADR-0025) answers the FIRST-order question "which files change OFTEN"
(single-file frequency). The change-impact signal Codex/Cursor surface is SECOND-order:
"which OTHER files historically change in the SAME commit as this one?" — the canonical
"if you touch X you probably also need Y" hint for fault localization and for not
forgetting a sibling (test/types/barrel) when editing. quanta had no such tool.

## Decision

Add `git_co_change`, a READ-ONLY, concurrency-safe git tool that builds a co-occurrence
matrix from `git log --name-only`. To keep commit boundaries unambiguous it uses
`--format=%x1e` (an ASCII Record-Separator per commit) instead of an empty `--format=`
(which produces NO inter-commit delimiter, collapsing all file lists into one group and
inflating co-counts). `parseCommitGroups` splits on the RS into per-commit file groups.

With a target `file`: `rankCoChange` counts, per OTHER file, the commits touching BOTH,
and a Jaccard `affinity` = coCount / |commits touching either| (inclusion-exclusion union)
so a file that ALWAYS ships with the target ranks above one that merely changes a lot
independently. Without a target: `rankCoChangePairs` emits the densest co-change PAIRS
globally. NO arbitrary thresholds — affinity is the standard Jaccard index, not a tuned
cutoff; ties break by path (`byteCompare`) for determinism. All ranking is exported pure
for unit tests; the tool itself is a thin spawn + format wrapper.

Default-OFF: registered ONLY when `gitTools` is built with `opts.coChange`, which the CLI
composition root (`internal.ts`) flips on the `QUANTA_GIT_CO_CHANGE` env gate (and which
also requires `QUANTA_GIT_TOOLS`, since it rides the git tool set). Gate off ⇒ the tool is
absent and the git tool set is byte-identical to the legacy 12-tool set.

## Consequences

The agent gains a change-impact / related-files signal at zero side-effect cost (read-only
`git log`). Behind a default-OFF gate, so the absence path is byte-identical — no regression
risk to the existing git tools. The pure ranking surface is fully unit-testable; the
integration hellgate exercises the REAL registry over a REAL git repo.

### Alternatives considered

- **Empty `--format=` delimiter (as an early draft):** rejected — produces no per-commit
  boundary, collapsing the whole window into one group and inflating co-counts. The RS
  marker (`%x1e`) is unambiguous and can never appear inside a path.
- **A tuned affinity cutoff / "strong co-change" threshold:** rejected per the no-heuristics
  rule — Jaccard is a validated, parameter-free index; ranking + topN is the honest surface.
- **Always-on registration:** rejected — kept default-OFF behind `QUANTA_GIT_CO_CHANGE` so
  the legacy git tool set stays byte-identical until opted in.
