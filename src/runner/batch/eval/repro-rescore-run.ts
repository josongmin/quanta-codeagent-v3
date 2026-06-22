/**
 * Production glue around {@link rescoreReproScripts}: parse the persisted
 * repro-scripts sidecar, synthesize a build-env import probe, orchestrate the
 * rescore, and summarize. Kept separate from the pure core so the parse /
 * probe / summary logic is unit-testable without any checkout or subprocess.
 *
 * The CLI (`evaluate-repro`) wires the REAL ports (createSandbox/copyRepo +
 * execArgv + reproRunArgv) onto this; tests inject fakes.
 */

import type { ReproTestOutcome } from "@/agent/repro-test/types"
import {
  type ReproRescoreInput,
  type ReproRescoreResult,
  type RescoreReproDeps,
  rescoreReproScripts,
} from "./repro-rescore"

/** Repos whose importable top-level module name differs from the slug tail.
 *  Without this an import-probe for e.g. scikit-learn would `import scikit_learn`
 *  and report a FALSE `exec_failed` (ModuleNotFoundError) that looks exactly like
 *  a real build-env failure — a measurement lie. Extend as needed; when in doubt
 *  use `--repro-scripts` (a real recorded script) instead of the probe. */
const IMPORT_NAME_BY_REPO: Record<string, string> = {
  "scikit-learn/scikit-learn": "sklearn",
  "python-pillow/Pillow": "PIL",
  "dbt-labs/dbt-core": "dbt",
  "pvlib/pvlib-python": "pvlib",
}

/** The package a repo's top-level `import` probe should target — the known
 *  import name when the slug tail diverges (see {@link IMPORT_NAME_BY_REPO}),
 *  else the slug tail with `-`→`_` (e.g. `astropy/astropy` → `astropy`). */
export const topPackageOf = (repo: string): string => {
  const known = IMPORT_NAME_BY_REPO[repo]
  if (known !== undefined) return known
  const tail = repo.split("/").pop() ?? repo
  return tail.replace(/-/g, "_")
}

/**
 * Parse the repro-scripts sidecar (one JSON object per line). Blank lines are
 * tolerated; a MALFORMED line throws (we never silently drop an instance — a
 * dropped instance would read as "nothing to rescore" and hide the gap).
 */
