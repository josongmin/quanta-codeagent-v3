/**
 * Pillar A — authored {@link KnobSchema} declarations for the GAP-1 family of
 * bench knobs (LSP-nav tier/steer, skills, must-pass, and the deprecated
 * verify-select selection-plane toggles). SSOT for derive (see ../derive).
 *
 * These nine knobs are the ones whose CURRENT inventory shape needs an ESCAPE
 * HATCH the plain kind-convention can't infer:
 *   - `inventoryDefault: undefined` — bool knobs the inventory records as
 *     `undefined` (a tri-state OFF-switch), NOT the `false` the bool convention
 *     would derive. The key MUST be PRESENT (derive checks `"inventoryDefault"
 *     in schema`), hence the explicit `undefined` value.
 *   - `inventoryHome: "bench"` — cross-surface knobs (lsp / skills / must-pass
 *     apply to cli+agent surfaces in the live knob) that the current inventory
 *     nonetheless files under the `bench` home rather than the surface-derived
 *     `runner-knobs`.
 *
 * Source-of-truth fidelity (matches tests/unit/kernel/derive-parity.test.ts):
 *   - `parse`    reuses the live src/runner/knobs/knobs/<id>.ts parser verbatim
 *                (imported, not re-implemented — same reference, identical
 *                semantics),
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT
 *     src/config/knob-inventory/bench.ts entry,
 *   - `surfaces` mirror the live knob (so the derived home would diverge without
 *     the `inventoryHome` pin — which is exactly what proves that override live).
 *
 * Additive: not registered, not imported by the live driver.
 */

import type { KnobSchema } from "../contracts"

export interface MustPassValue {
  readonly mustPass: boolean
  readonly maxTrips?: number
  /** `"sticky"` variant — sticky-red outcome gate (see verify-guard.ts). */
  readonly stickyRed?: boolean
}

/**
 * Inline parse replicas — REPLICATED VERBATIM from the live
 * src/runner/knobs/knobs/<id>.ts parsers. Config (this leaf) cannot import
 * @/runner, so the parse logic is copied here, not referenced. The parse-parity
 * test (tests/unit/kernel/derive-parity-gap-1.test.ts) asserts each replica is
 * extensionally equal to the live knob's parse over a probe battery, so any
 * divergence is caught.
 */

/** lsp / lsp-cheap / lsp-steer — identical tri-state boolean parser. */
const parseLspBool = (raw: string | undefined): boolean | undefined =>
  raw === "1" || raw === "on" || raw === "true"
    ? true
    : raw === "0" || raw === "off" || raw === "false"
      ? false
      : undefined

/** skills — strict truthy set {"1","on","true"} ⇒ true, else undefined. */
const SKILLS_TRUTHY = new Set(["1", "on", "true"])
const parseSkills = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return SKILLS_TRUTHY.has(raw) ? true : undefined
}

/** must-pass — strict enum parse (off / 1|on|strict / 2 / 3 / sticky). */
const parseMustPass = (raw: string | undefined): MustPassValue | undefined => {
  if (raw === undefined) return undefined
  if (raw === "off") return { mustPass: false }
  if (raw === "1" || raw === "on" || raw === "strict") return { mustPass: true, maxTrips: 2 }
  if (raw === "2") return { mustPass: true, maxTrips: 2 }
  if (raw === "3") return { mustPass: true, maxTrips: 3 }
  if (raw === "sticky") return { mustPass: true, maxTrips: 2, stickyRed: true }
  return undefined
}

/** verify-select-counterfactual — tri-state 1/true/on→true, 0/false/off→false. */
const parseVerifySelectCounterfactual = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  if (raw === "1" || raw === "true" || raw === "on") return true
  if (raw === "0" || raw === "false" || raw === "off") return false
  return undefined
}

/** verify-select-early-accept — strict 1/true/on→true, else undefined. */
const parseVerifySelectEarlyAccept = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "true" || raw === "on" ? true : undefined
}

/** verify-select-proof-required — trimmed/lowercased tri-state. */
const parseVerifySelectProofRequired = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "1" || s === "true" || s === "on") return true
  if (s === "0" || s === "false" || s === "off") return false
  return undefined
}

/** verify-select-risk-gate — strict 1/true/on→true, else undefined. */
const parseVerifySelectRiskGate = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "true" || raw === "on" ? true : undefined
}

