/**
 * Pillar A — authored {@link KnobSchema} declarations for the LAST THIRD of the
 * bench knobs (inventory entries 51–75): the (now @deprecated) verify-select
 * SELECTION family, the cross-surface absorption knobs (hooks / working-state /
 * closeout-guard / multi-voter), and friends. SSOT for derive (see ../derive).
 *
 * Each schema mirrors the EXISTING data verbatim so the derive is provably
 * equal:
 *   - `parse`    mirrors src/runner/knobs/knobs/<id>.ts verbatim,
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT
 *     src/config/knob-inventory/bench.ts entry,
 *   - `surfaces` mirror the live knob's surface set (deriveHome reproduces the
 *     inventory `home` cell from them).
 * The parity test (tests/unit/kernel/derive-parity-c.test.ts) locks this.
 *
 * Additive: not registered, not imported by the live driver.
 *
 * The verify-select-* knobs are @deprecated (jun-27 — the best-of-N veto
 * SELECTION plane was retired in favor of the closure-repair loop). They still
 * carry live inventory entries + registered knobs, so their schemas are authored
 * here. The retirement lifecycle is tracked in ../experiments (the Pillar D
 * registry the ratchet reads), so no `experiment` meta is duplicated here.
 *
 * DERIVE GAPS (excluded — no live registry knob with a `parse` to prove parity
 * against, and/or a structural mismatch derive.ts cannot reproduce):
 *   - QUANTA_BENCH_FIND_REFS (56), QUANTA_BENCH_SIMPLICITY (57),
 *     QUANTA_BENCH_SIBLING (58), QUANTA_BENCH_PROTECT_TESTS (59),
 *     QUANTA_BENCH_EXPOSE_DATASET_VERIFIER (70):
 *       read directly in runner/batch/eval/driver.ts — NO registry knob exists
 *       in runner/knobs/knobs/, so there is no live `parse` to prove parity.
 *   - QUANTA_FULL_REMOTE_AMI (66), QUANTA_FULL_REMOTE_INSTANCE_TYPE (67),
 *     QUANTA_FULL_REMOTE_ONDEMAND (68), QUANTA_FULL_REMOTE_READY_POLLS (69),
 *     QUANTA_BENCH_RESUME (71), QUANTA_BENCH_RESUME_S3_BUCKET (72),
 *     QUANTA_BENCH_CAMPAIGN_ID (73), QUANTA_BENCH_RESUME_IAM_PROFILE (74),
 *     QUANTA_BENCH_INSTANCE_ID (75):
 *       read directly in apps/bench/{cli,remote/...,resume/...}.ts — NO registry
 *       knob exists, so there is no live `parse` to prove parity.
 *   - QUANTA_BENCH_MUST_PASS (65): the live knob's surfaces are
 *     ["bench","agent-batch","agent-interactive"] ⇒ deriveHome ⇒ "runner-knobs",
 *     but the inventory entry records home "bench". deriveInventoryEntry cannot
 *     reproduce the current entry (home mismatch), so it is excluded to keep
 *     parity GREEN. (derive.ts is read-only.)
 *   - QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED (51),
 *     QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL (53): the inventory entry records
 *     `default: undefined` for `kind: "bool"`, but deriveInventoryDefault forces
 *     a bool's off-default to `false` when the schema default is undefined — it
 *     cannot reproduce a bare `undefined` for a bool. (The verify-select bool
 *     entries are the only ones in bench.ts that use `undefined` instead of
 *     `false`.) The enum verify-select knobs below ARE covered (enum passes
 *     `undefined` through verbatim). derive.ts is read-only ⇒ excluded.
 *
 * Already covered by sibling schema files (SKIPPED here):
 *   - QUANTA_BENCH_SELECTOR_MODE (52) → bench-loop.ts
 *   - QUANTA_REPO_MAP (63)            → bench-loop.ts
 */

import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const
/** Cross-surface absorption knobs ⇒ deriveHome ⇒ "runner-knobs". */
const HOOKS_SURFACES: readonly ["cli", "agent-batch"] = ["cli", "agent-batch"] as const
const AGENT_SURFACES: readonly ["cli", "agent-batch", "agent-interactive"] = [
  "cli",
  "agent-batch",
  "agent-interactive",
] as const
const MULTI_VOTER_SURFACES: readonly ["bench", "cli", "agent-batch", "agent-interactive"] = [
  "bench",
  "cli",
  "agent-batch",
  "agent-interactive",
] as const

