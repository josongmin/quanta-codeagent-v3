# jun-22 repro-oracle campaign — RCA, free-iteration harness, fix ladder

## TL;DR
Clean preset (answer-key steers removed) → **0/3** on the 3 north-star cases.
Not a capability ceiling: **the repro/verification oracle was never established
(0/3)** so verify-select had no signal. Root causes split by instance. The
campaign first builds a **near-zero-cost offline iteration harness** (record
once, replay/re-score many) so we stop burning tokens+EC2 per fix, then walks a
**measured fix ladder** gated on closure-diagnostic readouts.

## Evidence (full-remote on-demand run, report-i-0cc91553)
closure diag (n=3): `primary_rail_present_rate=0`, `synth_repro_base_red_rate=0`,
`required_verification_coverage=0`, `repro_red_but_unresolved_rate=null/n=0`,
`owner_recall@1=1.0` (localize perfect), `stray_file_rate=0`, `over_budget=0`.

Per-instance repro telemetry:
- **astropy-13033** — `reason: execution_failed`, sampleOutcomes `[exec_failed ×5]`,
  stderr `No module named 'extension_helpers'` (uv build-isolation can't build
  astropy). Every candidate hard-rejected `mweProof=candidate_red` → empty patch.
- **django-11138** — `reason: no_reproduced_candidate`, `[other,other,other,resolved,other]`,
  stdout "Other issues"; django BUILT fine. `missingEvidence: no_public_issue_mwe_seed`.
  cand-0 admissible but `publicRegression: base_not_green`.
- **django-14315** — `reason: no_reproduced_candidate`, `[other ×5]`, "Other issues";
  built fine; winner cand-1 selected yet failToPassFailed=2 (wrong patch).

## RCA (with adversarial caveats)
1. **astropy = build-env failure (exec_failed class).** uv build isolation lacks
   `extension_helpers`. Deterministic → n=1 sufficient. Fix = mirror official
   swebench env (extra-build-deps / `--no-build-isolation`). NOT answer-key IFF
   it matches the spec.
2. **django ×2 = no base oracle (no_reproduced class).** LLM repro scripts self-
   immolate to "Other issues"; no public MWE seed extracted. ⇒ `baseValidatedRed=
   false`, `primaryRail=null` ⇒ verify-select can't confirm a winner.
   - **Caveat A1**: oracle absence is necessary, NOT proven sufficient. 14315 had a
     selected winner and still failed → a correct candidate may not exist in the K
     (rejected candidates discarded). Do NOT claim "oracle fix → django resolves".
   - **Caveat A2**: 11138 `base_not_green` = regression baseline itself unstable on
     base → audit base-env integrity separately, not just repro-gen.
3. **Localize is solved** (owner_recall@1=1.0). Not the bottleneck.

## Cost model / why we keep burning tokens
The fixes (build-env, MWE-seed extraction, selector scoring, repro exec) are
**deterministic post-generation** code. The only expensive thing is the one-time
stochastic LLM rollout. Today we re-pay full rollout+EC2 per fix because:
- this run didn't record a cassette (`QUANTA_BENCH_RECORD_TRAJECTORY` off), and
- repro-script sources + the K-1 rejected candidate patches are NOT persisted, and
- there's no "re-score cached candidates with new oracle" mode.

Existing infra (verified): `QUANTA_BENCH_RECORD_TRAJECTORY=1` records full LLM
stream → `trajectory.jsonl`; **`QUANTA_BENCH_REPLAY_TRAJECTORY=<cassette>`** replays
it for 0 tokens (bench cassette axis, `src/apps/bench/index.ts:709` — NOT the
generic `QUANTA_LLM_REPLAY`); repro executor is fully port-injected
(exec/writeFile/buildArgv) so it runs offline; `grade --predictions` already
decouples grade from gen.
**Caveat A3**: replay reuses the SAME LLM outputs → only DETERMINISTIC fixes are
free to iterate; repro-gen PROMPT changes still need fresh paid generation.

## Industry SOTA direction
Record-once / replay-many (VCR cassette). Decompose eval into
**(stochastic rollout) × (deterministic harness)**; cassette the rollout; build
offline fixtures for the deterministic eval so oracle/harness changes verify for
free; two-phase `generate`(paid,cached) × `evaluate`(free,re-runnable).

