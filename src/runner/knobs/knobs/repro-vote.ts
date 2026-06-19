/**
 * Knob: `repro-vote` — K-of-N RESOLVED gate at validation time (jun-19).
 *
 * The repro-test SET that reproduced the bug on the un-patched tree is re-run in
 * the PATCHED sandbox and majority-voted ({@link voteResolved}); a strict
 * majority of "Issue resolved" clears the repair round. Removes the measured
 * false-NEGATIVE oracle failure: one brittle reproducer can no longer reject a
 * correct patch and force repair churn (46→131 turns re-deriving the same fix).
 *
 * Couples to `repro-test` — the vote is meaningless without a reproducing set,
 * so the driver only arms it when repro-test produced reproducing sources;
 * empty set ⇒ byte-identical legacy gate.
 *
 * Default-OFF ⇒ byte-identical (legacy single-sentinel / exit-code validator).
 * APPLY IS A NOOP — consumed out of band by the bench driver (repair-validate
 * composition), not stored on AgentConfig.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseReproVote = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}

const applyReproVote = (cfg: AgentConfig): AgentConfig => cfg

export const reproVoteKnob: Knob<boolean> = {
  id: "repro-vote",
  envKey: "QUANTA_BENCH_REPRO_VOTE",
  category: "validation",
  surfaces: SURFACES,
  parse: parseReproVote,
  apply: applyReproVote,
  describe:
    "K-of-N resolved gate: re-run the reproducing repro set on the patched tree and majority-vote 'Issue resolved' (removes the false-NEGATIVE single-script oracle)",
  source: "jun-19 repro oracle quality (Agentless §3.3.1 resolved-side majority vote)",
}

registerKnob(reproVoteKnob)
