/**
 * Pillar A — authored {@link KnobSchema} declarations for the localize / loop /
 * selection / context family of bench knobs. SSOT for derive (see ../derive).
 *
 * Each schema mirrors the EXISTING data verbatim so the derive is provably
 * equal: `parse` from src/runner/knobs/knobs/<id>.ts; `describe`/`default`/
 * `kind`/`readSite`/`envKey`/`home`-via-surfaces from the CURRENT
 * src/config/knob-inventory/bench.ts entry.
 *
 * Additive: not registered, not imported by the live driver.
 */

import { isTruthyToken } from "@/shared"
import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const

/* ── localize-phase (QUANTA_BENCH_LOCALIZE_PHASE) ─────────────────────────── */
interface LocalizePhaseValue {
  readonly phase1Turns: number
}
const parseLocalizePhase = (raw: string | undefined): LocalizePhaseValue | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n === 0) return { phase1Turns: 0 }
  if (n < 0) return undefined
  if (n > 20) return undefined
  return { phase1Turns: n }
}
export const localizePhaseSchema: KnobSchema<LocalizePhaseValue> = {
  id: "localize-phase",
  envKey: "QUANTA_BENCH_LOCALIZE_PHASE",
  kind: "string",
  category: "agent",
  default: undefined,
  describe: "Bench: localization phase turns.",
  knobDescribe: "Block mutating tools during first N turns; force localize-first (Agentless §3.1)",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseLocalizePhase,
  unit: "turns",
  source: "Agentless absorption",
}

/* ── retry-transient (QUANTA_BENCH_RETRY_TRANSIENT) ───────────────────────── */
const parseRetryTransient = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 5) return undefined
  return n
}
export const retryTransientSchema: KnobSchema<number> = {
  id: "retry-transient",
  envKey: "QUANTA_BENCH_RETRY_TRANSIENT",
  kind: "int",
  domain: { range: [1, 5] },
  default: undefined,
  describe: "Bench: transient retry cap.",
  knobDescribe:
    "Retry cap for transient failures (empty-patch / infra-fail; real-fail never retried)",
  readSite: "runner/batch/eval/retry-policy.ts",
  surfaces: BENCH,
  parse: parseRetryTransient,
  unit: "retries",
  source: "measurement-stability wrapper",
}

/* ── selector-mode (QUANTA_BENCH_SELECTOR_MODE) ───────────────────────────── */
type SelectorModeKnob = "clean" | "research"
const parseSelectorMode = (raw: string | undefined): SelectorModeKnob | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "clean") return "clean"
  if (s === "research") return "research"
  return undefined
}
export const selectorModeSchema: KnobSchema<SelectorModeKnob> = {
  id: "selector-mode",
  envKey: "QUANTA_BENCH_SELECTOR_MODE",
  kind: "enum",
  domain: { enum: ["clean", "research"] },
  default: undefined,
  describe:
    "Bench: selector authority mode. clean=only executable/structural hard gates decide selection; research=legacy heuristic gates additionally allowed. Default (unset)=research.",
  knobDescribe:
    "Selector authority mode: clean (only executable/structural hard gates) vs research (legacy heuristic gates allowed)",
  readSite: "runner/knobs/knobs/selector-mode.ts",
  surfaces: BENCH,
  parse: parseSelectorMode,
  costMultiplier: 1,
  unit: "mode",
  source: "jun-21 heuristic authority cleanup",
}

/* ── repo-map (QUANTA_REPO_MAP) — cross-surface ⇒ home "runner-knobs" ─────── */
interface RepoMapValue {
  readonly enabled: true
}
const parseRepoMap = (raw: string | undefined): RepoMapValue | undefined =>
  isTruthyToken(raw) ? { enabled: true } : undefined
export const repoMapSchema: KnobSchema<RepoMapValue> = {
  id: "repo-map",
  envKey: "QUANTA_REPO_MAP",
  kind: "bool",
  category: "hint",
  // T = RepoMapValue (no falsy member); the inventory off-default `false` is
  // derived by deriveInventoryDefault from kind="bool" + undefined.
  default: undefined,
  describe:
    "Bounded repo-map turn-0 injection (cli/agent/bench runner knob). Default-OFF; set ⇒ config.repoMap turns on with fixed caps.",
  knobDescribe: "Inject a bounded repo-map tree into the turn-0 env block (one-time orientation)",
  costMultiplier: 1,
  source: "RFC jun-6 §4 / Codex realtime-startup-context mirror",
  readSite: "runner/knobs/knobs/repo-map.ts",
  // Cross-surface ⇒ deriveHome ⇒ "runner-knobs" (matches bench.ts).
  surfaces: ["cli", "agent-batch", "agent-interactive", "bench"],
  parse: parseRepoMap,
}