// DERIVE GAPS: verify-select-proof-required (51) + verify-select-counterfactual
// (53) are bool knobs whose inventory entry records `default: undefined` (not
// `false`). deriveInventoryDefault forces a bool off-default to `false`, so it
// cannot reproduce those entries. Excluded (derive.ts is read-only). The enum
// verify-select knobs (regression / repro) below ARE reproducible.

/* ── verify-select-regression (QUANTA_BENCH_VERIFY_SELECT_REGRESSION) ──────── */
// @deprecated jun-27 — verify-select veto SELECTION plane retired.
type VerifySelectRegressionMode = "discovered" | "gold" | "off"
const parseVerifySelectRegression = (
  raw: string | undefined,
): VerifySelectRegressionMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "discovered" || s === "repo" || s === "native") return "discovered"
  if (s === "gold" || s === "pass-to-pass" || s === "passtoppass") return "gold"
  if (s === "off" || s === "0" || s === "false") return "off"
  return undefined
}
export const verifySelectRegressionSchema: KnobSchema<VerifySelectRegressionMode> = {
  id: "verify-select-regression",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
  kind: "enum",
  domain: { enum: ["discovered", "gold", "off"] },
  default: undefined,
  category: "validation",
  describe:
    "Bench: verify-select regression hard-signal source. Modes: discovered=no-oracle native repo tests, gold=eval-only PASS_TO_PASS, off=ablation. Unset preserves legacy behavior.",
  knobDescribe:
    "Verify-and-select regression source: discovered repo tests, eval-only gold PASS_TO_PASS, or off",
  unit: "mode",
  costMultiplier: 1,
  source: "verify-and-select no-oracle regression gate",
  readSite: "runner/knobs/knobs/verify-select-regression.ts",
  surfaces: BENCH,
  parse: parseVerifySelectRegression,
}

/* ── verify-select-repro (QUANTA_BENCH_VERIFY_SELECT_REPRO) ────────────────── */
// @deprecated jun-27 — verify-select veto SELECTION plane retired.
type VerifySelectReproMode = "hard" | "positive" | "off"
const parseVerifySelectRepro = (raw: string | undefined): VerifySelectReproMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "hard" || s === "gate") return "hard"
  if (s === "positive" || s === "soft") return "positive"
  if (s === "off" || s === "0" || s === "false") return "off"
  return undefined
}
export const verifySelectReproSchema: KnobSchema<VerifySelectReproMode> = {
  id: "verify-select-repro",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  kind: "enum",
  domain: { enum: ["hard", "positive", "off"] },
  default: undefined,
  category: "validation",
  describe:
    "Bench: verify-select generated repro-consensus mode. Modes: hard=legacy gate, positive=soft-only ranking, off=remove signal. Unset preserves legacy behavior.",
  knobDescribe:
    "Verify-and-select generated repro consensus mode: hard gate, positive-only soft signal, or off",
  unit: "mode",
  costMultiplier: 1,
  source: "verify-and-select no-oracle repro consensus demotion",
  readSite: "runner/knobs/knobs/verify-select-repro.ts",
  surfaces: BENCH,
  parse: parseVerifySelectRepro,
}

/* ── hooks (QUANTA_BENCH_HOOKS) — cross-surface ⇒ home "runner-knobs" ──────── */
const HOOKS_TRUTHY = new Set(["1", "on"])
const parseHooks = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return HOOKS_TRUTHY.has(raw) ? true : undefined
}
export const hooksSchema: KnobSchema<true> = {
  id: "hooks",
  envKey: "QUANTA_BENCH_HOOKS",
  kind: "bool",
  // T = true (no falsy member); the inventory off-default `false` is derived by
  // deriveInventoryDefault from kind="bool" + undefined.
  default: undefined,
  category: "agent",
  describe:
    "Pre/post tool-use HookBus wiring (cli + agent-batch surfaces only; bench measurement stays byte-identical). Strict 1/on gate.",
  knobDescribe: "Tool-use hooks (pre/post invocation gates)",
  source: "Cursor hooks absorption",
  readSite: "runner/knobs/knobs/hooks.ts",
  surfaces: HOOKS_SURFACES,
  parse: parseHooks,
}

