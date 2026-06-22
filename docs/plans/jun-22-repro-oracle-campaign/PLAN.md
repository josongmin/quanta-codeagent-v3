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
stream → `trajectory.jsonl`; `QUANTA_LLM_REPLAY=<cassette>` replays it for 0
tokens; repro executor is fully port-injected (exec/writeFile/buildArgv) so it
runs offline; `grade --predictions` already decouples grade from gen.
**Caveat A3**: replay reuses the SAME LLM outputs → only DETERMINISTIC fixes are
free to iterate; repro-gen PROMPT changes still need fresh paid generation.

## Industry SOTA direction
Record-once / replay-many (VCR cassette). Decompose eval into
**(stochastic rollout) × (deterministic harness)**; cassette the rollout; build
offline fixtures for the deterministic eval so oracle/harness changes verify for
free; two-phase `generate`(paid,cached) × `evaluate`(free,re-runnable).

## Plan (phased, each gated on a measured readout)

### Phase 0 — free de-risk (0 tokens, 0 EC2)
- [ ] Read official swebench spec install for astropy-13033 / these django ids.
      Confirm the exact build-dep handling so the fix MIRRORS spec (anti-answer-key gate).
- [ ] Local uv repro: checkout astropy@base, reproduce `extension_helpers` failure,
      test `--no-build-isolation` + declared build-system.requires → `import astropy` OK.
- [ ] Decide principled build-env approach (prefer `--no-build-isolation` + repo's
      own build-system.requires over a hand-maintained per-repo map; avoid sprawl).

### Phase 1 — free-iteration harness (build + hermetic test, ~0 tokens) — HIGHEST ROI
- [ ] Persist artifacts (gated/observe-only, byte-identical when off):
      repro-script sources + ALL K candidate patches → `repro-scripts-*.jsonl` /
      `candidates-*.jsonl` alongside preds.
- [ ] Add re-score mode (`evaluate-repro` / `grade --oracle-only`): cached
      candidates+scripts → re-run deterministic repro exec + selection with current
      oracle code. Zero LLM.
- [ ] Hermetic unit test (pattern: tests/unit/bench-repro-test-wiring.test.ts).
      Readout: re-score reproduces the recorded outcomes byte-for-byte before any fix.

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
