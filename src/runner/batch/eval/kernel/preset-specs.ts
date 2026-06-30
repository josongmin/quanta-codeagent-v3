/**
 * Pillar C — the CURRENT bench presets re-expressed as {@link PresetSpec}s (the single
 * source). Each spec's `params` are authored to GENERATE the corresponding frozen
 * literal in `runner/knobs/presets.ts` (`KNOB_PRESETS[id]`) byte-for-byte — proven by
 * `tests/unit/kernel/preset-spec-parity.test.ts`. Once parity holds, the literal +
 * its composite double-book (`posture/compose-preset.ts`) + the byte-identical golden
 * oracle can all be deleted, leaving THIS as the only place a preset is declared.
 *
 * `steps` names the CONCEPTUAL ordered pipeline stages this preset runs (localize →
 * repro → repair → verify → select, as applicable). Steps do not affect the resolved
 * knob map (params do); they document/drive the pipeline ordering for Pillar B.
 *
 * Additive: not wired into the live driver — `presets.ts` is untouched.
 */

import type { PresetSpec } from "@/config/knob-schema/contracts"

/**
 * `agentless-v1` — the LSP-grounded localization core (the bundle formerly hidden
 * behind `QUANTA_BENCH_SOTA=1`). Localize-heavy with a validated-red repro and a
 * single-pass repair; no verify-select hard-veto gates. `params` mirror the frozen
 * literal exactly. `lsp-steer` is NOT a param here: it is DEFAULT-ON whenever `lsp:1`
 * (derived in `benchPostureFromState`), matching the literal which omits it too.
 */
