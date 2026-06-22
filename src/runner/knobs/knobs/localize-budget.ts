/**
 * Knob: `localize-budget` — the agentless one-shot localizer's BREADTH dials.
 *
 * The `agentlessLocalize` LLM call (Agentless §3.1) ranks candidate files from a
 * truncated repo tree. Three breadth hyperparameters were hardcoded with NO
 * override path: `topK` (how many files the model is asked to rank, default 5),
 * `maxTreeChars` (repo-tree context budget, default 12000), `maxFiles` (file-tree
 * entries enumerated, default 3000). These are the single most localization-
 * recall-sensitive levers; this knob makes them sweepable for measurement.
 *
 * NOTE: distinct from `localize-phase`, which sets the AGENT's localize-phase
 * TURN budget — a different mechanism. This knob is the one-shot LLM localizer.
 *
 * Value format (any subset, comma-separated): `topk=8,tree=20000,files=4000`.
 * Omitted fields keep their hardcoded default (byte-identical when unset).
 * Domains: topk [1,50], tree [1000,200000], files [100,50000]. APPLY IS A NOOP —
 * consumed out of band (`posture.localizeBudget` → `agentlessLocalize` deps).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export interface LocalizeBudgetValue {
  readonly topK?: number
  readonly maxTreeChars?: number
  readonly maxFiles?: number
}

const FIELD = {
  topk: { key: "topK", min: 1, max: 50 },
  tree: { key: "maxTreeChars", min: 1_000, max: 200_000 },
  files: { key: "maxFiles", min: 100, max: 50_000 },
} as const

const parseLocalizeBudget = (raw: string | undefined): LocalizeBudgetValue | undefined => {
  if (raw === undefined) return undefined
  const out: { topK?: number; maxTreeChars?: number; maxFiles?: number } = {}
  for (const part of raw.split(",")) {
    const [name, val] = part.split("=").map((x) => x.trim())
    const spec = name !== undefined ? FIELD[name as keyof typeof FIELD] : undefined
    if (spec === undefined || val === undefined || !/^\d+$/.test(val)) return undefined
    const n = Number(val)
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) return undefined
    out[spec.key] = n
  }
  // Reject a value that parsed but set nothing (e.g. empty string) — unset is the
  // way to express "defaults", a present-but-empty knob is a misconfiguration.
  return Object.keys(out).length === 0 ? undefined : out
}

const applyLocalizeBudget = (cfg: AgentConfig): AgentConfig => cfg

export const localizeBudgetKnob: Knob<LocalizeBudgetValue> = {
  id: "localize-budget",
  envKey: "QUANTA_BENCH_LOCALIZE_BUDGET",
  category: "hint",
  surfaces: SURFACES,
  parse: parseLocalizeBudget,
  apply: applyLocalizeBudget,
  describe:
    "Bench: agentless one-shot localizer breadth — `topk=N,tree=N,files=N` (defaults 5/12000/3000). The most localization-recall-sensitive levers, was un-sweepable.",
  unit: "spec",
  // category note: "hint" — the agentless localizer is the issue-hint/localization family.
  costMultiplier: 1,
  source:
    "jun-22 magic-number config-extraction (agentless-localize DEFAULT_TOP_K/MAX_TREE_CHARS/MAX_FILES)",
}

registerKnob(localizeBudgetKnob)
