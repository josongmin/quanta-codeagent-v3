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
// jun-27: COMPETITOR_ABSORB_PRESET / COMPETITOR_ABSORB_EXECFULL_PRESET removed
// with the `agentless-v5-absorb-execfull` registration — the verify-select veto
// plane is retired (@deprecated). Re-derive a SOFT-rerank best-of-N arm fresh if
// ever needed; do not resurrect the hard-veto literal.

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
  // jun-28 AUTONOMOUS-SAFE arm — v6-singlepass-execfull + sticky-red verify gate.
  // The proven autonomous-safety bundle (verify-guard mustPass + STICKY: a failing
  // verify is cleared only by re-running the SAME command green — flipped
  // django-11141 gpt-5.4 FAIL→PASS). OPT-IN preset (NOT a promoted default): it is
  // the measurement arm for sticky's default-promotion decision (no global
  // byte-identical change). Identical to v6-singlepass-execfull except must-pass.
  "agentless-v6-singlepass-execfull-sticky": {
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
    "must-pass": "sticky",
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
  // jun-28 TUNED closure arm — == closure-repair + the oracle-hardening gate
  // (repair-spec-gate). The plain closure-repair arm TIED its control because the
  // loop false-greened at round 0 (over-narrow patch passes the weak test_exit_zero
  // repro predicate, loop stops, real fail_to_pass red). repair-spec-gate makes a
  // green round whose output LACKS the issue-declared expected read as a false
  // green, so the loop FIRES rounds 1..N exactly where it is advantageous (the
  // candidate is wrong) instead of stopping. assertion-pin (always-on in repair)
  // gives those rounds the literal assertion to satisfy. Measures #2's lift.
  "agentless-v6-closure-tuned": {
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
    "repair-spec-gate": "1",
  },
  // jun-29 oracle lever: closure-tuned + repro-grounding. The repair validator
  // runs the AGENT'S repro (not the official FAIL_TO_PASS — that would be answer-key
  // gaming), so grounded repro is the prerequisite for a real oracle signal that
  // rejects under-edit / wrong-predicate patches (docs/analysis/competitor-study).
  "agentless-v6-oracle": {
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
    "repair-spec-gate": "1",
    "repro-grounding": "1",
  },
  // jun-29 A/B treatment arm: oracle + PUBLIC-only oracle hardening (repro-vote
  // K-of-N consensus + repair-strong-oracle declared-expected match). Targets the
  // measured oracleGapFalseGreen — both knobs read agent-side public signals ONLY,
  // never FAIL_TO_PASS / the official report (no answer-key leak).
  "agentless-v6-oracle-hardened": {
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
    "repair-spec-gate": "1",
    "repro-grounding": "1",
    "repro-vote": "1",
    "repair-strong-oracle": "1",
  },
  // jun-30 structural Pro arm: oracle-hardened + REAL multi-file repair breadth.
  // Targets the measured Pro ceiling where owner_recall@1 is high but the agent
  // still collapses to a single-file patch on 2-5 file golds. The existing
  // breadth/fanout/co-change machinery is already implemented; this preset is the
  // first versioned arm that actually bundles it with the hardened public oracle:
  //   - repair-breadth=3          => generate B candidates per repair round
  //   - bench-location-fanout=1  => each candidate leads at a distinct ranked file
  //   - cha-multisite-*          => inject concrete sibling/co-change steering
  //   - model-lane-diversity=1   => use provider lanes when available, else no-op
  //   - acceptance=1             => when none clear green, keep the strongest
  //                                 public-oracle candidate instead of raw order
  //   - paired-control=1         => reject env-broken false-red repros
  //   - adversarial-repro=1      => keep a stronger advisory hardening repro set
  "agentless-v7-oracle-multifile": {
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
    "repair-spec-gate": "1",
    "repro-grounding": "1",
    "repro-vote": "1",
    "repair-strong-oracle": "1",
    acceptance: "1",
    "paired-control": "1",
    "adversarial-repro": "1",
    "repair-breadth": "3",
    "bench-location-fanout": "1",
    "cha-multisite-steer": "1",
    "cha-multisite-general": "1",
    "model-lane-diversity": "1",
  },
  // jun-30 SOTA++ synthesis-ONLY arm (RFC jun-30-python-pro-synthesis-measure-first):
  // v6-oracle-hardened + the repair-CONVERGENCE levers only (acceptance + breadth +
  // location-fanout + cha-multisite), DELIBERATELY EXCLUDING the env/admission/multi-
  // lane levers (paired-control, adversarial-repro, model-lane-diversity) so a Pro
  // A/B attributes a delta to SYNTHESIS, not to env-parity or sample decorrelation.
  // Pairs with the acceptance_tier_*_rate readout: if this arm beats baseline only
  // via tier-3 (all_patches) votes, the real next lever is the regression
  // passing-set infra, NOT more breadth.
  "agentless-v7-oracle-multifile-synthesis": {
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
    "repair-spec-gate": "1",
    "repro-grounding": "1",
    "repro-vote": "1",
    "repair-strong-oracle": "1",
    acceptance: "1",
    "repair-breadth": "3",
    "bench-location-fanout": "1",
    "cha-multisite-steer": "1",
    "cha-multisite-general": "1",
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
  // jun-27: the `agentless-v5-absorb-execfull` verify-select reference arm was
  // REMOVED — the verify-select/best-of-N veto SELECTION plane is retired (it
  // laundered correct patches to empty). The absorbed non-veto levers
  // (forward-localize, spec-fidelity-invariant, dynamic-message-matcher,
  // cha-multisite) survive as individual knobs; verify-select itself is
  // @deprecated. The synthesis lever is now the closure-repair loop.
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