const BENCH_ONLY: readonly ["bench"] = ["bench"] as const
/** Cross-surface tuple (lsp / skills / must-pass live knobs). */
const CROSS: readonly ["bench", "agent-batch", "agent-interactive"] = [
  "bench",
  "agent-batch",
  "agent-interactive",
] as const

/* ── lsp (QUANTA_BENCH_LSP) — cross-surface live, filed under home "bench" ─── */
export const lspSchema: KnobSchema<boolean> = {
  id: "lsp",
  envKey: "QUANTA_BENCH_LSP",
  kind: "bool",
  // bool + false ⇒ deriveInventoryDefault yields false (matches bench.ts).
  default: false,
  describe:
    "Bench: LSP-nav tools gate with explicit boolean override semantics. `1`/`on`/`true` enable; `0`/`off`/`false` disable; unset leaves preset/default behavior. An explicit off beats a preset `lsp:1`; legacy `QUANTA_LSP_TOOLS=full` is consulted only when this knob is unset.",
  readSite: "runner/knobs/knobs/lsp.ts",
  surfaces: CROSS,
  parse: parseLspBool,
  category: "tool",
  knobDescribe: "LSP nav tools (8 tools — ADR-0015)",
  costMultiplier: 1,
  source: "ADR-0015",
  // Cross-surface ⇒ deriveHome would give "runner-knobs"; pin "bench".
  inventoryHome: "bench",
}

/* ── lsp-cheap (QUANTA_BENCH_LSP_CHEAP) — bench-only, bool default undefined ── */
export const lspCheapSchema: KnobSchema<boolean> = {
  id: "lsp-cheap",
  envKey: "QUANTA_BENCH_LSP_CHEAP",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: register the CHEAP/index-backed LSP-nav tier (definition/hover/type_definition/document_symbol/workspace_symbol/incoming·outgoing_calls/code_action/format/signature_help) WITHOUT the measured-intractable lsp_references/lsp_implementation. DEFAULT-ON gated-flip; explicit 0/off/false suppresses for a byte-identical legacy (empty nav) surface (A/B baseline). Ignored when the full QUANTA_BENCH_LSP / QUANTA_LSP_TOOLS=full is on (that supersets this tier).",
  readSite: "runner/knobs/knobs/lsp-cheap.ts",
  surfaces: BENCH_ONLY,
  parse: parseLspBool,
  category: "tool",
  knobDescribe: "register the cheap/index-backed LSP-nav tier (no references/implementation)",
  costMultiplier: 1,
  source: "REPORT-jun26-tool-impl-vs-frontier §4.5",
  // bool kind would derive `false`; the inventory records `undefined`. Pin it.
  inventoryDefault: undefined,
}

/* ── lsp-steer (QUANTA_BENCH_LSP_STEER) — bench-only, bool default undefined ── */
export const lspSteerSchema: KnobSchema<boolean> = {
  id: "lsp-steer",
  envKey: "QUANTA_BENCH_LSP_STEER",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: append LSP-nav grounding steer to localize-phase block. DEFAULT-ON when nav is on; explicit 0/off/false suppresses (A/B cold arm). Pointless without QUANTA_BENCH_LSP.",
  readSite: "runner/knobs/knobs/lsp-steer.ts",
  surfaces: BENCH_ONLY,
  parse: parseLspBool,
  category: "tool",
  knobDescribe: "append LSP-nav grounding nudge to the localize-phase block message",
  costMultiplier: 1,
  source: "jun-17 measured LSP-nav usage gap",
  inventoryDefault: undefined,
}

/* ── skills (QUANTA_BENCH_SKILLS) — cross-surface live, filed under "bench" ── */
export const skillsSchema: KnobSchema<true> = {
  id: "skills",
  envKey: "QUANTA_BENCH_SKILLS",
  kind: "bool",
  // T = `true` (no falsy member); bool + undefined ⇒ deriveInventoryDefault
  // yields `false`, matching the bench.ts `false` cell (repo-map pattern).
  default: undefined,
  describe: "Bench: system skills bundling.",
  readSite: "runner/knobs/knobs/skills.ts",
  surfaces: CROSS,
  parse: parseSkills,
  category: "agent",
  knobDescribe: "Wire the Tier-1 skill system (bundled-only; Skill / ToolSearch tools)",
  source: "ADR-0045",
  inventoryHome: "bench",
}