## Plan (phased, each gated on a measured readout)

### Phase 0 — bypass-path AUDIT, not new design (0 tokens, 0 EC2)
The shared env builder ALREADY has astropy's `setuptools<60` + `extension_helpers`
+ `--no-build-isolation` (`src/runner/batch/corpus/project-env.ts:5`). So the
astropy `exec_failed` is most likely a **proof path that does NOT route through
this builder**, not a missing fix.
- [ ] Trace the repro/MWE/smoke exec argv for astropy and find WHICH path bypasses
      `buildProjectEnvUvRunArgv` (the one whose stderr was `No module named
      'extension_helpers'`). Likely an exec seam that builds argv without the env
      stanza.
- [ ] (kept) anti-answer-key gate: upstream swebench astropy install stanza file
      not yet confirmed — keep mirroring-spec discipline; do not invent per-repo deps.
- [ ] Verify the fix via Phase-1 offline rescore once the harness exists (free).

### Phase 1 — free-iteration harness (build + hermetic test, ~0 tokens) — HIGHEST ROI
Implementation ORDER: sidecars → offline rescore → byte-identical round-trip test
→ (Phase 2) 1 paid cassette seed. Hellgate protocol: RED e2e first, then TDD.
- [ ] **Sidecar persistence — ALL K, not just selected** (gated/observe-only,
      byte-identical when off). Current telemetry intentionally DROPS full patches
      (`selection-types.ts:29`, `selection-proof-telemetry.ts:216`) and the repro
      helper keeps only `outcome==="reproduced"` (`driver.ts:1302`) — insufficient
      for exact-parity rescore. Persist:
      - ALL K repro script SOURCES (every sample, every outcome), and
      - ALL K candidate patch DIFFs (every candidate, not just the winner),
      → `repro-scripts-*.jsonl` / `candidates-*.jsonl` alongside preds.
- [ ] **Offline rescore command — `evaluate-repro` (or `rescore-oracle`), NOT
      `grade --oracle-only`** (`grade` = official harness grading; keep surfaces
      distinct). Input: cached candidates + scripts (+ dataset for base checkout);
      re-run deterministic repro exec + selection with current oracle code. Zero LLM.
- [ ] Hermetic unit tests (TDD; pattern: tests/unit/bench-repro-test-wiring.test.ts).
- [ ] **Byte-identical round-trip e2e (RED-first hellgate)**: rescore of cached
      artifacts reproduces the recorded outcomes/selection byte-for-byte BEFORE any
      oracle fix. This is the harness's correctness proof.

### Phase 2 — seed ONE cassette (1 paid run, the only paid step for a while)
- [ ] Re-run the 3 with `QUANTA_BENCH_RECORD_TRAJECTORY=1` + Phase-0 astropy fix +
      Phase-1 persistence. Produces cassette + cached candidates for all future
      free iteration.

### Phase 3 — deterministic fixes, iterated FREE against cassette/cache
- [ ] astropy: confirm build-env fix flips exec_failed→reproduced→oracle red→
      candidate admissible. Readout: `synth_repro_base_red` 0→1 for astropy.
- [ ] django MWE-seed: extract public reproducer from issue text (deterministic) →
      base-red oracle without LLM scripts. Readout: `primary_rail_present` 0→1,
      `no_public_issue_mwe_seed` gone.
- [ ] django base-env: audit `base_not_green` (regression baseline) separately.
- Global readout: `synth_repro_base_red_rate`, `primary_rail_present_rate`,
  `required_verification_coverage` rise from 0.

### Phase 4 — generation side (paid, ONLY if Phase 3 readout says oracle is fixed
                              but django still wrong; gate, no n=1)
- [ ] If oracle present but candidates still wrong = "right place wrong answer"
      class ([[jun-20-bestofn-wrong-repro-oracle-root]]). Levers: repro-gen prompt
      quality, reprovote. Needs fresh generation (not replayable). Measure on
      multi-instance, never n=1.

## Guardrails (durable)
- Build-env fixes MUST mirror official swebench spec, never invent (answer-key ban).
- Every phase has a measured readout; no heuristic hard-gates without justification.
- No generation/loop claims on n=1; astropy build-env is the only deterministic-n=1 ok.
- ≥3 adversarial audits before declaring the campaign "done".
- Record-trajectory / persistence gated default-OFF, byte-identical when off.
