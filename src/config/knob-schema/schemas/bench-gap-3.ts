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
