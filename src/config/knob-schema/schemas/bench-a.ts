/**
 * Pillar A — authored {@link KnobSchema} declarations for the FIRST-THIRD slice
 * of bench knobs (inventory entries 1–25 in src/config/knob-inventory/bench.ts,
 * minus the families already declared in bench-repro.ts / bench-loop.ts).
 *
 * These are the SSOT: the registry `Knob`, the inventory entry, the posture
 * field, and the default-OFF proof all DERIVE from here (see ../derive).
 *
 * Source-of-truth fidelity (matched to the CURRENT hand-maintained data so the
 * derive is provably equal — locked by tests/unit/kernel/derive-parity-a.test.ts):
 *   - `parse`    replicates src/runner/knobs/knobs/<id>.ts verbatim,
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT
 *     src/config/knob-inventory/bench.ts entry,
 *   - `surfaces` mirror the LIVE knob (so `deriveHome` reproduces the entry's
 *     `home`).
 *
 * Additive: not registered, not imported by the live driver.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * // DERIVE GAPS: in-scope (entries 1–25) knobs EXCLUDED because the current
 * // `deriveInventoryEntry` / parity assertion cannot reproduce them cleanly.
 * // derive.ts is READ-ONLY, so these are listed rather than forced.
 * //
 * //  - QUANTA_BENCH_LSP (entry 2): the live `lspKnob` is CROSS-SURFACE
 * //    (["bench","agent-batch","agent-interactive"]); `deriveHome` maps any
 * //    non-bench-only surface set to home="runner-knobs", but the inventory
 * //    entry records home="bench". Deep-equal would FAIL on `home`.
 * //  - QUANTA_BENCH_SKILLS (entry 9): same cross-surface mismatch as LSP —
 * //    live `skillsKnob` surfaces are cross-surface ⇒ derived home="runner-knobs"
 * //    vs inventory home="bench".
 * //  - QUANTA_BENCH_SOTA (1), QUANTA_BENCH_RECORD_TRAJECTORY (4),
 * //    QUANTA_BENCH_REPLAY_TRAJECTORY (5), QUANTA_BENCH_REPLAY_ON_MISS (6),
 * //    QUANTA_BENCH_CLOSURE_DIAG (7), QUANTA_FULL_REMOTE_CONCURRENCY (8),
 * //    QUANTA_BENCH_PRESET (17), QUANTA_BENCH_CONCURRENCY (18): these have NO
 * //    dedicated registry `Knob` (they are read directly from env in
 * //    knobs-bench.ts / apps/bench/* — not via the knob registry). There is no
 * //    live `*.parse` ground truth to assert `deriveKnob(schema).parse(raw) ===
 * //    liveKnob.parse(raw)` against, so they are out of scope for a PARSE-parity
 * //    proof and excluded here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const
/** The strict enabling token set shared by the default-OFF bool knobs below
 *  (verbatim from each live knob's `ENABLING = new Set(["1","on","true"])`). */
const ENABLING = new Set(["1", "on", "true"])

/* ── subagent (QUANTA_BENCH_SUBAGENT) ─────────────────────────────────────── */
// Live parse: strict truthy on the RAW value (no trim/lowercase). Set {1,on,true}.
const SUBAGENT_TRUTHY = new Set(["1", "on", "true"])
const parseSubagent = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return SUBAGENT_TRUTHY.has(raw) ? true : undefined
}
export const subagentSchema: KnobSchema<boolean> = {
  id: "subagent",
  envKey: "QUANTA_BENCH_SUBAGENT",
  kind: "bool",
  category: "agent",
  default: false,
  describe: "Bench: enable subagent spawning.",
  knobDescribe: "Wire the Tier-1 subagent system (Agent/Task/TaskOutput/TaskStop tools)",
  source: "Codex absorption Phase 0-8",
  readSite: "runner/knobs/knobs/subagent.ts",
  surfaces: BENCH,
  parse: parseSubagent,
}

