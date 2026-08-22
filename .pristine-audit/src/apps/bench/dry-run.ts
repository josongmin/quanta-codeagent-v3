/**
 * `--dry-run` plan: load + count + preview WITHOUT building an LLM or running
 * anything. Pure & dependency-free (no `@/llm`, no agent) so it is directly
 * unit-testable and importing it never triggers the CLI `main()`.
 */
import type { Instance } from "./types"

export interface DryRunPlan {
  sourceLabel: "corpus" | "dataset"
  sourcePath: string
  total: number
  selected: number
  n: number
  limit: number | null
  pythonHarness: boolean
  verifierLabel?: string
  preset: string
  /** The composition root's RESOLVED dataset family (LOW-10). Present only for
   *  the dataset path — the custom-corpus mode has no family axis, so its plan
   *  is byte-identical to before. It is stated explicitly because `live` and
   *  `verified` are otherwise INDISTINGUISHABLE in this plan (same parse, same
   *  preset, same verifier label), so a mis-resolved `--dataset-family live`
   *  looked exactly like a correct Verified run. */
  datasetFamily?: string
  /** First few instance ids — a cheap preview of what a real run would do. */
  sample: string[]
}

const buildPlan = (
  sourceLabel: DryRunPlan["sourceLabel"],
  sourcePath: string,
  ids: readonly string[],
  cfg: {
    n: number
    limit: number | null
    pythonHarness: boolean
    verifierLabel?: string
    preset: string
    datasetFamily?: string
  },
): DryRunPlan => {
  const selected = cfg.limit === null ? ids : ids.slice(0, cfg.limit)
  return {
    sourceLabel,
    sourcePath: sourcePath || "(unset)",
    total: ids.length,
    selected: selected.length,
    n: cfg.n,
    limit: cfg.limit,
    pythonHarness: cfg.pythonHarness,
    ...(cfg.verifierLabel !== undefined ? { verifierLabel: cfg.verifierLabel } : {}),
    preset: cfg.preset,
    ...(cfg.datasetFamily !== undefined ? { datasetFamily: cfg.datasetFamily } : {}),
    sample: selected.slice(0, 10),
  }
}

/** Build the plan from an already-loaded corpus. Never runs an LLM. */
export const buildDryRunPlan = (
  corpusRoot: string,
  instances: Instance[],
  cfg: {
    n: number
    limit: number | null
    pythonHarness: boolean
    verifierLabel?: string
    preset: string
    datasetFamily?: string
  },
): DryRunPlan => {
  return buildPlan(
    "corpus",
    corpusRoot,
    instances.map((i) => i.id),
    cfg,
  )
}

/** Official-dataset variant of the dry-run plan.
 *
 *  PMX-02: takes the NARROW identity role view rather than `SwebenchTask[]`. The
 *  plan only ever needed instance ids, and typing it that way means the dry-run
 *  surface cannot regain a dependency on the broad upstream row. */
export const buildDatasetDryRunPlan = (
  datasetFile: string,
  tasks: readonly { readonly instanceId: string }[],
  cfg: {
    n: number
    limit: number | null
    pythonHarness: boolean
    verifierLabel?: string
    preset: string
    datasetFamily?: string
  },
): DryRunPlan =>
  buildPlan(
    "dataset",
    datasetFile,
    tasks.map((task) => task.instanceId),
    cfg,
  )

/** Render a DryRunPlan as the lines the CLI prints (also asserted by tests). */
export const formatDryRunPlan = (plan: DryRunPlan): string[] => [
  "dry-run plan (NO LLM will be called)",
  `  ${plan.sourceLabel}: ${plan.sourcePath}`,
  `  instances: ${plan.total} loaded, ${plan.selected} selected${
    plan.limit === null ? "" : ` (--limit ${plan.limit})`
  }`,
  `  best-of-n: ${plan.n}`,
  ...(plan.datasetFamily !== undefined ? [`  dataset family: ${plan.datasetFamily}`] : []),
  `  preset: ${plan.preset}`,
  `  verifier: ${plan.verifierLabel ?? (plan.pythonHarness ? "official python swebench harness" : "local testCmd")}`,
  `  sample ids: ${plan.sample.join(", ") || "(none)"}`,
]
