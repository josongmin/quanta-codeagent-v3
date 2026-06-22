# AGENTS.md

Repo-local agent rules. Loaded into the per-turn system reminder by
`loadRepoRules(cwd)` (priority: `AGENTS.md` > `CLAUDE.md` > `.codex/CODEX-RULES.md`,
first non-empty file wins — no dual-truth merging).

## Tools provided

### `bun fc <command>` — feature catalog tool

The feature catalog lives in `tools/feature-catalog/features/**/*.yaml` (one
thin YAML per feature) and is **the source of truth** for
[docs/10.feature-catalog.md](docs/10.feature-catalog.md). The MD is an
**auto-generated build artifact** — never edit it directly; edit the YAMLs
and re-run `bun fc build`.

| Command | What it does |
|---|---|
| `bun fc build` | Regenerate `docs/10.feature-catalog.md` from all YAMLs + prose + baseline |
| `bun fc validate` | zod schema + id-unique + evidence file existence + ADR number existence |
| `bun fc list [--maturity L3] [--status hold] [--section 3]` | Filtered TSV (id, title, maturity) |
| `bun fc show <id>` | Dump a single feature's YAML |
| `bun fc add <section> <slug>` | Scaffold a new feature YAML |
| `bun fc diff` | Compare current MD vs fresh build (CI drift detection) |
| `bun fc check-evidence` | Verify evidence files / ADR refs / test paths still resolve |

Refresh the baseline metrics shown in the catalog footer:

```sh
bun tools/feature-catalog/refresh-baseline.ts
```

This runs `tsc --noEmit` + `biome check` + `bun test tests/unit
tests/integration` and writes the results to
`tools/feature-catalog/baseline.json`. The next `bun fc build` picks them up.

### Other repo scripts (`package.json`)

`dev` / `start` / `test` / `test:unit` / `test:integration` / `test:contract`
/ `test:ci` / `test:cov` / `test:eval` / `test:watch` / `typecheck` / `lint`
/ `lint:fix` / `format` / `build` / `bench` / `probe` / `bench:verified`.

## Slice isolation

`@/agent` is the only slice that may cross-import others (RFC 3.1). Library
slices (`@/llm`, `@/tool`, `@/memory`, `@/permission`, `@/runtime`, …) MUST
NOT import each other directly — Biome `noRestrictedImports` enforces this.
App slices (`src/apps/cli`, `src/apps/bench`, `src/apps/probe`) may cross
freely but cannot be imported from outside their own slice.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the slice fence and
ports/adapters contract.

## Code quality — SE metrics (god-code is a ratchet, fix on sight)

A `bun test tests/unit/god-code-ratchet.test.ts` ratchet (source: `tools/god-code/detect.ts`,
frozen `tools/god-code/allowlist.json`) enforces two structural SE metrics:

- **god-MODULE** — a source file > **1000 lines**.
- **god-FUNCTION** — a function/method body > **150 lines** (LENGTH; cognitive
  COMPLEXITY is separately gated by Biome `noExcessiveCognitiveComplexity` = 15).

The ratchet only goes DOWN: a NEW violation **fails the build — you must split it,
never add it to the allowlist**; and when a refactor drops a file/function below
threshold you **remove its stale allowlist entry** (the test demands it).

**Proactive rule — fix on sight.** Whenever you open, edit, or even pass through a
god-module or god-function (or any obvious SE smell — a 20-arg signature, a copy-
pasted block, a 5-level nest), **split/clean it as part of your change** rather
than working around it. Don't grow the allowlist to "get unblocked"; shrinking it
is the goal. Touching a god-file is the moment to decompose it into cohesive
ports/adapters per the slice fence above. Regenerate the allowlist only to REMOVE
fixed entries (re-run the detector), never to add.

## When you edit features

1. Edit the relevant YAML under `tools/feature-catalog/features/`.
2. Run `bun fc validate` — must pass before commit.
3. Run `bun fc build` — regenerates the MD.
4. Commit both the YAML edit AND the rebuilt MD.

If you're adding a new feature: `bun fc add <section> <slug>` scaffolds the
file, then fill in `evidence` / `purpose` / `maturity` etc.