/* ── branch-search (QUANTA_BENCH_BRANCH_SEARCH) ───────────────────────────── */
export interface BranchSearchValue {
  readonly defaultN: number
  readonly config: {
    readonly defaultN: number
    readonly defaultVerifierKinds: readonly string[]
    readonly timeoutPerBranchMs: number
    readonly isolation: string
  }
}
const BENCH_BRANCH_TIMEOUT_MS = 60_000
const parseBranchSearch = (raw: string | undefined): BranchSearchValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 2 || n > 8) return undefined
  return {
    defaultN: n,
    config: {
      defaultN: n,
      defaultVerifierKinds: ["tsc"],
      timeoutPerBranchMs: BENCH_BRANCH_TIMEOUT_MS,
      isolation: "tmpdir",
    },
  }
}
export const branchSearchSchema: KnobSchema<BranchSearchValue> = {
  id: "branch-search",
  envKey: "QUANTA_BENCH_BRANCH_SEARCH",
  kind: "int",
  category: "agent",
  domain: { range: [2, 8] },
  default: undefined,
  describe: "Bench: branch-search K-best.",
  knobDescribe: "Agentless N-best speculative branch search (K candidates, ~K× cost)",
  costMultiplier: 8,
  unit: "candidates",
  source: "ADR-0084 / Agentless paper",
  readSite: "runner/knobs/knobs/branch-search.ts",
  surfaces: BENCH,
  parse: parseBranchSearch,
}

/* ── issue-hint (QUANTA_BENCH_ISSUE_HINT) — enum, inventory default "off" ──── */
type IssueHintMode = "agentless" | "regex"
const parseIssueHint = (raw: string | undefined): IssueHintMode | undefined => {
  if (raw === undefined) return undefined
  if (raw === "agentless") return "agentless"
  if (raw === "1" || raw === "on") return "regex"
  return undefined
}
export const issueHintSchema: KnobSchema<IssueHintMode | "off"> = {
  id: "issue-hint",
  envKey: "QUANTA_BENCH_ISSUE_HINT",
  kind: "enum",
  domain: { enum: ["agentless", "regex"] },
  // Inventory records "off" as the (sentinel) default; deriveInventoryDefault
  // passes enum defaults through verbatim. parse never RETURNS "off" — it is the
  // unset-disposition the posture applies — so the value type widens to include it.
  default: "off",
  category: "hint",
  describe: "Bench: issue-hint extraction mode.",
  knobDescribe: "Issue verbatim/agentless localization hint",
  unit: "mode",
  source: "Agentless paper §3.1",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: parseIssueHint,
}

/* ── issue-hint-expected-actual (QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL) ──── */
// Live parse: strict {1,on} on the RAW value (NOT {1,on,true}, no trim).
const EXPECTED_ACTUAL_TRUTHY = new Set(["1", "on"])
const parseExpectedActual = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return EXPECTED_ACTUAL_TRUTHY.has(raw) ? true : undefined
}
export const issueHintExpectedActualSchema: KnobSchema<boolean> = {
  id: "issue-hint-expected-actual",
  envKey: "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  // Inventory entry kind is "string" (not "bool") — mirror it verbatim.
  kind: "string",
  category: "hint",
  default: undefined,
  describe: "Bench: expected/actual extraction.",
  knobDescribe: "Extract structured expected/actual evidence to ground the issue-hint signal",
  source: "Agentless paper §3.1",
  readSite: "runner/knobs/knobs/issue-hint-expected-actual.ts",
  surfaces: BENCH,
  parse: parseExpectedActual,
}

/* ── bench-in-loop-exec (QUANTA_BENCH_IN_LOOP_EXEC) — kind string, default ON ─ */
type BenchInLoopExecModeKnob = "full" | "repro-only" | "off"
const IN_LOOP_OFF = new Set(["0", "off", "false"])
const IN_LOOP_FULL = new Set(["1", "on", "true", "full"])
const parseBenchInLoopExec = (raw: string | undefined): BenchInLoopExecModeKnob | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (IN_LOOP_OFF.has(s)) return "off"
  if (s === "repro-only" || s === "repro") return "repro-only"
  if (IN_LOOP_FULL.has(s)) return "full"
  return undefined
}
export const benchInLoopExecSchema: KnobSchema<BenchInLoopExecModeKnob | boolean> = {
  id: "bench-in-loop-exec",
  envKey: "QUANTA_BENCH_IN_LOOP_EXEC",
  kind: "string",
  category: "verify",
  // Inventory records `true` (default-ON / full posture when unset). For a
  // non-bool kind deriveInventoryDefault passes this through verbatim.
  default: true,
  describe:
    "Bench: execution authority mode. Default unset => full (byte-identical). Explicit repro-only => allow a tiny issue reproducer but forbid repo-test/pytest/tox execution. Explicit 0/off/false => submit-only posture (no verifyGuard, no repair, no repro hint).",
  knobDescribe:
    "Bench: execution authority mode (default full). full = repo tests in-loop; repro-only = focused issue reproduction only; off = edit-and-submit with no execution.",
  unit: "mode",
  source: "mini-swe posture absorption (pytest-7982 incompatible-host-env flail)",
  readSite: "runner/knobs/knobs/bench-in-loop-exec.ts",
  surfaces: BENCH,
  parse: parseBenchInLoopExec,
}

