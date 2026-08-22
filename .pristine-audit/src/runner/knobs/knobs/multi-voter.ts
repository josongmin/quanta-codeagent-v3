/**
 * Knob: `multi-voter` — adversarial multi-voter verification (ADR-0433).
 *
 * Default-OFF. Wires the `voterQuorum` block into the branch-search caller
 * config so `branch_search` builds N refute-biased voters per candidate and
 * folds ONE additive `llm_voter_quorum` signal into scoring. Absent ⇒ no voter
 * signal exists, so the branch-search score is byte-identical to pre-ADR-0433.
 *
 * Env `QUANTA_MULTI_VOTER`:
 *   - `"<voters>"`            ⇒ N voters, strict-majority quorum (refute bias).
 *   - `"<voters>:<quorum>"`   ⇒ N voters, explicit pass-fraction `>= quorum`.
 *
 * Domain (ACTIVE):
 *   - integer voters ≥ 1.
 *   - optional quorum in (0, 1]; MUST satisfy `quorum ≤ voters` (a quorum
 *     fraction cannot demand more passes than there are voters — i.e.
 *     `quorum * voters ≤ voters` always holds for `quorum ≤ 1`, so the real
 *     guard is `quorum ≤ 1`; we ALSO reject `quorum > voters` defensively for
 *     a caller who passes a count-shaped quorum by mistake).
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / empty / whitespace
 *   - voters `< 1`, non-integer, NaN, garbage
 *   - quorum `<= 0`, `> 1`, `> voters`, non-numeric
 *   - more than one `:` separator
 *
 * Quorum is a CLEAN QUORUM RULE, not a tuned threshold: absent ⇒ the
 * deterministic strict-majority default in `runMultiVoter`; present ⇒ the exact
 * `>=` fraction the caller specifies. No heuristics, no scaling.
 *
 * Apply: MERGES `voterQuorum` into `cfg.branchSearch` (the branch-search knob /
 * preset must have set `branchSearch` first — this knob `requires`
 * `branch-search`). When `cfg.branchSearch` is unset the apply is a no-op
 * (defensive — the `requires` resolver guard normally prevents this).
 */

import type { AgentConfig } from "@/agent"
import { multiVoterSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

interface MultiVoterValue {
  readonly voters: number
  readonly quorum?: number
}

/** Non-NOOP apply — merges `voterQuorum` into `cfg.branchSearch`. Bound into the
 *  central registrar (`APPLY_BINDINGS` + requires) AND used to derive the
 *  back-compat knob export; ONE definition so the derived knob is byte-identical. */
export const applyMultiVoter = (cfg: AgentConfig, value: MultiVoterValue): AgentConfig => {
  // No-op when branch-search is not configured — the `requires` resolver guard
  // normally prevents this, but a defensive no-op keeps `apply` pure + total.
  const bs = cfg.branchSearch
  if (bs === undefined) return cfg
  return {
    ...cfg,
    branchSearch: {
      ...bs,
      voterQuorum:
        value.quorum !== undefined
          ? { voters: value.voters, quorum: value.quorum }
          : { voters: value.voters },
    },
  }
}

// DERIVED from the schema SSOT (data) + the runner-side apply + relationship
// (`requires: branch-search`) bindings. Registration is CENTRAL
// (`registerBenchKnobs`); no self-register here.
export const multiVoterKnob = deriveKnob(multiVoterSchema, applyMultiVoter, {
  requires: ["branch-search"],
})
