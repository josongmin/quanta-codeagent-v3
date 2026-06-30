# T3 — surface thinning and shared boot — ENTRY SPLIT DONE, debt relocated

**Status:** entry surfaces thinned; god-code debt RELOCATED, not eliminated.
**Priority:** P3 (watch the relocated near-cap modules)

## Outcome (verified at HEAD `db63b8fd4`)

The premise — that `src/apps/bench/index.ts` (~1232 lines) and `cli.ts` (~2242 lines) are fat surfaces owning runtime logic — is **stale**. Two commits already did this work:

- `9872580b0 refactor(bench): split cli.ts god-MODULE into per-subcommand commands/ modules`
- `11adab597 refactor(bench): split index.ts god-MODULE into run-main / run-args / run-report`

Current state:

- `src/apps/bench/index.ts` — **131 lines**: terminal-IO binding, public re-exports, `import.meta.main` OTel-boot block. Runtime composition moved to `run-main.ts`.
- `src/apps/bench/cli.ts` — **204 lines**: pure argv parse + `switch` dispatch; every handler lives under `commands/*.ts` (analyze, auth, box, grade, pool, trace).
- Both files are **removed from the god-module allowlist** (`tools/god-code/allowlist.json`).

The entry-file DoD (thin `index.ts`/`cli.ts`) is satisfied. **But the split relocated god-module debt, it did not eliminate it:**

- `src/apps/bench/run-main.ts` — **910 lines** (91% of the 1000-line cap) and it carries the dataset-mode orchestration plus the family-bypass parse bug (T2)
- `src/apps/bench/commands/box.ts` — **919 lines** (92% of cap)
- `commands/pool.ts` (321), `commands/grade.ts` (290) — chunky but fine

Both near-cap files are one modest edit from tripping the ratchet. So T3's entry-thinning is done, but "surface thinning" as a posture is not — `run-main.ts` and `box.ts` are the next split candidates.

## Required action

- closeout note under `reports/` recording the two commits + final line counts
- add `run-main.ts` (910) and `commands/box.ts` (919) to the deferred-decomposition list alongside the driver modules (T6 note). Do not re-thin `index.ts`/`cli.ts` — that part is done.

## Proof rails (confirm still green)

```sh
wc -l src/apps/bench/index.ts src/apps/bench/cli.ts   # expect ~131 / ~204
bun test tests/unit/surface-coupling-ratchet.test.ts
bun test tests/unit/terminal-defaults-ratchet.test.ts
rg -n "apps/bench/cli|apps/bench/index" tools/god-code/allowlist.json   # expect empty
```