/* ── working-state (QUANTA_BENCH_WORKING_STATE) — cross-surface ───────────── */
const WORKING_STATE_TRUTHY = new Set(["1", "on", "true"])
const parseWorkingState = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return WORKING_STATE_TRUTHY.has(raw) ? true : undefined
}
export const workingStateSchema: KnobSchema<true> = {
  id: "working-state",
  envKey: "QUANTA_BENCH_WORKING_STATE",
  kind: "bool",
  default: undefined,
  category: "agent",
  describe:
    "L3 working-state scratchpad (Codex absorption). CLI/agent surfaces only; excludes bench measurement.",
  knobDescribe: "L3 working-state scratchpad (Codex absorption)",
  source: "Codex absorption",
  readSite: "runner/knobs/knobs/working-state.ts",
  surfaces: AGENT_SURFACES,
  parse: parseWorkingState,
}

/* ── closeout-guard (QUANTA_BENCH_CLOSEOUT) — cross-surface, kind "enum" ───── */
export interface CloseoutGuardValue {
  readonly fourRule: boolean
}
const CLOSEOUT_TRUTHY = new Set(["1", "on", "true"])
const parseCloseoutGuard = (raw: string | undefined): CloseoutGuardValue | undefined => {
  if (raw === undefined) return undefined
  if (raw === "4rule") return { fourRule: true }
  return CLOSEOUT_TRUTHY.has(raw) ? { fourRule: false } : undefined
}
export const closeoutGuardSchema: KnobSchema<CloseoutGuardValue> = {
  id: "closeout-guard",
  envKey: "QUANTA_BENCH_CLOSEOUT",
  kind: "enum",
  default: undefined,
  category: "verify",
  describe:
    "Closeout reminder at finish (ADR-0017). 1/on/true ⇒ enable; 4rule ⇒ Codex defended-claim scaffold. CLI/agent surfaces.",
  knobDescribe: "Closeout reminder (final-claim verification)",
  source: "ADR-0017",
  readSite: "runner/knobs/knobs/closeout-guard.ts",
  surfaces: AGENT_SURFACES,
  parse: parseCloseoutGuard,
}

/* ── multi-voter (QUANTA_MULTI_VOTER) — cross-surface, kind "string" ───────── */
export interface MultiVoterValue {
  readonly voters: number
  readonly quorum?: number
}
const parseMultiVoter = (raw: string | undefined): MultiVoterValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  const parts = s.split(":")
  if (parts.length > 2) return undefined
  const votersRaw = (parts[0] ?? "").trim()
  if (!/^\d+$/.test(votersRaw)) return undefined
  const voters = Number(votersRaw)
  if (!Number.isInteger(voters) || voters < 1) return undefined
  if (parts.length === 1) return { voters }
  const quorumRaw = (parts[1] ?? "").trim()
  if (quorumRaw === "") return undefined
  if (!/^\d*\.?\d+$/.test(quorumRaw)) return undefined
  const quorum = Number(quorumRaw)
  if (!Number.isFinite(quorum) || quorum <= 0 || quorum > 1) return undefined
  if (quorum > voters) return undefined
  return { voters, quorum }
}
export const multiVoterSchema: KnobSchema<MultiVoterValue> = {
  id: "multi-voter",
  envKey: "QUANTA_MULTI_VOTER",
  kind: "string",
  default: undefined,
  category: "verify",
  describe:
    "Adversarial multi-voter verification quorum. Format <voters> or <voters>:<quorum>; requires branch-search. Default-OFF.",
  knobDescribe:
    "Adversarial multi-voter verification — N refute-biased voters per candidate (ADR-0433)",
  costMultiplier: 3,
  source: "ADR-0433 / Agentless §4.2 sample-and-vote",
  readSite: "runner/knobs/knobs/multi-voter.ts",
  surfaces: MULTI_VOTER_SURFACES,
  parse: parseMultiVoter,
}