/* ── must-pass (QUANTA_BENCH_MUST_PASS) — cross-surface live, home "bench" ──── */
export const mustPassSchema: KnobSchema<MustPassValue> = {
  id: "must-pass",
  envKey: "QUANTA_BENCH_MUST_PASS",
  kind: "enum",
  domain: { enum: ["off", "1", "on", "strict", "2", "3", "sticky"] },
  default: undefined,
  describe:
    "Bench: verify-guard outcome gate override (off / 1|on|strict / 2 / 3 maxTrips / sticky). `sticky` = maxTrips:2 + sticky-red (a failing verify is not cleared by a later green run of a different command). Unset ⇒ driver swebench auto-on posture stands.",
  readSite: "runner/knobs/knobs/must-pass.ts",
  surfaces: CROSS,
  parse: parseMustPass,
  category: "verify",
  knobDescribe: "verify-guard outcome-gate (must pass, not just presence)",
  source: "RCA 2026-05-25 sanity",
  // Cross-surface ⇒ deriveHome would give "runner-knobs"; pin "bench".
  inventoryHome: "bench",
}

/* ── verify-select-counterfactual — bench-only, bool default undefined ──────── */
export const verifySelectCounterfactualSchema: KnobSchema<boolean> = {
  id: "verify-select-counterfactual",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: verify-select counterfactual candidate — cand1 from a counterfactual minimal-alternative seed bound to structural contracts. Off by default.",
  readSite: "runner/knobs/knobs/verify-select-counterfactual.ts",
  surfaces: BENCH_ONLY,
  parse: parseVerifySelectCounterfactual,
  knobDescribe:
    "Verify-and-select counterfactual candidate: when cand0 trips structural risk, generate cand1 from a counterfactual minimal-alternative seed and bind it to structural contracts",
  costMultiplier: 1,
  unit: "toggle",
  source: "jun-21 counterfactual select",
  inventoryDefault: undefined,
}

/* ── verify-select-early-accept — bench-only, bool default undefined ────────── */
export const verifySelectEarlyAcceptSchema: KnobSchema<true> = {
  id: "verify-select-early-accept",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: progressive verify-select cost guard. Stop after first clean owner-scoped candidate with explicit hard-positive regression/resolved authority; fail-open nulls never stop early. Default-OFF.",
  readSite: "runner/knobs/knobs/verify-select-early-accept.ts",
  surfaces: BENCH_ONLY,
  parse: parseVerifySelectEarlyAccept,
  knobDescribe:
    "Verify-and-select: stop after first clean owner-scoped candidate with explicit hard-positive authority",
  costMultiplier: 1,
  unit: "toggle",
  source: "verify-and-select Phase 2 (jun-20) — progressive early accept",
  inventoryDefault: undefined,
}

/* ── verify-select-proof-required — bench-only, bool default undefined ──────── */
export const verifySelectProofRequiredSchema: KnobSchema<boolean> = {
  id: "verify-select-proof-required",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: require positive executed public proof before verify-select may submit a candidate. Static contracts and keep-green evidence remain ranking/safety signals only. Default-OFF.",
  readSite: "runner/knobs/knobs/verify-select-proof-required.ts",
  surfaces: BENCH_ONLY,
  parse: parseVerifySelectProofRequired,
  knobDescribe:
    "Require positive executed public proof before verify-select may submit a candidate",
  costMultiplier: 1,
  source: "jun-22 v4 proof-clean submit gate",
  inventoryDefault: undefined,
}

/* ── verify-select-risk-gate — bench-only, bool default undefined ───────────── */
export const verifySelectRiskGateSchema: KnobSchema<true> = {
  id: "verify-select-risk-gate",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: adaptive verify-select cost guard. Candidate 0 submits immediately when static public-issue/patch risk is low; risky patches expand to the remaining candidate budget. Default-OFF.",
  readSite: "runner/knobs/knobs/verify-select-risk-gate.ts",
  surfaces: BENCH_ONLY,
  parse: parseVerifySelectRiskGate,
  knobDescribe:
    "Verify-and-select: generate candidate 0 first, expand to N only when static risk triggers",
  costMultiplier: 1,
  unit: "toggle",
  source: "jun-21 adaptive thin-strict selector gate",
  inventoryDefault: undefined,
}
