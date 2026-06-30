/**
 * Pillar A — authored {@link KnobSchema} declarations for the GAP-3 remaining
 * bench knobs (preset/selector aliases, run orchestration, trajectory cassette,
 * prompt-steer A/B levers, dispatch guards). SSOT for derive (see ../derive).
 *
 * Provenance per field:
 *   - `describe`/`default`/`kind`/`readSite`/`envKey`/`home`-via-surfaces mirror
 *     the CURRENT src/config/knob-inventory/bench.ts entry VERBATIM so the
 *     inventory-derive can be proven deep-equal (parity test).
 *   - `parse` for the ONE knob with a live registry knob
 *     (no-patch-force-fraction) mirrors src/runner/knobs/knobs/<id>.ts VERBATIM
 *     so the parse-parity test holds (same observable semantics over the probe
 *     spread).
 *   - Every OTHER knob here is ENV-DIRECT — it is read straight from
 *     `process.env` at its readSite (driver.ts / apps/bench/*) with NO registry
 *     `Knob`. There is no live `parse` to match, so we author a BEST-EFFORT
 *     `parse` matching the inventory kind (bool/int/string/enum) and prove
 *     INVENTORY-derive parity ONLY (the test asserts no parse ground-truth for
 *     these). A NORMALIZE pass that introduces real registry knobs would then
 *     pin parse-parity; until then these parsers are the declared intent.
 *
 * Additive: not registered, not imported by the live driver.
 */

import { isFalsyToken, isTruthyToken } from "@/shared"
import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const

/* ── Shared best-effort parsers for ENV-DIRECT bench knobs ─────────────────── */

/** Default-OFF opt-in gate (matches `gateOn`: only canonical truthy tokens turn
 *  it on). Best-effort: the env-direct readSites consume the raw via `gateOn`. */
const parseGateBool = (raw: string | undefined): boolean | undefined =>
  isTruthyToken(raw) ? true : undefined

/** Default-ON kill-switch (matches `gateDisabled`: only canonical falsy tokens
 *  turn it OFF; everything else leaves it ON). Best-effort for PROTECT_TESTS. */
const parseKillSwitchBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  return isFalsyToken(raw) ? false : true
}

/** Positive-int parser (matches resolveConcurrency: `^\d+$`, > 0). Best-effort
 *  for CONCURRENCY. Unset/empty/non-positive/garbage ⇒ undefined. */
const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return undefined
  const n = Number.parseInt(s, 10)
  if (!Number.isSafeInteger(n) || n <= 0) return undefined
  return n
}

/** String passthrough for path/name-valued knobs (PRESET / *_TRAJECTORY). The
 *  readSites interpret the literal string themselves; unset ⇒ undefined. */
const parseStringValue = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  return raw
}

