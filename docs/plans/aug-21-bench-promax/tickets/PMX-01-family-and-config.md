# PMX-01 - typed `promax` family and fail-closed config routing

**Priority:** P0

**Depends on:** PMX-00 manifest shape; jun-30
[T2 typed config](../../jun-30-bench-modularity-extensibility/tickets/02-typed-bench-config-ssot.md)
and
[T4 family profile](../../jun-30-bench-modularity-extensibility/tickets/04-extension-profiles-and-backend-ports.md);
[BFND-01 suite/config](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md)

**Parallelizable:** pure type/CLI work may overlap PMX-02

## Goal

Make `promax` a first-class `swe-bench` dataset family from CLI resolution through local,
full-remote, pool, report, and dashboard routing. No caller may reach the
Verified or Scale Pro grader by fallback. Register ProMax through the existing
typed config and `DatasetFamilyProfile` owners; do not build either owner again.

## Current gaps

- `DatasetFamily` is only `verified | live | pro`.
- an unknown explicit family resolves to `verified`.
- legacy report/core family unions omit `promax`; BFND-02/PMX-05 owns their
  report migration after this ticket freezes the canonical family type.
- current config/report paths do not yet carry BFND-01's explicit
  `benchmarkSuite: "swe-bench"` identity.
- full/pool paths still resolve family from process env at lower layers.
- family-specific parser/grader/bootstrap conditionals are accumulating.
- the current dirty overlay contains an argv-to-env bridge; it is not an accepted
  typed-config foundation and must be reconciled before PMX work lands.

## Existing owners retained

- jun-30 T2 owns parsing CLI/env once and threading typed local/full/pool/chunk
  config. In-process consumers never reread or mutate the family env key.
- BFND-01 owns the outer `BenchRunConfig` discriminated union. PMX-01 consumes
  its `swe-bench` branch and never adds `benchmarkSuite: "promax"`.
- jun-30 T4 owns the sole `DatasetFamilyProfile` interface and registry. Its
  existing `verified`, `live`, and `pro` profiles must be real production routes
  before `promax` is registered.
- PMX-01 owns only the new family member, its profile implementation, its typed
  settings, and fail-closed selector hardening required to prevent fallback.

## Required changes

1. At a frozen clean SHA, verify or land T2/T4 and record the remaining raw
   `QUANTA_SWEBENCH_DATASET_FAMILY` readers. Reads are allowed only at a declared
   CLI/subprocess boundary.
2. Extend the canonical family type with `promax`; do not copy the family union
   into `benchmark-suite.ts`.
3. Split absent-default from invalid input:
   - no CLI/env selector -> `verified`;
   - recognized selector -> typed family;
   - any explicit unknown/blank-invalid selector -> descriptive error.
4. Add exactly one `promax` implementation to the T4 registry, preferably
   `src/apps/bench/profiles/promax.ts`. It supplies dataset format/public
   projection, harness adapter selection, typed remote bootstrap specification,
   preflight, and report partition key through the existing interface.
5. Resolve BFND-01's `swe-bench` config and its family/profile once at the bench
   composition root and thread the typed value into local/full/pool/chunk config. Env may serialize it for a new
   process or SSH command, but must not bridge functions inside one process.
6. Add ProMax-specific settings to T2's typed config without reusing
   `QUANTA_SWEBENCH_PRO_*`. Do not add a second `PromaxConfig` resolver under
   `promax/`; a family-specific value object may exist only after generic
   resolution.
7. Extend CLI help, dry-run rendering, typed control actions, and family/profile
   partition-key tests. Report and dashboard wiring is deferred to PMX-05 after
   BFND-02/03.
8. Preserve byte-identical behavior for an absent selector and existing
   verified/live/pro runs.

## Likely edit surfaces

- T2's canonical typed bench config module(s)
- BFND-01 `src/apps/bench/benchmark-suite.ts` as a consumed type/registry only
- `src/apps/bench/dataset-family.ts` as the canonical type/registry surface
- one new `src/apps/bench/profiles/promax.ts` profile implementation
- `src/apps/bench/run-main-helpers.ts`
- `src/apps/bench/commands/grade.ts`
- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session/types.ts`
- `src/runner/batch/core.ts`
- generic control actions only if they already consume typed config

`run-main.ts`, `box-session.ts`, and `ec2-lifecycle.ts` are already near the
1,000-line module threshold. Only thin wiring may be added there; extract new
behavior into cohesive sibling modules.

## Tests

- CLI and env both resolve `promax`;
- CLI wins according to the existing declared precedence;
- explicit `promaxx`, whitespace-only explicit input, and unknown env values fail;
- no selector remains Verified-compatible;
- `promax` dry-run reaches ProMax bootstrap/grader profile;
- `pro` still reaches the Scale profile;
- full and pool receive the same resolved family without rereading live env;
- a subprocess serialization round-trip restores the same typed profile, while
  an in-process command path performs no family env mutation;
- adding `promax` requires one profile registration and no new conditional in
  full, pool, chunk, corpus, harness selection, or dashboard code;
- the profile exposes distinct `pro` and `promax` partition keys for PMX-05;
- resolved config is exactly
  `benchmarkSuite:"swe-bench", datasetFamily:"promax"`;
- `benchmarkSuite:"promax"` and Terminal-with-family identities fail.

## Definition of done

`quanta-bench ... --dataset-family promax` resolves the BFND-01 `swe-bench`
branch and T2 config once, selects one T4 profile, and reaches parser, harness
adapter, remote bootstrap specification, and a typed report partition key without
another registry or in-process env bridge. PMX-05 later persists/projects that
key through BFND-02/03. An injected wrong suite/family cannot silently produce a
Verified route.

## Stop rule

Stop PMX-01 if T2/T4 are not production-wired for the existing families. Do not
hide that missing foundation inside a ProMax-specific registry, config resolver,
or `family === "promax"` branch.
