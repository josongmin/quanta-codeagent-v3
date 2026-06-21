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

export const presetRequiresLiveLspGrounding = (preset: string): boolean =>
  preset === THIN_STRICT_PRESET_PREFIX || preset.startsWith(`${THIN_STRICT_PRESET_PREFIX}-`)

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
  // agentless-v1 + the mini-swe (edit-and-submit) posture. Identical localization
  // stack (lsp/localize-phase/issue-hint/repo-map/read-outline) but turns OFF
  // in-loop test execution: drops `repro-test` (host-python repro directive) and
  // `test-runner` (the run-tests tool), and sets `bench-in-loop-exec:off` so the
  // driver emits SWEBENCH_DIRECTIVE_NOEXEC + no verifyGuard + single-pass + no
  // repro hint. For instances whose host test-env is incompatible the agent
  // can't run tests anyway; the grader runs them in the correct docker env.
  // A NEW frozen preset — agentless-v1 is untouched.
  "agentless-v2-safe": {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
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
  // jun-19 BASELINE ARM for the repro-vote A/B — agentless-v2 + the repair loop
  // gated by the LEGACY single-sentinel validator (`closure-repair:3`, NO vote).
  // This is the apples-to-apples control: it re-introduces the same closure-repair
  // executor that was measured net-negative, so `agentless-v2-repair` vs
  // `agentless-v2-reprovote` isolates EXACTLY the vote gate (single variable:
  // `repro-vote`). A boolean knob's env value cannot turn a preset-ON knob OFF
  // (parse yields true|undefined, never explicit-false), so the baseline MUST be
  // its own preset — env `QUANTA_BENCH_REPRO_VOTE=off` would NOT suppress it.
  "agentless-v2-repair": {
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
    "closure-repair": "3",
  },
  // jun-19 repro-oracle-quality ARM — repair gated by the K-of-N RESOLVED vote.
  //
  // The HYPOTHESIS: closure-repair was measured net-negative (resolution 9→7)
  // ONLY because the repro oracle is a false-NEGATIVE — it reads a CORRECT fix as
  // "reproduced", so the single-script gate rejects it and repair churns. The
  // `repro-vote` knob re-runs the WHOLE reproducing set on the patched tree and
  // majority-votes "Issue resolved", removing exactly that false-NEGATIVE. So
  // this arm bundles BOTH: `closure-repair:3` (the repair loop) + `repro-vote:1`
  // (its vote gate). Without closure-repair the repair phase never runs and the
  // vote would be INERT (the gate lives inside the loop) — they MUST ship together.
  //
  // Measurement: vs plain `agentless-v2` (no repair) = repair+vote net effect; vs
  // `agentless-v2-repair` (repair + legacy single-sentinel gate) = the vote's
  // ISOLATED effect (single variable `repro-vote`). v1/v2 untouched (frozen).
  "agentless-v2-reprovote": {
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
    "closure-repair": "3",
    "repro-vote": "1",
  },
  // WS1 mini-parity (jun-18) — agentless-v2 with the round-0 prompt THINNED.
  // Single-variable delta vs agentless-v2: `round0-minimal:1`. Everything else is
  // byte-identical to v2, so a `--preset agentless-mini-parity` vs `agentless-v2`
  // run isolates the effect of removing the round-0 repro-directive prose (the
  // baseline penalty: mini-swe's clean round-0 matched quanta 1:1 on the easy
  // tail and beat agentless-v1 on #10914). The repro is still generated and
  // still gates the repair loop (primary-rail unchanged) — only its PROSE is
  // deferred out of the first attempt. A NEW frozen preset — v1/v2 untouched.
  "agentless-mini-parity": {
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
    // closure-repair (executor) removed for the same measured net-negative reason
    // as agentless-v2 — keeps mini-parity = agentless-v2 + round0-minimal (single var).
    "round0-minimal": "1",
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
  // Adaptive strict arm: generate one thin/noexec strict candidate first. Only
  // if a static public-issue/patch risk gate fires does it spend candidate #2
  // and run late selection. Repro consensus is OFF here so low-risk strict@1
  // does not pay a hidden repro-generation cost before the gate can accept.
  "agentless-v3-thin-strict-gated": {
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
    "verify-select": "2",
    "verify-select-concurrency": "1",
    "verify-select-risk-gate": "1",
    "verify-select-regression": "discovered",
    "verify-select-repro": "off",
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
