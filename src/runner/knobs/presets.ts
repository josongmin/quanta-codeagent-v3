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
 * recommended posture changes, add a new versioned name (e.g. `agentless-v6`).
 * (The `bench-preset-drives-config-hellgate` snapshot test trips on any in-place
 * edit of a frozen preset.) The unversioned `everything` / `hint-only` entries
 * below are RETAINED for back-compat with existing sweeps / the `/knobs preset`
 * listing; prefer the versioned names for new runs.
 */

const THIN_STRICT_PRESET_PREFIX = "agentless-v3-thin-strict"
const V5_ADAPTIVE_PRESET = "agentless-v5-thin-and-expanded"

// Base recipe for the COMPETITOR-VERIFIED ABSORB reference arm. Kept as the
// single source for `agentless-v5-absorb-execfull` (the one ABSORB-levers arm we
// retain post jun-25 cleanup) so the forward-localize / spec-fidelity-invariant /
// dynamic-message-matcher / cha-multisite bundle is not lost. This literal itself
// is NOT a shipped preset (it sets `bench-in-loop-exec: repro-only`, the failed
// posture); only the execfull derivative below ships.
const COMPETITOR_ABSORB_PRESET = {
  lsp: "1",
  "localize-phase": "5",
  "issue-hint": "agentless",
  "issue-hint-expected-actual": "1",
  "repo-map": "1",
  "read-outline": "1",
  "retry-transient": "3",
  "bench-in-loop-exec": "repro-only",
  "patch-hygiene": "1",
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
} satisfies Readonly<Record<string, string>>

// `agentless-v5-absorb` with FULL in-loop repo-test execution (the adversarial-
// audit fix: `repro-only` forbids the repo test suite, trapping the agent in a
// single-backend self-reproducer → wide-coordination sqlite sites never execute/
// fail; `full` enables the TRAE verified method = run existing tests → coordination
// runtime error → fix the missed site). Identical to COMPETITOR_ABSORB_PRESET
// except `bench-in-loop-exec` flips repro-only→full (same key position).
const COMPETITOR_ABSORB_EXECFULL_PRESET = {
  ...COMPETITOR_ABSORB_PRESET,
  "bench-in-loop-exec": "full",
} satisfies Readonly<Record<string, string>>

export const presetRequiresLiveLspGrounding = (preset: string): boolean =>
  preset === THIN_STRICT_PRESET_PREFIX ||
  preset.startsWith(`${THIN_STRICT_PRESET_PREFIX}-`) ||
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
  // jun-24 MEASURED WINNER — single-pass + full in-loop exec. == agentless-v1
  // (the minimal localization core) PLUS `bench-in-loop-exec: full`. This is the
  // posture that RESOLVED django-11138 on the real official harness (gold 4/4
  // files, 0 regression), matching mini-swe-agent — the heavy verify-select
  // presets (v4-proof-clean*/v5-absorb*/v3-thin-strict*) laundered correct
  // patches to empty via their hard-veto gates and were superseded by this.
  // NOTE: the measured run ALSO sets `QUANTA_BENCH_NONEMPTY_FALLBACK=1` (submit
  // best non-empty diff). That stays ENV-GATED (default-OFF), not baked into the
  // frozen preset, so the literal == agentless-v1 + full-exec exactly.
  // Composite SSOT: LOCALIZATION_CORE base + [FULL_EXEC] (see PRESET_COMPOSITES).
  "agentless-v6-singlepass-execfull": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "full",
  },
  // jun-27 REPAIR EXPERIMENT — 3-arm A/B isolating the closure-repair REINJECT
  // loop (the Prometheus-equivalent execution-feedback lever) from the closure
  // grounding it rides on. RCA: ~88% of v6 failures are "synthesis" — correct
  // localization + clean-applying patch + 0 regression, but the validated-red
  // repro / fail_to_pass test STILL fails. The reinject loop re-runs the repro
  // against the candidate and feeds the VERBATIM failure tail back to the agent
  // until green — but it is OFF in the v6 winner. With plain v6 (A0) the three
  // arms attribute any delta correctly:
  //   A2 − A1 = the reinject loop ALONE (both carry identical grounding+widening)
  //   A1 − A0 = the closure grounding / owner-widening effect
  // Lean BY DESIGN: NO proof-required / proof-clean / family modules — those
  // reshape candidate ADMISSION and would confound the repair signal.
  //
  // A1 (control): v6 + closure grounding, reinject loop OFF (no closure-repair).
  "agentless-v6-closure-control": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "full",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
  },
  // A2 (treatment): == A1 + the reinject loop ON (closure-repair: 5 rounds).
  "agentless-v6-closure-repair": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "full",
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "closure-repair": "5",
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
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
  // jun-25 ABSORB reference arm (the ONE verify-select arm retained post jun-25
  // cleanup). == the competitor-verified absorption posture with FULL in-loop
  // repo-test execution: preserves the absorbed levers (forward-localize,
  // spec-fidelity-invariant, dynamic-message-matcher, cha-multisite) so the
  // absorb work is not lost and stays available as an A/B arm against the v6
  // single-pass winner. NOT default; opt-in via QUANTA_BENCH_PRESET.
  // Composite SSOT: ABSORB_EXECFULL_MODULES.
  "agentless-v5-absorb-execfull": COMPETITOR_ABSORB_EXECFULL_PRESET,
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
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
  // ── Legacy unversioned presets (retained for back-compat) ─────────────────
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
