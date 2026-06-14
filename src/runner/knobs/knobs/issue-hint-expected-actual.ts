/**
 * Knob: `issue-hint-expected-actual` — opt-in expected/actual extraction that
 * complements the `issue-hint` localization signal (Agentless paper §3.1).
 *
 * Default-OFF. Migrated from the `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL`
 * accept-list in `benchOptIns()`. Strict truthy gate: only `"1"` / `"on"`
 * parse to `true`; anything else ⇒ `undefined`. No heuristics.
 *
 * APPLY IS A NOOP — like `issue-hint`, the value is consumed out of band by
 * the bench driver (`extractIssueHint(..., { withExpectedActual })`), not
 * stored on `AgentConfig`. Registry status is required so the resolver /
 * report / preset layer see it.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const TRUTHY = new Set(["1", "on"])

const parseExpectedActual = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? true : undefined
}

const applyExpectedActual = (cfg: AgentConfig): AgentConfig => cfg

export const issueHintExpectedActualKnob: Knob<true> = {
  id: "issue-hint-expected-actual",
  envKey: "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  category: "hint",
  surfaces: SURFACES,
  parse: parseExpectedActual,
  apply: applyExpectedActual,
  describe: "Extract structured expected/actual evidence to ground the issue-hint signal",
  source: "Agentless paper §3.1",
}

registerKnob(issueHintExpectedActualKnob)