export const AGENTLESS_V1: PresetSpec = {
  id: "agentless-v1",
  steps: ["localize", "repro", "repair"],
  params: {
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
  note: "LSP-grounded localization core; was QUANTA_BENCH_SOTA=1. Single-pass, no verify-select veto gates.",
}

/**
 * `agentless-v6-singlepass-execfull` — the jun-24 MEASURED WINNER. Exactly
 * `agentless-v1` PLUS `bench-in-loop-exec: full` (in-loop execution feedback). This
 * is the posture that RESOLVED django-11138 on the official harness (gold 4/4 files,
 * 0 regression). `NONEMPTY_FALLBACK` stays ENV-gated (default-OFF), deliberately NOT
 * a param, so the generated map == agentless-v1 + full-exec, matching the literal.
 */
export const AGENTLESS_V6_SINGLEPASS_EXECFULL: PresetSpec = {
  id: "agentless-v6-singlepass-execfull",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-24 measured winner: agentless-v1 + full in-loop exec. Resolved django-11138 on the official harness.",
}

/**
 * `agentless-v6-singlepass-execfull-sticky` — jun-28 AUTONOMOUS-SAFE arm. The v6
 * measured winner PLUS `must-pass: sticky` (sticky-red verify gate: a failing
 * verify is cleared ONLY by re-running the SAME command green — a narrow repro
 * green can't wash out a broad regression red). Flipped django-11141 gpt-5.4
 * FAIL→PASS in the controlled e2e. OPT-IN arm (not a promoted default) — the
 * measurement vehicle for sticky's default-promotion decision. Identical to
 * AGENTLESS_V6_SINGLEPASS_EXECFULL except the one added param.
 */
export const AGENTLESS_V6_SINGLEPASS_EXECFULL_STICKY: PresetSpec = {
  id: "agentless-v6-singlepass-execfull-sticky",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-28 autonomous-safe arm: v6 winner + sticky-red verify gate. Flipped django-11141 gpt-5.4 FAIL→PASS.",
}

/**
 * `agentless-v1-nosteer` — the A/B BASELINE for the `lsp-steer` grounding steer.
 * Identical to `agentless-v1` but with the steer explicitly `off`, so
 * `--preset agentless-v1` vs this is a clean single-variable measure of the
 * steer's effect (no env-forwarding needed; full-remote forwards `--preset`
 * only). `lsp-steer: off` IS a param here (the literal names it explicitly),
 * unlike agentless-v1 where the steer is DEFAULT-ON and omitted.
 */
export const AGENTLESS_V1_NOSTEER: PresetSpec = {
  id: "agentless-v1-nosteer",
  steps: ["localize", "repro", "repair"],
  params: {
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
  note: "A/B baseline for the lsp-steer grounding steer: agentless-v1 with the steer explicitly OFF.",
}

/**
 * `agentless-v6-closure-control` — jun-27 repair experiment arm A1 (control).
 * == the v6 winner (agentless-v1 + full in-loop exec) PLUS the closure
 * grounding / owner-widening rails (fault-evidence / verification-plan /
 * primary-rail / no-patch-breaker / repair-escalation), but the closure-repair
 * REINJECT loop is OFF. Paired with `agentless-v6-closure-repair` (A2) so
 * A2 − A1 isolates the reinject loop alone.
 */
export const AGENTLESS_V6_CLOSURE_CONTROL: PresetSpec = {
  id: "agentless-v6-closure-control",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-27 repair experiment A1 (control): v6 + closure grounding, reinject loop OFF.",
}

/**
 * `agentless-v6-closure-repair` — jun-27 repair experiment arm A2 (treatment).
 * == A1 (`agentless-v6-closure-control`) PLUS the reinject loop ON
 * (`closure-repair: 5` rounds), the Prometheus-equivalent execution-feedback
 * lever that re-runs the validated-red repro against the candidate and feeds
 * the verbatim failure tail back until green.
 */
export const AGENTLESS_V6_CLOSURE_REPAIR: PresetSpec = {
  id: "agentless-v6-closure-repair",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-27 repair experiment A2 (treatment): A1 + closure-repair reinject loop (5 rounds).",
}

/**
 * `agentless-v6-closure-tuned` — jun-28 == closure-repair + repair-spec-gate (the
 * oracle-hardening gate). The plain closure-repair arm tied its control because the
 * loop false-greened at round 0; repair-spec-gate makes a green round whose output
 * lacks the issue-declared expected read as a false green, so the loop fires rounds
 * 1..N exactly where the candidate is wrong.
 */
export const AGENTLESS_V6_CLOSURE_TUNED: PresetSpec = {
  id: "agentless-v6-closure-tuned",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-28 tuned closure: closure-repair + repair-spec-gate (oracle-hardening, catches round-0 false-green).",
}

/**
 * `agentless-v6-oracle` — jun-29 SYNTHESIS-CONVERGENCE lever. `closure-tuned`
 * (fail-to-pass oracle LOOP + round-0 false-green guard) PLUS `repro-grounding`.
 *
 * WHY the one added param is load-bearing: the repair validator re-runs the
 * AGENT'S OWN repro (validator.ts — deliberately NOT the official FAIL_TO_PASS,
 * which would be answer-key gaming), so the loop's signal is only as good as the
 * generated repro (~45% historical repro failure, jun-20). `repro-grounding`
 * lifts repro quality → a REAL oracle signal that can reject the under-edit /
 * wrong-predicate patches (docs/analysis/competitor-study). OPT-IN measurement
 * arm; the v6 winner + closure-tuned stay byte-identical.
 */
export const AGENTLESS_V6_ORACLE: PresetSpec = {
  id: "agentless-v6-oracle",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-29 oracle lever: closure-tuned + repro-grounding (the validator runs the agent's repro, so grounded repro is the prerequisite for a real fail-to-pass oracle signal).",
}

/**
 * `agentless-v6-oracle-hardened` — jun-29 A/B TREATMENT arm against the measured
 * `oracleGapFalseGreen` failure mode. `agentless-v6-oracle` PLUS PUBLIC-ONLY oracle
 * hardening: `repro-vote` (K-of-N consensus over the agent's OWN reproducing scripts)
 * + `repair-strong-oracle` (a green round clears ONLY when the PUBLIC issue-declared
 * expected output matches AND the repro-vote reached consensus).
 *
 * WHY: the pilot showed the agent-side canonical oracle is too lenient — a weak repro
 * the under-edit patch passes false-clears the loop (issueResolved=true) while the
 * official harness still fails. Both added knobs harden the AGENT-SIDE oracle using
 * PUBLIC signals ONLY (repro-vote.ts/strong-oracle.ts never read FAIL_TO_PASS / the
 * official report — no answer-key leak). A/B vs agentless-v6-oracle measures whether
 * stronger public oracles cut the oracleGapFalseGreen rate without leaking.
 */
export const AGENTLESS_V6_ORACLE_HARDENED: PresetSpec = {
  id: "agentless-v6-oracle-hardened",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-29 A/B treatment: oracle + repro-vote + repair-strong-oracle (PUBLIC-only oracle hardening vs oracleGapFalseGreen).",
}

/**
 * `agentless-v7-oracle-multifile` — jun-30 structural Pro arm.
 *
 * WHY: the Pro closure audit converged on a second bottleneck after oracle
 * quality: the runtime already localizes the first owner file, but repair
 * generation collapses back to a single-file candidate on 2-5 file golds. The
 * breadth/fanout/co-change machinery already exists in the driver; this preset is
 * the first frozen arm that bundles those levers with the hardened PUBLIC oracle:
 * repair-breadth + location-fanout + multisite steer + lane diversity +
 * acceptance, plus the repro-admission hardening pair (paired-control /
 * adversarial-repro) to lift base-red signal quality.
 */
export const AGENTLESS_V7_ORACLE_MULTIFILE: PresetSpec = {
  id: "agentless-v7-oracle-multifile",
  steps: ["localize", "repro", "repair", "verify"],
  params: {
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
  note: "jun-30 structural Pro arm: oracle-hardened + breadth/fanout/co-change/lane diversity for multi-file repair completeness.",
}

/**
 * `agentless-v3-thin-strict` — jun-20 strict arm: mini-first + hard patch-budget
 * admission + source-only sanitizer. Keeps the localization stack but turns host
 * in-loop execution OFF for round-0 thinness and blocks over-budget final patches
 * from submission. Note vs agentless-v1: NO `repro-test` / `test-runner` params,
 * adds `bench-in-loop-exec: off` + patch-hygiene/spec-fidelity-steer/patch-budget(-strict).
 */
export const AGENTLESS_V3_THIN_STRICT: PresetSpec = {
  id: "agentless-v3-thin-strict",
  steps: ["localize", "repair"],
  params: {
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
  note: "jun-20 strict arm: thin/noexec round-0 + hard patch-budget admission + source-only sanitizer.",
}

/**
 * `agentless-v5-thin-and-expanded` — jun-22 v5 thin-first ADAPTIVE controller
 * opening. The base posture is EXACTLY `agentless-v3-thin-strict`; the per-phase
 * capability knobs are injected by the v5 controller via PHASE_MODULES at
 * runtime (NOT baked here), and selecting this preset is INERT (≡ thin-strict)
 * until `QUANTA_BENCH_V5_ADAPTIVE` opts the live router in (default-OFF). So this
 * literal == thin-strict byte-for-byte; the only difference is the live router
 * hook, which is out-of-band and not a resolved-knob param.
 */
export const AGENTLESS_V5_THIN_AND_EXPANDED: PresetSpec = {
  id: "agentless-v5-thin-and-expanded",
  steps: ["localize", "repair"],
  params: {
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
  note: "jun-22 v5 adaptive opening; resolved-knob map IDENTICAL to agentless-v3-thin-strict (the adaptive brain is an out-of-band runtime router, default-OFF).",
}

/**
 * `hint-only` — legacy unversioned preset: just `issue-hint: 1` (the issue text
 * passed through, no localization / repro / exec stack). Retained for back-compat
 * with existing sweeps + the `/knobs preset` listing.
 */
export const HINT_ONLY: PresetSpec = {
  id: "hint-only",
  steps: ["repair"],
  params: { "issue-hint": "1" },
  note: "Legacy unversioned: issue text only, no localization/repro/exec stack.",
}

/**
 * `everything` — legacy unversioned kitchen-sink preset: localization + subagent
 * + skills + branch-search, with `localize-phase: 3` (NOT 5) and `issue-hint:
 * agentless`. Retained for A/B against the versioned cores (no measured win for
 * subagent/skills yet). Has NO `read-outline` / `test-runner` / `retry-transient`.
 */
export const EVERYTHING: PresetSpec = {
  id: "everything",
  steps: ["localize", "repro", "repair"],
  params: {
    lsp: "1",
    subagent: "1",
    skills: "1",
    "localize-phase": "3",
    "branch-search": "3",
    "issue-hint": "agentless",
    "repro-test": "5",
  },
  note: "Legacy unversioned kitchen-sink: localization + subagent + skills + branch-search (localize-phase 3).",
}

/**
 * `baseline` — explicit no-op. Selecting `baseline` is byte-identical to no preset
 * at all: zero param overrides. `resolvePresetSpec(BASELINE, {})` === `{}`.
 */
export const BASELINE: PresetSpec = {
  id: "baseline",
  steps: [],
  params: {},
  note: "Explicit no-op preset; byte-identical to selecting no preset (empty override map).",
}

/** All re-expressed preset specs, keyed by id (parallels `KNOB_PRESETS` for parity). */
export const PRESET_SPECS: Readonly<Record<string, PresetSpec>> = Object.freeze({
  [AGENTLESS_V1.id]: AGENTLESS_V1,
  [AGENTLESS_V6_SINGLEPASS_EXECFULL.id]: AGENTLESS_V6_SINGLEPASS_EXECFULL,
  [AGENTLESS_V6_SINGLEPASS_EXECFULL_STICKY.id]: AGENTLESS_V6_SINGLEPASS_EXECFULL_STICKY,
  [AGENTLESS_V1_NOSTEER.id]: AGENTLESS_V1_NOSTEER,
  [AGENTLESS_V6_CLOSURE_CONTROL.id]: AGENTLESS_V6_CLOSURE_CONTROL,
  [AGENTLESS_V6_CLOSURE_REPAIR.id]: AGENTLESS_V6_CLOSURE_REPAIR,
  [AGENTLESS_V6_CLOSURE_TUNED.id]: AGENTLESS_V6_CLOSURE_TUNED,
  [AGENTLESS_V6_ORACLE.id]: AGENTLESS_V6_ORACLE,
  [AGENTLESS_V6_ORACLE_HARDENED.id]: AGENTLESS_V6_ORACLE_HARDENED,
  [AGENTLESS_V7_ORACLE_MULTIFILE.id]: AGENTLESS_V7_ORACLE_MULTIFILE,
  [AGENTLESS_V3_THIN_STRICT.id]: AGENTLESS_V3_THIN_STRICT,
  [AGENTLESS_V5_THIN_AND_EXPANDED.id]: AGENTLESS_V5_THIN_AND_EXPANDED,
  [HINT_ONLY.id]: HINT_ONLY,
  [EVERYTHING.id]: EVERYTHING,
  [BASELINE.id]: BASELINE,
})
