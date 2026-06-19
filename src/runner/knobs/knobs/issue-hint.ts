/**
 * Knob: `issue-hint` — issue-text hint mode (Agentless paper §3.1
 * localization +5pp).
 *
 * Default-OFF. Migrated verbatim from the `QUANTA_BENCH_ISSUE_HINT` accept-
 * list in `src/runner/batch/eval/driver.ts` `benchOptIns()`. Tri-state:
 *
 *   - `"agentless"` ⇒ `"agentless"` (LLM-driven Stage-1 localization)
 *   - `"1"` / `"on"` ⇒ `"regex"` (legacy verbatim-evidence extractor)
 *   - anything else (absent / `"true"` / `"yes"` / garbage / empty) ⇒
 *     `undefined`
 *
 * APPLY IS A NOOP — `cfg` is returned unchanged. The hint mode is consumed by
 * the bench driver OUT OF BAND (`prepareIssueHint`, `composeIssueHint`,
 * `extractIssueHint`) and threaded as a `precomputedHint` string into
 * `buildConfig`. It is NOT a field on `AgentConfig`. Registry knob status is
 * still required so the matrix / cost-multiplier / surface gating machinery
 * sees it.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export type IssueHintMode = "agentless" | "regex"

const parseIssueHint = (raw: string | undefined): IssueHintMode | undefined => {
  if (raw === undefined) return undefined
  if (raw === "agentless") return "agentless"
  if (raw === "1" || raw === "on") return "regex"
  return undefined
}

const applyIssueHint = (
  cfg: AgentConfig,
  _value: IssueHintMode,
  _ctx: { surface: Surface },
): AgentConfig => {
  // Intentional noop — issue-hint is consumed by the bench driver out of band
  // (prepareIssueHint -> precomputedHint string), not stored on AgentConfig.
  return cfg
}

export const issueHintKnob: Knob<IssueHintMode> = {
  id: "issue-hint",
  envKey: "QUANTA_BENCH_ISSUE_HINT",
  category: "hint",
  surfaces: SURFACES,
  parse: parseIssueHint,
  apply: applyIssueHint,
  describe: "Issue verbatim/agentless localization hint",
  unit: "mode",
  source: "Agentless paper §3.1",
}

registerKnob(issueHintKnob)
