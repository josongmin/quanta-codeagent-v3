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

## When you edit features

1. Edit the relevant YAML under `tools/feature-catalog/features/`.
2. Run `bun fc validate` — must pass before commit.
3. Run `bun fc build` — regenerates the MD.
4. Commit both the YAML edit AND the rebuilt MD.

If you're adding a new feature: `bun fc add <section> <slug>` scaffolds the
file, then fill in `evidence` / `purpose` / `maturity` etc.