/* ── default-OFF bool knobs sharing the strict {1,on,true} trim/lowercase gate ─ */
const makeEnablingParse =
  () =>
  (raw: string | undefined): true | undefined => {
    if (raw === undefined) return undefined
    return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
  }

/* ── fault-evidence (QUANTA_BENCH_FAULT_EVIDENCE) ─────────────────────────── */
export const faultEvidenceSchema: KnobSchema<boolean> = {
  id: "fault-evidence",
  envKey: "QUANTA_BENCH_FAULT_EVIDENCE",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-201): emit a typed FaultEvidencePacket (bounded owner-context: paths/symbols only, no raw source) instead of raw-source hint blobs. Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-201 typed FaultEvidencePacket (bounded owner-context, no raw source)",
  source: "jun-17 proof-driven bench closure (T-201)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── verification-plan (QUANTA_BENCH_VERIFICATION_PLAN) ───────────────────── */
export const verificationPlanSchema: KnobSchema<boolean> = {
  id: "verification-plan",
  envKey: "QUANTA_BENCH_VERIFICATION_PLAN",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-301): build a typed VerificationPlan (primary rail + required/optional steps with typed successPredicates) instead of relying on the agent's ad-hoc verify command. Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-301 typed VerificationPlan (primary rail + typed successPredicates)",
  source: "jun-17 proof-driven bench closure (T-301)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── primary-rail (QUANTA_BENCH_PRIMARY_RAIL) ─────────────────────────────── */
export const primaryRailSchema: KnobSchema<boolean> = {
  id: "primary-rail",
  envKey: "QUANTA_BENCH_PRIMARY_RAIL",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-302): enforce the planner-selected primary rail as the done-gate (non-primary green never clears; repair iterates while primary RED; categorical commit-vs-verify gate). Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-302 primary-rail enforcement + commit-vs-verify gate + repair admission",
  source: "jun-17 proof-driven bench closure (T-302)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── patch-hygiene (QUANTA_BENCH_PATCH_HYGIENE) ───────────────────────────── */
export const patchHygieneSchema: KnobSchema<boolean> = {
  id: "patch-hygiene",
  envKey: "QUANTA_BENCH_PATCH_HYGIENE",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-401): run a typed PatchHygieneReport over the candidate diff (stray added files deny, owner-outside telemetry-only). Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-401 patch hygiene gate (stray-file deny, owner-outside telemetry)",
  source: "jun-17 proof-driven bench closure (T-401)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── no-patch-breaker (QUANTA_BENCH_NO_PATCH_BREAKER) ─────────────────────── */
export const noPatchBreakerSchema: KnobSchema<boolean> = {
  id: "no-patch-breaker",
  envKey: "QUANTA_BENCH_NO_PATCH_BREAKER",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-501): post-localization commit rail (force a best-edit commit when budget is mostly spent with no edit) + explicit no-patch `exhausted` verdict at budget end. Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-501 post-localization commit rail + no-patch exhausted verdict",
  source: "jun-17 proof-driven bench closure (T-501)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── repair-escalation (QUANTA_BENCH_REPAIR_ESCALATION) ───────────────────── */
export const repairEscalationSchema: KnobSchema<boolean> = {
  id: "repair-escalation",
  envKey: "QUANTA_BENCH_REPAIR_ESCALATION",
  kind: "bool",
  default: false,
  describe:
    "Bench (T-601): explicit RepairEscalationDecision (continue-single-owner / collect-more-evidence / branch-search / multi-owner-plan) from typed artifacts, with a closed reason taxonomy; widen to multi-site only on explicit cross-owner evidence. Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe: "T-601 multi-owner escalation decision (closed reason taxonomy)",
  source: "jun-17 proof-driven bench closure (T-601)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}

/* ── spec-fidelity-steer (QUANTA_BENCH_SPEC_FIDELITY_STEER) ───────────────── */
export const specFidelitySteerSchema: KnobSchema<boolean> = {
  id: "spec-fidelity-steer",
  envKey: "QUANTA_BENCH_SPEC_FIDELITY_STEER",
  kind: "bool",
  default: false,
  describe:
    "Bench (gap-B): spec-fidelity steer — when the issue declares a concrete expected output (extractIssueDeclaredExpected), append a minimal-literal-fix steer; fail-closed (no spec ⇒ no steer, so co-change cases are not nudged). Default-OFF ⇒ byte-identical.",
  category: "tool",
  knobDescribe:
    "gap-B spec-fidelity steer (minimal-literal-fix; fires only when issue declares an exact expected output)",
  source: "jun-17 strategy-failure-fix plan (Top-1)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  parse: makeEnablingParse(),
}