/* ── QUANTA_BENCH_SOTA (env-direct, knobs-bench.ts via gateOn) ─────────────── */
export const benchSotaSchema: KnobSchema<boolean> = {
  id: "bench-sota",
  envKey: "QUANTA_BENCH_SOTA",
  kind: "bool",
  default: false,
  describe:
    "Bench: DEPRECATED back-compat alias for the agentless-v1 preset. Prefer QUANTA_BENCH_PRESET=agentless-v1. =1 resolves the full recommended posture (lsp + localize-5 + agentless issue-hint + expected-actual + repro-test-5 + retry-transient-3 + repo-map + read-outline + test-runner). Individual QUANTA_BENCH_* override; unset ⇒ byte-identical baseline.",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_PRESET (env-direct, knobs-bench.ts named selector) ───────── */
export const benchPresetSchema: KnobSchema<string> = {
  id: "bench-preset",
  envKey: "QUANTA_BENCH_PRESET",
  kind: "string",
  default: undefined,
  describe:
    "Bench: named preset selector (value, NOT on/off) — e.g. agentless-v1 / everything-v1 / baseline. Picks a frozen versioned bundle from KNOB_PRESETS; individual QUANTA_BENCH_* env vars override preset values. QUANTA_BENCH_SOTA=1 is a back-compat alias for agentless-v1.",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: parseStringValue,
}

/* ── QUANTA_BENCH_CONCURRENCY (env-direct, apps/bench/index.ts) ────────────── */
export const benchConcurrencySchema: KnobSchema<number> = {
  id: "bench-concurrency",
  envKey: "QUANTA_BENCH_CONCURRENCY",
  kind: "int",
  default: 1,
  describe:
    "Bench: max instances processed concurrently (default 1 = serial, byte-identical). >1 overlaps patch-gen across instances; Docker grading stays serialised by the python-swebench mutex (arm64-safe). Also settable via --concurrency. For parallel grading use an x86 backend (ADR-0536).",
  readSite: "apps/bench/index.ts",
  surfaces: BENCH,
  parse: parsePositiveInt,
}

/* ── QUANTA_BENCH_CLOSURE_DIAG (env-direct, apps/bench/index.ts via gateOn) ── */
export const benchClosureDiagSchema: KnobSchema<boolean> = {
  id: "bench-closure-diag",
  envKey: "QUANTA_BENCH_CLOSURE_DIAG",
  kind: "bool",
  default: false,
  describe:
    "Bench: emit closure diagnostics (per-instance closeout telemetry) to the report. Default-OFF (gateOn). Observe-only.",
  readSite: "apps/bench/index.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_RECORD_TRAJECTORY (env-direct, apps/bench/trajectory.ts) ─── */
export const benchRecordTrajectorySchema: KnobSchema<string> = {
  id: "bench-record-trajectory",
  envKey: "QUANTA_BENCH_RECORD_TRAJECTORY",
  kind: "string",
  default: "",
  describe:
    "Bench: record the run's LLM trajectory to a replayable JSONL cassette (DEFAULT-OFF). Unset/''/'0' ⇒ no recording (byte-identical). '1'|'on' ⇒ <cwd>/bench-trajectory.jsonl; any other value ⇒ that path. Enables replaying a FAILED run deterministically up to any turn and DIVERGING there (bench-native 'fork from a point'; the CLI fork_session feature is REPL-scoped and cannot reach bench trajectories). full-remote propagates it to the box + fetches the cassette back to /tmp/full-remote-trajectory-<box>.jsonl.",
  readSite: "apps/bench/trajectory.ts",
  surfaces: BENCH,
  parse: parseStringValue,
}

/* ── QUANTA_BENCH_REPLAY_TRAJECTORY (env-direct, apps/bench/trajectory.ts) ─── */
export const benchReplayTrajectorySchema: KnobSchema<string> = {
  id: "bench-replay-trajectory",
  envKey: "QUANTA_BENCH_REPLAY_TRAJECTORY",
  kind: "string",
  default: "",
  describe:
    "Bench: replay a recorded LLM trajectory cassette during local bench runs. Unset/''/'0' ⇒ off. '1'|'on' ⇒ <cwd>/bench-trajectory.jsonl; any other value ⇒ that path. Default miss behavior is fail-closed (`QUANTA_BENCH_REPLAY_ON_MISS=throw`); remote/pool surfaces reject this local-path seam until explicit cassette upload wiring exists.",
  readSite: "apps/bench/trajectory.ts",
  surfaces: BENCH,
  parse: parseStringValue,
}

/* ── QUANTA_BENCH_REPLAY_ON_MISS (env-direct enum, apps/bench/trajectory.ts) ─ */
type ReplayOnMiss = "throw" | "passthrough" | "record-and-passthrough"
const parseReplayOnMiss = (raw: string | undefined): ReplayOnMiss | undefined => {
  if (raw === undefined) return undefined
  if (raw === "throw" || raw === "passthrough" || raw === "record-and-passthrough") return raw
  return undefined
}
export const benchReplayOnMissSchema: KnobSchema<ReplayOnMiss> = {
  id: "bench-replay-on-miss",
  envKey: "QUANTA_BENCH_REPLAY_ON_MISS",
  kind: "enum",
  domain: { enum: ["throw", "passthrough", "record-and-passthrough"] },
  default: "throw",
  describe:
    "Bench: miss policy for `QUANTA_BENCH_REPLAY_TRAJECTORY`. `throw` (default, fail-closed), `passthrough`, or `record-and-passthrough` for intentional replay-then-diverge troubleshooting.",
  readSite: "apps/bench/trajectory.ts",
  surfaces: BENCH,
  parse: parseReplayOnMiss,
}

/* ── QUANTA_BENCH_NO_PATCH_FORCE_FRACTION (LIVE knob — parse-parity proven) ── */
/** Mirrors src/runner/knobs/knobs/no-patch-force-fraction.ts VERBATIM: float in
 *  (0,1), spelled as `.N` or `0.N`; anything else ⇒ undefined (⇒ 0.8 hardcode). */
const parseNoPatchForceFraction = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^0?\.\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return undefined
  return n
}
export const noPatchForceFractionSchema: KnobSchema<number> = {
  id: "no-patch-force-fraction",
  envKey: "QUANTA_BENCH_NO_PATCH_FORCE_FRACTION",
  kind: "float",
  category: "agent",
  domain: { range: [0, 1] },
  default: undefined,
  describe:
    "Bench: no-patch breaker fires at this fraction of the turn budget (float in (0,1)). Unset ⇒ 0.8 (byte-identical). Only active when no-patch-breaker is on.",
  knobDescribe:
    "Bench: no-patch breaker fires at this fraction of the turn budget (default 0.8). Domain (0,1). Only active when no-patch-breaker is on.",
  readSite: "runner/knobs/knobs/no-patch-force-fraction.ts",
  surfaces: BENCH,
  parse: parseNoPatchForceFraction,
  costMultiplier: 1,
  unit: "fraction",
  source: "jun-22 magic-number config-extraction (was hardcoded DEFAULT_FORCE_FRACTION=0.8)",
}

/* ── QUANTA_BENCH_FIND_REFS (env-direct, driver.ts via gateOn) ─────────────── */
export const benchFindRefsSchema: KnobSchema<boolean> = {
  id: "bench-find-refs",
  envKey: "QUANTA_BENCH_FIND_REFS",
  kind: "bool",
  default: false,
  describe:
    "Bench: enable find_references tool + steer (timeout-immune ripgrep replacement for lsp_references on large repos). Default-OFF ⇒ byte-identical.",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_SIMPLICITY (env-direct, driver.ts via gateOn) ────────────── */
export const benchSimplicitySchema: KnobSchema<boolean> = {
  id: "bench-simplicity",
  envKey: "QUANTA_BENCH_SIMPLICITY",
  kind: "bool",
  default: false,
  describe:
    "Bench: minimal-mechanism simplicity steer in SWE-bench prompt (OpenHands/Linus philosophy). Default OFF; opt-in via QUANTA_BENCH_SIMPLICITY (unvalidated absorbed steer — A/B before promoting).",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_SIBLING (env-direct, driver.ts via gateOn) ───────────────── */
export const benchSiblingSchema: KnobSchema<boolean> = {
  id: "bench-sibling",
  envKey: "QUANTA_BENCH_SIBLING",
  kind: "bool",
  default: false,
  describe:
    "Bench: sibling-completion / co-change steer (ceiling multi-file class). Default-OFF ⇒ byte-identical prompt.",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_SAMPLE_TEMP (env-direct, driver.ts via gateOn) ───────────── */
export const benchSampleTempSchema: KnobSchema<boolean> = {
  id: "bench-sample-temp",
  envKey: "QUANTA_BENCH_SAMPLE_TEMP",
  kind: "bool",
  default: false,
  describe:
    "Bench: Agentless-style sampling diversity for the repair-breadth fanout. Candidate 0 stays greedy (byte-identical lane); candidates ≥1 sample at temperature 0.8 (Agentless repair.py greedy+temp schedule) so the best-of-N pool spans diverse fixes instead of N near-identical resamples. Auth-independent (same model, temperature only). Needs repair-breadth B>1. Default-OFF ⇒ unwrapped lanes ⇒ byte-identical. (Do NOT enable on OpenAI reasoning surfaces that reject temperature.)",
  knobDescribe:
    "Sampling-temperature diversity for breadth fanout (greedy lead + temp 0.8 samples, Agentless parity)",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_REPRO_IMAGE_EXEC (env-direct, repro-adapter.ts via gateOn) ── */
export const benchReproImageExecSchema: KnobSchema<boolean> = {
  id: "bench-repro-image-exec",
  envKey: "QUANTA_BENCH_REPRO_IMAGE_EXEC",
  kind: "bool",
  default: false,
  describe:
    "Bench: run the repro-oracle EXEC inside the instance's prebuilt Docker image (Pro `jefzda/sweap-images:<tag>`) via `docker run`, instead of the host uv project-env. RFC jun-29-repro-adapter-polyglot Phase 2b — the `image` backend selection. DEFERRED/runtime-gated BY DESIGN: Python parity inside the image (does the mounted, patched sandbox shadow the image's own pip-installed copy?) is UNPROVEN and must be validated on a box before promotion. Default-OFF ⇒ host backend ⇒ byte-identical (every existing Pro/Live/Verified repro run unchanged).",
  knobDescribe:
    "Repro EXEC inside the instance Docker image (Pro sweap-images) — Phase 2b, unproven parity, opt-in only",
  readSite: "runner/batch/eval/repro-adapter.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_VOTE_NORMALIZE (env-direct, driver.ts via gateOn) ────────── */
export const benchVoteNormalizeSchema: KnobSchema<boolean> = {
  id: "bench-vote-normalize",
  envKey: "QUANTA_BENCH_VOTE_NORMALIZE",
  kind: "bool",
  default: false,
  describe:
    "Bench: stronger acceptance vote-key (Agentless rerank.py parity). Dedup candidate patches on a comment/blank/whitespace-insensitive key so cosmetic-variant samples reinforce the majority instead of splitting it (Agentless normalize_code does the AST round-trip; we compose the existing diff normalizer + whole-line comment strip, no AST). Only affects the acceptance selector's vote key. Default-OFF ⇒ raw-trim key ⇒ byte-identical.",
  knobDescribe:
    "Stronger acceptance vote-key: comment/blank/whitespace-insensitive patch dedup (Agentless majority-vote parity)",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_SUBMIT_REVIEW (env-direct, driver.ts via gateOn) ─────────── */
export const benchSubmitReviewSchema: KnobSchema<boolean> = {
  id: "bench-submit-review",
  envKey: "QUANTA_BENCH_SUBMIT_REVIEW",
  kind: "bool",
  default: false,
  describe:
    "Bench: submission review (SWE-agent review_on_submit deterministic check). OBSERVE-ONLY verdict over the final captured patch (clean / empty / test-edits) surfaced in the report. The test-revert itself is ALREADY unconditional (sourceOnlyDiff strips test edits on every capture path) — this is the verdict/sentinel layer, reusing isTestFilePath+patchFiles (no re-implementation). Default-OFF ⇒ nothing attached ⇒ byte-identical.",
  knobDescribe:
    "Submission review verdict (clean/empty/test-edits) on the final patch — observe-only sentinel over the unconditional test-strip",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_EFFORT_LADDER (env-direct int, adaptive-escalation) ───────── */
// MIRROR of `resolveEffortLadderLimits`: positive integer tier turns it on; 0 /
// negative / non-integer / unset ⇒ off (the controller uses DEFAULT limits).
const parseEffortLadder = (raw: string | undefined): number | undefined => {
  const s = raw?.trim()
  if (s === undefined || s === "" || !/^\d+$/.test(s)) return undefined
  const tier = Number.parseInt(s, 10)
  return tier >= 1 ? tier : undefined
}
export const benchEffortLadderSchema: KnobSchema<number | undefined> = {
  id: "bench-effort-ladder",
  envKey: "QUANTA_BENCH_EFFORT_LADDER",
  kind: "int",
  domain: { range: [1, 4] },
  default: undefined,
  describe:
    "Bench: effort ladder (progressive-effort absorption) for the v5 adaptive-escalation loop. A positive TIER raises the bounded-loop ceiling (DEFAULT 4 steps / 2 expensive) by +2 steps / +1 expensive / +1 per-action per tier (clamped to tier 4), letting the existing action ladder climb to the heavy rails on hard instances. Reuses the controller's `limits` seam — no new loop. Default-OFF / tier 0 ⇒ DEFAULT limits ⇒ byte-identical.",
  knobDescribe:
    "Effort ladder tier: raise the adaptive-escalation bounded-loop ceiling (more headroom for the heavy rails)",
  unit: "tier",
  source: "progressive-effort / effort-ladder (competitor-strategy absorption)",
  readSite: "runner/batch/eval/adaptive-escalation/effort-ladder.ts",
  surfaces: BENCH,
  parse: parseEffortLadder,
}

/* ── QUANTA_BENCH_LOCATION_FANOUT (env-direct, driver.ts via gateOn) ───────── */
export const benchLocationFanoutSchema: KnobSchema<boolean> = {
  id: "bench-location-fanout",
  envKey: "QUANTA_BENCH_LOCATION_FANOUT",
  kind: "bool",
  default: false,
  describe:
    "Bench: multi-location-set fanout (Agentless §4.2 absorption). With repair-breadth B>1, seed each breadth candidate to LEAD at a distinct ranked-localizer file (location diversity instead of B resamples of the top-1 site). Reuses the repair-breadth fork machinery + the localizer's ranked files; pure rotation, no-leak. Needs B>1 + ≥2 localized files. Default-OFF ⇒ candidates share the base seed ⇒ byte-identical.",
  knobDescribe:
    "Multi-location-set fanout: each breadth candidate leads at a distinct ranked file (Agentless edit-per-location)",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}

/* ── QUANTA_BENCH_LLM_SELECT (env-direct enum, acceptance-llm-rerank-wire.ts) ── */
// MIRROR of `resolveLlmSelectMode` (the read site): trim+lowercase, only the two
// exact modes turn it on; everything else (incl. "1"/"on") is OFF.
type LlmSelectModeKnob = "chooser" | "reviewer"
const parseLlmSelect = (raw: string | undefined): LlmSelectModeKnob | undefined => {
  const s = raw?.trim().toLowerCase()
  if (s === "chooser") return "chooser"
  if (s === "reviewer") return "reviewer"
  return undefined
}
export const benchLlmSelectSchema: KnobSchema<LlmSelectModeKnob | "off"> = {
  id: "bench-llm-select",
  envKey: "QUANTA_BENCH_LLM_SELECT",
  kind: "enum",
  domain: { enum: ["chooser", "reviewer"] },
  // "off" is the sentinel unset-disposition (parse never RETURNS it); see issue-hint.
  default: "off",
  describe:
    "Bench: LLM soft-rerank over the acceptance admissible survivors (SWE-agent Chooser/Score retry-loop absorption). chooser = show all admissible diffs, model picks the best index; reviewer = per-candidate rubric score, highest wins. Re-ranks WITHIN the deterministic admissible set only (never-veto) and fails open to the vote winner. Needs the acceptance selector active. Default-OFF ⇒ byte-identical.",
  knobDescribe:
    "LLM soft-rerank of acceptance candidates (chooser/reviewer) — never-veto, fail-open; ~N× one-shot LLM cost",
  unit: "mode",
  source: "SWE-agent ScoreRetryLoop / ChooserRetryLoop (competitor-strategy absorption)",
  readSite: "runner/batch/eval/acceptance-llm-rerank-wire.ts",
  surfaces: BENCH,
  parse: parseLlmSelect,
}

/* ── QUANTA_BENCH_PROTECT_TESTS (env-direct kill-switch, driver.ts) ────────── */
export const benchProtectTestsSchema: KnobSchema<boolean> = {
  id: "bench-protect-tests",
  envKey: "QUANTA_BENCH_PROTECT_TESTS",
  kind: "bool",
  // DEFAULT-ON kill-switch: inventory records the literal `true`; the bool-kind
  // derive passes a non-undefined bool through verbatim (no inventoryDefault
  // escape hatch needed).
  default: true,
  describe:
    "Bench: dispatch test-scope guard — ENFORCING: DENIES mutating tools (edit/write/apply_patch) on test paths during swebench runs (source-only invariant; prevents PASS_TO_PASS gaming). DEFAULT-ON; QUANTA_BENCH_PROTECT_TESTS=0 disables.",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseKillSwitchBool,
}

/* ── QUANTA_BENCH_EXPOSE_DATASET_VERIFIER (env-direct, driver.ts via gateOn) ─ */
export const benchExposeDatasetVerifierSchema: KnobSchema<boolean> = {
  id: "bench-expose-dataset-verifier",
  envKey: "QUANTA_BENCH_EXPOSE_DATASET_VERIFIER",
  kind: "bool",
  default: false,
  describe:
    "Bench (jun-24): A/B lever that surfaces the dataset's repo-local verifier command to the agent (`agentVisibleBenchVerifierCommand`) so it prefers that over bare host-global pytest/python. Default-OFF ⇒ the verifier hint is withheld (byte-identical agent-visible context).",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseGateBool,
}
