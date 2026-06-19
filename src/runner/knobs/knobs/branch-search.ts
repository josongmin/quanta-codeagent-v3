/**
 * Knob: `branch-search` — Agentless N-best speculative branch search
 * (ADR-0084 / Agentless paper).
 *
 * Default-OFF. Migrated verbatim from `parseBenchBranchSearchK` in
 * `src/runner/batch/eval/driver.ts`. Apply builds the canonical bench
 * `BranchSearchConfig` block (verifierKinds=["tsc"], timeout=60s,
 * isolation="tmpdir" — bench sandboxes from `createSandbox` may not be git
 * repos).
 *
 * Domain (ACTIVE):
 *   - integer K in [2, 8] ⇒ `BranchSearchConfig` with `defaultN=K`.
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / `"0"` / `"1"` (K=1 ≡ baseline — wiring would only add overhead)
 *   - negative / non-integer / NaN / garbage / empty / whitespace
 *   - K > 8 (matches slice's `tool.ts` zod `.min(2).max(8)`)
 *
 * `costMultiplier: K` — explicit matrix budget contract.
 *
 * Conflicts with `localize-phase` — both strengthen explore.
 */

import type { AgentConfig, BranchSearchConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const BENCH_BRANCH_TIMEOUT_MS = 60_000

interface BranchSearchValue {
  readonly defaultN: number
  readonly config: BranchSearchConfig
}

const parseBranchSearch = (raw: string | undefined): BranchSearchValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  // Reject internal whitespace and anything that isn't an optional sign + digits.
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

const applyBranchSearch = (
  cfg: AgentConfig,
  value: BranchSearchValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, branchSearch: value.config }
}

export const branchSearchKnob: Knob<BranchSearchValue> = {
  id: "branch-search",
  envKey: "QUANTA_BENCH_BRANCH_SEARCH",
  category: "agent",
  surfaces: SURFACES,
  parse: parseBranchSearch,
  apply: applyBranchSearch,
  describe: "Agentless N-best speculative branch search (K candidates, ~K× cost)",
  unit: "candidates",
  conflicts: ["localize-phase"],
  // The cost multiplier scales with K — the registry uses the value from
  // `parse` so this static value documents the worst case (max K=8).
  costMultiplier: 8,
  source: "ADR-0084 / Agentless paper",
}

registerKnob(branchSearchKnob)
