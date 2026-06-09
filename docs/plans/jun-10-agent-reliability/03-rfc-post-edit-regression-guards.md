# RFC-03: Post-Edit Regression Guards — Affected Tests, Lockfile Pairing, Generated Files

**Status:** PROPOSED · **Priority:** P1 · **Axis:** 3 (편집 후 회귀 방지)

## Problem statement

After the agent edits code, three regression classes pass through the harness unchecked:

1. **"My one test passed, related tests broke."** verify-guard (when ON) forces *a* verification, but nothing helps select *which* tests an edit endangers. The model picks the test it was thinking about; siblings break silently.
2. **Paired-file drift.** Editing `package.json` without re-locking, or a schema without its migration, produces a tree that is locally consistent and CI-broken. No detection anywhere (confirmed 3×: broad greps over `src/tool/`, `src/patch/`, hooks).
3. **Generated-file edits.** Nothing recognizes `@generated` / `DO NOT EDIT` / lockfile-by-hand edits; the agent can hand-edit build artifacts that the next regeneration silently reverts.

## Evidence (3-round audit, reconciled)

What exists (reuse, don't rebuild):

- **verify-guard** (default-OFF, presence gate `QUANTA_VERIFY_GUARD`): forces verify-after-mutate at finish; 14-ecosystem recognition. `src/agent/verify-guard.ts`, `src/agent/verify-signal.ts:53-96`.
- **edit-repair-loop** (default-OFF, strict `QUANTA_EDIT_REPAIR_LOOP === "1"`): post-edit lint-delta repair (LSP diagnostics bracket, tolerant line-shift per ADR-0495) + command-repair (run configured command, bounded fast-model fix loop). `src/agent/edit-repair-loop/`, dispatch integration `src/agent/dispatch.ts:401-529`. **Requires the caller to name the command — no discovery.**
- **git_co_change tool** (default-OFF, `QUANTA_GIT_CO_CHANGE`): ranks historically co-changed files (Jaccard over `git log --name-only`). `src/tool/git/co-change.ts`. Files, not tests; agent isn't prompted to consult it post-edit.
- **command-hooks (ADR-0454, default-OFF):** HookBus handlers on `pre_tool_use` / `post_tool_use` / `post_tool_use_failure` — a user-configurable post-edit command seam already exists. `src/agent/command-hooks/install.ts`. (R3's "not wired into bash" claim was wrong — the bus fires around every tool, bash included.)
- **Snapshot/golden policy:** smoke record/replay is manual-review by design (`tests/smoke/`, `bun run smoke:record` proposes, author tightens). Judged adequate; **no runtime change proposed** — but the *agent-facing* rule ("treat snapshot mismatch as a real failure unless the task is explicitly about updating goldens") exists nowhere.
- Repo ratchets/DoD are CI-only (`tools/pm/`, `tools/feature-catalog/lint.ts`) — intentionally not runtime; not a gap.

What does NOT exist (confirmed): affected-test selection (zero hits for any mapping logic), lockfile/manifest pairing checks, generated-file markers recognition, schema↔migration pairing. (`typecheck-stamp` from jun-08 memory does not exist in `src/` under any spelling — eliminated as a false lead; the closest live mechanism is edit-repair-loop's lint-delta.)

## Goals

1. Give the model a deterministic, provenance-carrying answer to "which tests should I run for this edit?"
2. Detect manifest↔lockfile (and schema↔migration) drift at the moment it's created.
3. Warn before hand-editing generated files.

## Non-goals

- Auto-running the selected tests (that's verify-guard/edit-repair-loop territory; we feed them, not replace them).
- Scoring/ranking thresholds ("run tests with affinity > 0.7") — selection output is a ranked list **with provenance per item**, never a silent cutoff (no-heuristics rule).
- Full build-system understanding (bazel/nx graphs) — out of scope v1; the design must leave a port for it.

## Workstreams (ticket-able)

### W1 — Affected-test selection tool (`affected_tests`)
A read-only tool mapping changed file(s) → candidate tests via three deterministic, individually-attributed sources:
1. **Convention:** `foo.ts` → `foo.test.ts`, `__tests__/foo*`, `tests/**/foo*` (existing repo glob utilities).
2. **Import graph:** reverse-dependency walk over the TS import graph to test files (the repo already concluded grep-reachability diverges and "진짜는 TS import-graph" — fc-judge memory; use the compiler API or ts-morph-equivalent already vendored if present, else minimal resolver).
3. **Co-change:** delegate to the existing `git_co_change` ranking, filtered to test paths.

Output: ranked list, each entry tagged `{source: convention|import-graph|co-change}` — the model (and user) sees *why* each test is suggested. No cutoffs; caps are explicit and logged.

**Acceptance:** unit tests per source on a fixture tree; hellgate: edit a file with a transitively-importing test two hops away → test appears with `import-graph` provenance. Tool registered through the manifest SSOT (`src/tool/surface/manifest.ts`) with full wiring (zero-unwired ratchet applies). **Default:** OFF (`QUANTA_AFFECTED_TESTS`), opt-in like co-change.

### W2 — Post-edit affected-test reminder
When W1's gate is ON and an edit-class tool succeeds, append a one-line system reminder: "changed `X`; candidate tests: …(top entries with provenance)". Implementation seam: same post-tool reminder channel as the post-bash stale reminder (`src/tool/bash/index.ts:145-164` pattern). Verify-guard then has something concrete to force toward.

**Acceptance:** reminder appears once per edited file per turn (dedup), byte-identical when gate OFF. **Default:** OFF, rides W1's gate.

### W3 — Paired-file drift guard (manifest↔lockfile, schema↔migration)
Deterministic pair table — `package.json`↔(`bun.lockb`|`package-lock.json`|`yarn.lock`|`pnpm-lock.yaml`), `Cargo.toml`↔`Cargo.lock`, `pyproject.toml`↔(`poetry.lock`|`uv.lock`), `go.mod`↔`go.sum`; extensible registry for project-declared pairs (e.g. `schema.prisma`↔`migrations/`). Detection at two seams:
- **post-edit reminder:** manifest edited this turn, paired lockfile not updated by turn end → closeout reminder ("lockfile not regenerated — run <pkg-mgr> install or state why not"). Package-manager identification already exists (`src/agent/env-context.ts:25-31`).
- **inverse warn:** direct edit of a lockfile file → pre-commit warn (these are generated; see W4).

**Acceptance:** unit per pair; hellgate: edit package.json, finish turn without lock update → reminder present; updating the lockfile via bash (`bun install`) suppresses it (detected via the existing post-bash stat sweep). **Default:** ON for the reminder (additive, zero behavior change, false-positive-proof because the pair table is exact paths) — mirrors staleness-gate's default-ON safety-control precedent; killswitch `QUANTA_PAIRED_FILE_GUARD=off`.

### W4 — Generated-file edit guard
Pre-commit check in the edit-class deny chain (same seam as `gitWriteGuardDeny`, `src/tool/edit/index.ts:396-397` — and per the mirror rule, also write + apply_patch): if target's first N KiB contain `@generated` / `DO NOT EDIT` markers, or the path matches the lockfile set from W3, return an **ask/warn** (not hard deny — regenerating goldens or fixing a generator output is sometimes the task). Marker list is a fixed registry, not heuristics.

Includes the agent-facing snapshot policy line in the prompt pack: snapshot/golden mismatch = real failure unless the task is explicitly snapshot-update.

**Acceptance:** unit: marker file → warn verdict; mirror tests for edit/write/apply_patch (jun-09 lesson: edit-class fixes must mirror); plain file byte-identical. **Default:** warn ON with `=off` killswitch (safety-control class), hard-ask variant gated OFF.

## Risks

- W1 import-graph cost on huge repos: bound the walk (explicit, logged cap), cache per turn.
- W3 monorepo manifests (workspaces): pair check must be per-directory, not repo-global — covered in acceptance fixtures.
- Default-ON choices (W3 reminder, W4 warn) cut against the default-OFF discipline; justification: both are exact-match, zero-false-positive, advisory-only — same envelope as the staleness gate which is the repo's precedent for default-ON safety controls. If review disagrees, flip to OFF without design change.

## Relations

- Feeds verify-guard (W2 gives it a target) and RFC-07 (drift findings belong in pre-handoff summaries).
- Tool additions go through manifest SSOT + knob registry + feature-catalog DoD.
