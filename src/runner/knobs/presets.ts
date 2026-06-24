/**
 * Named presets — convenience bundles of knob values, applied as the
 * LOWEST-priority overlay above defaults (an individual env var ALWAYS wins
 * over a preset value; see `resolve.ts` layer precedence).
 *
 * The contents are intentionally simple (knob-id -> string) so the resolver
 * can treat them identically to env vars / config-file entries. Every key MUST
 * be a registered framework-knob `id` (unknown ids are silently dropped by the
 * resolver) — for bench that means a knob declared under
 * `src/runner/knobs/knobs/` with `surfaces` including `"bench"`. Several bench
 * knobs are NOOP-apply (issue-hint / repro-test / issue-hint-expected-actual /
 * read-outline / test-runner / retry-transient): they exist as registry knobs
 * so the resolver + report + this preset layer can see them; their EFFECT is
 * delivered out of band by the bench driver (`benchPostureFromState` projection
 * + `setKnobOverride` bridge in `buildConfig`).
 *
 * ── VERSIONED PRESET CONVENTION (reproducibility) ───────────────────────────
 * Benchmark presets are NAMED and VERSIONED and treated as IMMUTABLE: the
 * contents of `agentless-v1` are frozen so a result tagged `preset:agentless-v1`
 * is reproducible forever. NEVER edit a `-vN` preset in place — if the
 * recommended posture changes, add `agentless-v2`. (The
 * `bench-preset-drives-config-hellgate` snapshot test trips on any in-place
 * edit of a frozen preset.) The unversioned `agentless-full` / `everything` /
 * `hint-only` entries below are RETAINED for back-compat with existing sweeps /
 * the `/knobs preset` listing; prefer the `-v1` names for new runs.
 */

const THIN_STRICT_PRESET_PREFIX = "agentless-v3-thin-strict"
const PROOF_CLEAN_PRESET_PREFIX = "agentless-v4-proof-clean"
const V5_ADAPTIVE_PRESET = "agentless-v5-thin-and-expanded"

export const presetRequiresLiveLspGrounding = (preset: string): boolean =>
  preset === THIN_STRICT_PRESET_PREFIX ||
  preset.startsWith(`${THIN_STRICT_PRESET_PREFIX}-`) ||
  preset === PROOF_CLEAN_PRESET_PREFIX ||
  preset.startsWith(`${PROOF_CLEAN_PRESET_PREFIX}-`) ||
  preset === V5_ADAPTIVE_PRESET

