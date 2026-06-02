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
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench", "cli", "agent-batch", "agent-interactive"]

interface MultiVoterValue {
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
  // Plain decimal only — reject signs, exponents, NaN/Infinity literals.
  if (!/^\d*\.?\d+$/.test(quorumRaw)) return undefined
  const quorum = Number(quorumRaw)
  if (!Number.isFinite(quorum) || quorum <= 0 || quorum > 1) return undefined
  // Defensive: a fraction quorum can never exceed the voter count for
  // `quorum ≤ 1`, but reject a mistaken count-shaped quorum explicitly.
  if (quorum > voters) return undefined
  return { voters, quorum }
}

const applyMultiVoter = (cfg: AgentConfig, value: MultiVoterValue): AgentConfig => {
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

export const multiVoterKnob: Knob<MultiVoterValue> = {
  id: "multi-voter",
  envKey: "QUANTA_MULTI_VOTER",
  category: "verify",
  surfaces: SURFACES,
  parse: parseMultiVoter,
  apply: applyMultiVoter,
  describe:
    "Adversarial multi-voter verification — N refute-biased voters per candidate (ADR-0433)",
  // Requires branch-search to be active: the voter signal is folded into the
  // branch-search scorer; without `cfg.branchSearch` there is no caller.
  requires: ["branch-search"],
  // Cost scales with voter count — one extra LLM round-trip per voter per
  // candidate. Static value documents a typical fan-out (3); the registry uses
  // the parsed value for precise budgeting.
  costMultiplier: 3,
  source: "ADR-0433 / Agentless §4.2 sample-and-vote",
}

registerKnob(multiVoterKnob)
