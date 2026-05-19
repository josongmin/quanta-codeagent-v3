/**
 * `--dry-run` plan: load + count + preview WITHOUT building an LLM or running
 * anything. Pure & dependency-free (no `@/llm`, no agent) so it is directly
 * unit-testable and importing it never triggers the CLI `main()`.
 */
import type { Instance } from "./types"

export interface DryRunPlan {
  corpusRoot: string
  total: number
  selected: number
  n: number
  limit: number | null
  pythonHarness: boolean
  /** First few instance ids — a cheap preview of what a real run would do. */
  sample: string[]
}

/** Build the plan from an already-loaded corpus. Never runs an LLM. */
export const buildDryRunPlan = (
  corpusRoot: string,
  instances: Instance[],
  cfg: { n: number; limit: number | null; pythonHarness: boolean },
): DryRunPlan => {
  const selected = cfg.limit === null ? instances : instances.slice(0, cfg.limit)
  return {
    corpusRoot: corpusRoot || "(unset)",
    total: instances.length,
    selected: selected.length,
    n: cfg.n,
    limit: cfg.limit,
    pythonHarness: cfg.pythonHarness,
    sample: selected.slice(0, 10).map((i) => i.id),
  }
}

/** Render a DryRunPlan as the lines the CLI prints (also asserted by tests). */
export const formatDryRunPlan = (plan: DryRunPlan): string[] => [
  "dry-run plan (NO LLM will be called)",
  `  corpus: ${plan.corpusRoot}`,
  `  instances: ${plan.total} loaded, ${plan.selected} selected${
    plan.limit === null ? "" : ` (--limit ${plan.limit})`
  }`,
  `  best-of-n: ${plan.n}`,
  `  verifier: ${plan.pythonHarness ? "official python swebench harness" : "local testCmd"}`,
  `  sample ids: ${plan.sample.join(", ") || "(none)"}`,
]