export const KNOB_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Explicit no-op. Selecting `baseline` is byte-identical to no preset at all.
  baseline: {},

  // ── Versioned bench presets (frozen) ──────────────────────────────────────
  // The full recommended SWE-bench posture (the bundle formerly hidden behind
  // the ad-hoc `QUANTA_BENCH_SOTA=1` flag, now honest + declarative + actually
  // config-driving). `QUANTA_BENCH_SOTA=1` resolves to THIS preset (alias).
  // Excludes subagent/skills deliberately — no measured win yet; those live in
  // `everything-v1` for A/B.
  "agentless-v1": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
  },
  // LSP-nav GROUNDING steer (`lsp-steer`) is DEFAULT-ON whenever `lsp:1` (see
  // benchPostureFromState) — agentless-v1 already steers `lsp_definition`/
  // `lsp_references`. This preset is the A/B BASELINE: identical to agentless-v1
  // but with the steer explicitly OFF, so `--preset agentless-v1` vs this one is
  // a clean single-variable measure of the steer's effect (no env-forwarding
  // needed on the remote box — full-remote forwards `--preset` only).
  "agentless-v1-nosteer": {
    lsp: "1",
    "lsp-steer": "off",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
  },
  // jun-17 proof-driven closure bundle: agentless-v1 + ALL six closure knobs ON.
  // This is the EXPERIMENTAL A/B ARM (not a claimed winner) — it turns on the
  // typed-artifact rails (fault-evidence/verification-plan/primary-rail/
  // patch-hygiene/no-patch-breaker/repair-escalation) so a `--preset agentless-v2`
  // vs `agentless-v1` run measures the bundle's effect. primary-rail is the only
  // BEHAVIORAL knob (gates the repair validator on a red-on-base repro); the rest
  // are observe-only telemetry feeding closure-diagnostics. FROZEN once measured.
  "agentless-v2": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    // NOTE: `closure-repair` (the verify-first repair EXECUTOR) is deliberately
    // NOT here. Measured net-negative (jun-19 on-demand wide-12: resolution 9→7,
    // verify_rounds always max, false_red=0 ⇒ the repro oracle is a false-NEGATIVE
    // — it doesn't recognize a correct fix, so repair just churns). The closure
    // GROUNDING knobs above are the winners (82/84 django, recovered 10914 / 19495
    // where mini failed). Re-add `"closure-repair": "3"` only after the repro
    // oracle reliably flips reproduced→resolved on a correct patch.
  },
  // jun-19 EXPERIMENTAL ARM — mini-first + patch-budgeted + source-only + critic-late.
  // Measured insight: #13417's cause is missing minimal-patch ADMISSION, not missing
  // verification. v3-thin keeps v2's localization+grounding but (1) thins round-0
  // (round0-minimal + spec-fidelity-steer; heavy verification prose deferred), and
  // (2) adds the patch-budget admission (over-engineer escalates to the late critic).
  // closure-repair stays OFF. NOT default; A/B arm vs agentless-v2 / mini-parity.
  // External alignment: Agentless 3-phase + mini-SWE thin scaffold + OpenHands late-critic.
  "agentless-v3-thin": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
  },
  // jun-20 strict arm:
  // mini-first + hard patch-budget admission + source-only sanitizer. It keeps
  // the localization stack, turns host in-loop execution OFF for round-0 thinness,
  // and blocks over-budget final patches from submission. Existing v3-thin remains
  // observe-only because it has already been measured.
  "agentless-v3-thin-strict": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "patch-hygiene": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
  // A/B arm (jun-24): IDENTICAL to agentless-v3-thin-strict EXCEPT in-loop test
  // execution is FULL (not off). Isolates the single hypothesis that exec=off is
  // the cause of the regression-class failures (the agent never runs the existing
  // tests in-loop, so it can't catch that its edit broke a passToPass test).
  // Everything else (minimality, budget-strict, localize-phase) held constant.
  "agentless-v3-thin-strict-execfull": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "full",
    "patch-hygiene": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
  // Strict + late critic/select. Candidate generation stays mini-first/noexec;
  // only the outer selector runs regression checks after candidates exist.
  "agentless-v3-thin-strict-select": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "patch-hygiene": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-early-accept": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
  },
  // Structural selector candidate arm. Keeps the cheap mini-swe/noexec candidate
  // generation from thin-strict-select, but restores the closure grounding knobs
  // from v3-thin so verify-select owner seeds/ownerCoverage are driven by the
  // ClosureBundle evidence SSOT instead of raw localizer fallback. Repair executor
  // stays OFF: this is late select, not repair churn.
  "agentless-v3-thin-strict-closure-select": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-early-accept": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
  },
  // Clean-authority successor to closure-select. Preserves the same closure-
  // grounded generation/search posture, but routes final submit authority
  // through the clean selector lattice.
  "agentless-v3-thin-strict-closure-select-clean": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-early-accept": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
    "selector-mode": "clean",
  },
  // Witness-only clean closure-select arm. Keeps the same closure-grounded
  // generation/search posture as closure-select-clean, but removes progressive
  // early accept and generated repro ranking so final submit authority comes
  // only from the clean selector's executed-witness / structural / contract
  // lattice over the full N-best candidate set.
  "agentless-v3-thin-strict-closure-select-clean-witness-only": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-regression": "discovered",
    "verify-select-repro": "off",
    "selector-mode": "clean",
  },
  // v4 proof-clean arm. Successor to the v3 closure-select-clean family:
  // keep closure-grounded generation and clean selector authority, but restore
  // bounded executable public-repro feedback in repro-only mode. This makes the
  // selector consume proof receipts instead of relying on minimality-only wins.
  //
  // jun-23 RECONCILED to be WINNABLE (was 0/3 — two structural defects, both fixed
  // in the driver, NOT by weakening the preset):
  //   - `adversarial-repro: 1` NO LONGER over-strictens the SUBMIT repro. Post the
  //     canonical/hardening split it means "ALSO generate an advisory HARDENING
  //     set" (tie-break / repair seeding). The submit-gate oracle stays CANONICAL
  //     (plain core-symptom), so a minimal correct fix can flip it green — removing
  //     the measured 75% gold false-negative that the proof gate treated as authority.
  //   - `verify-select-proof-required: 1` stays, but the proof gate is now CANONICAL
  //     + GOLD-CALIBRATED + FAIL-OPEN: when the canonical oracle is a confirmed gold
  //     false-negative, the driver lifts proofRequired for that instance (a
  //     proven-broken oracle must never hold hard submit authority). Calibration runs
  //     on the canonical set even under `verify-select-repro: positive` (soft).
  // No other preset changes posture (byte-identical).
  "agentless-v4-proof-clean": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "repro-only",
    "repro-test": "10",
    "adversarial-repro": "1",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-concurrency": "3",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
    "verify-select-proof-required": "1",
    // jun-24: CHA sibling-override completeness steer. Multi-backend bugs get a
    // byte-correct per-site hunk but miss sibling override sites (django-11138/
    // 14315 proven) → perfect repro stays RED → empty_patch. Static-only (reads
    // the candidate repo's own class hierarchy; never the gold patch). Control
    // arm for the A/B = the pre-cha .bench-pull baseline.
    "cha-multisite-steer": "1",
    "selector-mode": "clean",
  },
  // A/B arm (jun-24): identical to agentless-v4-proof-clean except the
  // in-loop execution rail is FULL instead of repro-only. This isolates the
  // competitor-style hypothesis that existing repo tests must run inside the
  // same generation/repair loop to close completeness/regression misses.
  "agentless-v4-proof-clean-execfull": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "full",
    "repro-test": "10",
    "adversarial-repro": "1",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-concurrency": "3",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
    "verify-select-proof-required": "1",
    "cha-multisite-steer": "1",
    "selector-mode": "clean",
  },
  // jun-25 COMPETITOR-VERIFIED ABSORPTION arm. == agentless-v4-proof-clean MINUS
  // verify-select-proof-required (don't hard-gate submit to empty — mini-SWE-agent
  // "submit best non-empty diff" posture; the 0/3 run's empty_patch terminator was
  // the proof gate) PLUS the LANDED-REAL absorbed levers: spec-fidelity-invariant
  // + dynamic-message-matcher (Lingxi execution-free spec oracle → 13033) and
  // forward-localize (Lingxi end-state consumer-trace → 14315). cha-multisite +
  // F821 differential (default-ON) ride along. A/B control = agentless-v4-proof-clean.
  // NOT default; opt-in via QUANTA_BENCH_PRESET. Composite SSOT: ABSORB_MODULES.
  "agentless-v5-absorb": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "repro-only",
    "patch-hygiene": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
    "verify-select": "5",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "repro-test": "10",
    "adversarial-repro": "1",
    "test-runner": "1",
    "verify-select-concurrency": "3",
    "selector-mode": "clean",
    "cha-multisite-steer": "1",
    "spec-fidelity-invariant": "1",
    "dynamic-message-matcher": "1",
    "forward-localize": "1",
  },
  // jun-22 v5 thin-first ADAPTIVE controller opening. The base posture is exactly
  // `agentless-v3-thin-strict` (cheap thin/noexec/minimal round-0); the per-phase
  // capability knobs (expand-select / proof-clean / repair / repro rails) are
  // injected by the v5 controller via PHASE_MODULES at runtime, NOT baked here.
  // Selecting this preset is INERT (≡ thin-strict) until `QUANTA_BENCH_V5_ADAPTIVE`
  // opts the live router in (default-OFF; the brain is gated on the oracle being
  // measured — see jun-22-agent-v5 plan Wave-2/3). So this literal == thin-strict.
  "agentless-v5-thin-and-expanded": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "patch-hygiene": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
  // jun-20 no-oracle verify-select arm. Starts from v3-thin, adds N-best
  // selection, uses discovered native repo tests as the hard regression signal,
  // and demotes self-generated repro consensus to positive-only soft ranking so
  // a noisy repro false-negative cannot reject the right candidate.
  "agentless-v3-select-regression": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "verify-select": "5",
    "verify-select-early-accept": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
  },
  // jun-20 targeted verify_loop_stuck arm. Keeps the no-oracle verify-select
  // posture, but adds the one-shot repro-doubt guard after 5 consecutive
  // post-edit test reruns. Separate preset so the stall-breaker effect stays
  // attributable instead of silently changing the base select-regression arm.
  "agentless-v3-select-regression-doubt": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "round0-minimal": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "verify-select": "5",
    "verify-select-early-accept": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "positive",
    "repro-doubt": "5",
  },
  // agentless-v1 + the multi-agent axis (subagent + bundled skills). Kitchen
  // sink for "use everything" runs; NOT measurement-clean vs agentless-v1.
  "everything-v1": {
    lsp: "1",
    subagent: "1",
    skills: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
  },

  // ── Legacy unversioned presets (retained for back-compat) ─────────────────
  "agentless-full": {
    "issue-hint": "agentless",
    "branch-search": "3",
    "repro-test": "5",
  },
  "hint-only": { "issue-hint": "1" },
  everything: {
    lsp: "1",
    subagent: "1",
    skills: "1",
    "localize-phase": "3",
    "branch-search": "3",
    "issue-hint": "agentless",
    "repro-test": "5",
  },
}
