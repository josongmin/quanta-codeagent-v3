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
- **god-FUNCTION** — a function/method body > **150 lines** (LENGTH only).

The ratchet only goes DOWN: a NEW violation **fails the build — you must split it,
never add it to the allowlist**; and when a refactor drops a file/function below
threshold you **remove its stale allowlist entry** (the test demands it).

There is also a **COHORT ceiling** on modules in the 900-999 band
(`approachingModuleCeiling` in the same allowlist). The 1000-line gate caps an
individual file, but nothing capped the population walking up to it — measured
over one day the band moved 30 → 27 with six members ADVANCING and one new
entrant, so every split was being undone by the next feature. A new entrant into
the band fails the build: split one and **lower** the number. Like every other
ceiling here, it is never raised.

### Lint WARNINGS are not free — `bun run lint:debt`

`biome check` (`bun run lint`) exits non-zero only on **error**-level
diagnostics. Every rule declared at `warn` — `noNonNullAssertion`,
`noExcessiveCognitiveComplexity` (max 15), `noConsole`, … — therefore gates
nothing on its own, which is how ~1200 of them accumulated unnoticed. Do NOT
read a warning as "optional".

The gate is `bun run lint:debt` (`tools/dev/lint-debt-ceiling.ts`, CI step
"lint-debt ceiling"):

- **Per-rule counts** are pinned in `tools/dev/lint-debt-ceiling.json` and may
  only go DOWN. A new site fails the build — fix it, **never raise the ceiling**.
- **Closed universe**: a rule that fires while ABSENT from that file is treated
  as ceiling 0 and fails as "unpinned". A biome upgrade, a newly-enabled rule or
  an upstream rename cannot add a whole new debt category silently.
- **Worst score**: `noExcessiveCognitiveComplexity` also pins the highest single
  score, because counts alone cannot see one function being grown into a monster.
- Improvements are locked in deliberately with `bun run lint:debt --tighten`
  (which refuses to run while anything is regressing or unpinned).

**Proactive rule — fix on sight.** Whenever you open, edit, or even pass through a
god-module or god-function (or any obvious SE smell — a 20-arg signature, a copy-
pasted block, a 5-level nest), **split/clean it as part of your change** rather
than working around it. Don't grow the allowlist to "get unblocked"; shrinking it
is the goal. Touching a god-file is the moment to decompose it into cohesive
ports/adapters per the slice fence above. Regenerate the allowlist only to REMOVE
fixed entries (re-run the detector), never to add.

### Writing a ratchet / static-scan guard (non-vacuity is mandatory)

A ratchet is only worth its file if it goes RED when the thing it guards is
reverted. Source-scanning ratchets (`readFileSync` + regex/`includes` over `src/`)
have a specific failure mode we have shipped before: matching a **bare identifier**
(an `import`, a comment, a type) instead of a live **call/use**, so deleting the
call leaves the ratchet green (vacuous). Any static-scan guard you write MUST:

1. **Require a call/structural pattern, not a bare name** — e.g. `name\s*\(` for a
   function obligation, not `name`. (An `import { refreshX }` that is never called
   must still fail the "must call refreshX" ratchet.)
2. **Have an anti-vacuum floor** — assert the scan found ≥N known items, so a regex
   drift that matches nothing can't pass over the empty set.
3. **Prove red-on-injection** — a self-test that mutates the guarded surface (a
   catalog clone with one wrong value; a synthetic offending entry) and asserts the
   check FAILS for exactly that item; and, where cheap, note the in-tree revert that
   flips it RED. Reference exemplars: `edit-fresh-hash-mutating-tool-completeness-ratchet`,
   `runtime-config-knobs-default-parity-hellgate`, `runtime-config-no-dead-knob-ratchet`.

Reflecting the RUNTIME (`runtimeConfig()` under a synthetic env) beats scanning
source text when you can — a value can't be a stale comment. Prefer it.

## When you edit features

1. Edit the relevant YAML under `tools/feature-catalog/features/`.
2. Run `bun fc validate` — must pass before commit.
3. Run `bun fc build` — regenerates the MD.
4. Commit both the YAML edit AND the rebuilt MD.

If you're adding a new feature: `bun fc add <section> <slug>` scaffolds the
file, then fill in `evidence` / `purpose` / `maturity` etc.