export const parseReproScriptsSidecar = (text: string): readonly ReproRescoreInput[] => {
  const out: ReproRescoreInput[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (line === undefined || line === "") continue
    let obj: {
      instance_id?: string
      repo?: string
      version?: string
      base_commit?: string
      scripts?: readonly { source?: string; outcome?: string }[]
    }
    try {
      obj = JSON.parse(line)
    } catch (e) {
      throw new Error(
        `repro-scripts sidecar line ${i + 1} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (typeof obj.instance_id !== "string" || !Array.isArray(obj.scripts)) {
      throw new Error(
        `repro-scripts sidecar line ${i + 1} missing instance_id or scripts[]`,
      )
    }
    // An empty scripts[] is NOT silently tolerated: rescoring it would yield
    // `outcomes:[]` which is indistinguishable from a checkout that crashed
    // before running anything — a measurement lie. A persisted instance must
    // carry ≥1 script.
    if (obj.scripts.length === 0) {
      throw new Error(`repro-scripts sidecar line ${i + 1} has empty scripts[] (nothing to rescore)`)
    }
    out.push({
      instanceId: obj.instance_id,
      ...(obj.repo !== undefined ? { repo: obj.repo } : {}),
      ...(obj.version !== undefined ? { version: obj.version } : {}),
      ...(obj.base_commit !== undefined ? { baseCommit: obj.base_commit } : {}),
      scripts: obj.scripts.map((s, j) => {
        // A missing/empty source would be classified `unknown` and could flip
        // parity to a SPURIOUS `drift` (corrupt sidecar misread as a real
        // regression). Reject it loudly instead.
        if (typeof s.source !== "string" || s.source === "") {
          throw new Error(
            `repro-scripts sidecar line ${i + 1} script ${j} has missing/empty source`,
          )
        }
        return {
          source: s.source,
          ...(s.outcome !== undefined ? { recordedOutcome: s.outcome as ReproTestOutcome } : {}),
        }
      }),
    })
  }
  return out
}

/** Coordinates needed to synthesize an import probe. */
export interface ImportProbeInstance {
  readonly instanceId: string
  readonly repo: string
  readonly version?: string
  readonly baseCommit?: string
}

/**
 * Build a synthetic import-probe rescore input per instance. For the BUILD-ENV
 * failure class (e.g. astropy `No module named 'extension_helpers'`) the repro
 * SCRIPT content is irrelevant — the repo can't even build/import — so a one-
 * line `import <pkg>` that prints the reproduced marker is enough to observe the
 * build-env fix flip `exec_failed → reproduced`, with NO persisted script and NO
 * LLM. There is no recorded outcome, so parity will be `unknown` (the signal is
 * the absolute outcome, not the diff).
 */
export const buildImportProbeInputs = (
  instances: readonly ImportProbeInstance[],
): readonly ReproRescoreInput[] =>
  instances.map((i) => ({
    instanceId: i.instanceId,
    repo: i.repo,
    ...(i.version !== undefined ? { version: i.version } : {}),
    ...(i.baseCommit !== undefined ? { baseCommit: i.baseCommit } : {}),
    scripts: [
      {
        source: `import ${topPackageOf(i.repo)}\nprint("Issue reproduced")\n`,
      },
    ],
  }))

/** Minimal instance shape the enrichment needs (a checkout + swebench coords). */
export interface RescoreInstanceCoords {
  readonly instanceId: string
  readonly repo?: string
  readonly version?: string
  readonly baseCommit?: string
}

/**
 * Reconcile sidecar inputs against the loaded corpus: fill any missing checkout
 * coordinates (repo / version / baseCommit) from the matched instance, and DROP
 * inputs with no matching instance (they cannot be checked out, so they cannot
 * be rescored). The dropped ids are returned — never silently swallowed, so a
 * corpus/sidecar mismatch is visible rather than reading as "0 to rescore".
 */
export const enrichInputsFromInstances = (
  inputs: readonly ReproRescoreInput[],
  byId: ReadonlyMap<string, RescoreInstanceCoords>,
): { readonly enriched: readonly ReproRescoreInput[]; readonly unmatched: readonly string[] } => {
  const enriched: ReproRescoreInput[] = []
  const unmatched: string[] = []
  for (const input of inputs) {
    const inst = byId.get(input.instanceId)
    if (inst === undefined) {
      unmatched.push(input.instanceId)
      continue
    }
    const repo = input.repo ?? inst.repo
    const version = input.version ?? inst.version
    const baseCommit = input.baseCommit ?? inst.baseCommit
    enriched.push({
      instanceId: input.instanceId,
      scripts: input.scripts,
      ...(repo !== undefined ? { repo } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(baseCommit !== undefined ? { baseCommit } : {}),
    })
  }
  return { enriched, unmatched }
}

export interface ReproRescoreSummary {
  readonly total: number
  /** Instances where ≥1 script printed `Issue reproduced` this time. */
  readonly instancesReproduced: number
  /** Instances whose outcome changed vs the recorded run. */
  readonly drift: number
  /** Instances that could not be rescored (checkout/exec error). */
  readonly errored: number
}

export const summarizeRescore = (
  results: readonly ReproRescoreResult[],
): ReproRescoreSummary => ({
  total: results.length,
  instancesReproduced: results.filter((r) => r.reproducedCount > 0).length,
  drift: results.filter((r) => r.parity === "drift").length,
  errored: results.filter((r) => r.error !== undefined).length,
})

/** Orchestrate a rescore + summarize in one call. `skipped` is how many inputs
 *  were NOT rescored — rescoreReproScripts stops early on signal abort, so a
 *  short result list would otherwise read as a complete run. */
export const runReproRescore = async (
  inputs: readonly ReproRescoreInput[],
  deps: RescoreReproDeps,
): Promise<{
  results: readonly ReproRescoreResult[]
  summary: ReproRescoreSummary
  skipped: number
}> => {
  const results = await rescoreReproScripts(inputs, deps)
  return { results, summary: summarizeRescore(results), skipped: inputs.length - results.length }
}
