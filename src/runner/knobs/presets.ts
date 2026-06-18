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
    // EXECUTION half: the gate's verify-first path runs up to 3 repair rounds
    // (re-run the primary rail, re-seed the agent). Without this the selected
    // rail never gates (gate_enter_rate = n=0). CLI `--repair-rounds` overrides.
    "closure-repair": "3",
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
