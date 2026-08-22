/**
 * TB21-03 — the machine-readable, REVISION-BOUND canary manifest.
 *
 * Two properties make this file worth existing rather than a comment in a shell
 * script:
 *
 *  1. **Revision binding.** A canary set is only meaningful for the dataset
 *     revision it was chosen against. `datasetRef` is checked at module load, so
 *     bumping the pinned ref INVALIDATES the selection loudly instead of leaving
 *     an operator running a "canary" against tasks whose content moved.
 *  2. **Catalog derivation.** Every id is checked against the pinned 89-task
 *     catalog (`./dataset`), so a hand-typed or renamed task cannot reach a paid
 *     command. Harbor's `-i` filter is `fnmatch(task_id.get_name(), pattern)`
 *     over `org/name` (`harbor/models/job/config.py` `_filter_task_ids`,
 *     `harbor/models/task/id.py` `PackageTaskId.get_name`), and an unmatched
 *     filter RAISES rather than widening to the full dataset — so the real cost
 *     of a stale id is an aborted canary, not a four-figure run. Catching it
 *     here means the abort happens before a container is ever provisioned.
 *
 * The selection deliberately does NOT reuse the TB2.0 smoke list
 * (`tools/tb-smoke/run-tb-smoke.sh`); `canary.test.ts` reads that script's bytes
 * and enforces disjointness.
 */

import { isCanonicalTask, TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import MANIFEST from "./terminal-bench-2-1-canary.json" with { type: "json" }

export type CanaryPurpose = "oracle" | "canary"

export interface CanaryTask {
  readonly id: string
  readonly purpose: CanaryPurpose
  readonly category: string
  readonly rationale: string
  readonly expectedStructuralChecks: readonly string[]
}

export interface CanaryManifest {
  readonly schemaVersion: "terminal-bench-canary/v1"
  readonly dataset: typeof TERMINAL_BENCH_DATASET
  readonly datasetRef: string
  readonly selectionBasis: string
  readonly tasks: readonly CanaryTask[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const strArray = (v: unknown, where: string): readonly string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`terminal canary: ${where} must be an array of strings`)
  }
  return v as readonly string[]
}

/** One task entry. Every field is load-bearing: the id must be a real catalog
 *  task (an include filter that matches nothing makes harbor run the FULL
 *  dataset), and the rationale + checks are what TB21-07 audits the run against. */
const decodeCanaryTask = (entry: unknown): CanaryTask => {
  if (!isRecord(entry)) throw new Error("terminal canary: each task must be an object")
  const id = entry.id
  if (typeof id !== "string" || !isCanonicalTask(id)) {
    throw new Error(
      `terminal canary: ${JSON.stringify(id)} is not in the pinned 2.1 catalog. Harbor matches ` +
        "`-i` against the task's `org/name`, and a filter that matches nothing aborts the job — " +
        "so a stale id burns the setup, not the budget. Regenerate the selection.",
    )
  }
  if (entry.purpose !== "oracle" && entry.purpose !== "canary") {
    throw new Error(`terminal canary: ${id} has an unknown purpose ${String(entry.purpose)}`)
  }
  if (typeof entry.category !== "string" || entry.category.trim() === "") {
    throw new Error(`terminal canary: ${id} has no category`)
  }
  if (typeof entry.rationale !== "string" || entry.rationale.trim().length < 20) {
    throw new Error(`terminal canary: ${id} has no substantive selection rationale`)
  }
  const checks = strArray(entry.expectedStructuralChecks, `${id}.expectedStructuralChecks`)
  if (checks.length === 0) {
    throw new Error(`terminal canary: ${id} declares no expected structural checks`)
  }
  return {
    id,
    purpose: entry.purpose,
    category: entry.category,
    rationale: entry.rationale,
    expectedStructuralChecks: checks,
  }
}

/**
 * Validate a canary manifest, fail-closed. Refuses:
 *  - a `datasetRef` that is not the pinned one (a stale or `latest` selection);
 *  - a task id outside the pinned catalog;
 *  - a purpose split other than exactly one oracle + three canaries;
 *  - an entry with no rationale or no structural checks (an unexplained pick is
 *    a superstition, and TB21-07 has to be able to CHECK the run afterwards).
 */
export const validateCanaryManifest = (raw: unknown): CanaryManifest => {
  if (!isRecord(raw)) throw new Error("terminal canary: manifest must be an object")
  if (raw.schemaVersion !== "terminal-bench-canary/v1") {
    throw new Error(`terminal canary: unknown schemaVersion ${String(raw.schemaVersion)}`)
  }
  if (raw.dataset !== TERMINAL_BENCH_DATASET) {
    throw new Error(
      `terminal canary: dataset ${JSON.stringify(raw.dataset)} is not ${TERMINAL_BENCH_DATASET}`,
    )
  }
  if (raw.datasetRef !== TERMINAL_BENCH_DATASET_REF) {
    throw new Error(
      `terminal canary: datasetRef ${JSON.stringify(raw.datasetRef)} does not match the pinned ` +
        `${TERMINAL_BENCH_DATASET_REF}. A canary set is bound to the revision it was chosen ` +
        "against — regenerate the selection instead of re-stamping the ref.",
    )
  }
  if (typeof raw.selectionBasis !== "string" || raw.selectionBasis.trim() === "") {
    throw new Error("terminal canary: selectionBasis (why THESE tasks) is required")
  }
  if (!Array.isArray(raw.tasks)) throw new Error("terminal canary: tasks must be an array")

  const tasks: CanaryTask[] = raw.tasks.map(decodeCanaryTask)

  const oracles = tasks.filter((t) => t.purpose === "oracle")
  const canaries = tasks.filter((t) => t.purpose === "canary")
  if (oracles.length !== 1) {
    throw new Error(`terminal canary: expected exactly ONE oracle task, found ${oracles.length}`)
  }
  if (canaries.length !== 3) {
    throw new Error(
      `terminal canary: expected exactly THREE canary tasks, found ${canaries.length}`,
    )
  }
  const categories = new Set(tasks.map((t) => t.category))
  if (categories.size !== tasks.length) {
    throw new Error(
      "terminal canary: the canaries must be category-DIVERSE; two entries share a category",
    )
  }

  return {
    schemaVersion: "terminal-bench-canary/v1",
    dataset: TERMINAL_BENCH_DATASET,
    datasetRef: raw.datasetRef,
    selectionBasis: raw.selectionBasis,
    tasks,
  }
}

/** The shipped selection, validated at module load — a stale ref or a renamed
 *  task is a startup failure, never a quietly-empty include list. */
export const TERMINAL_CANARY_MANIFEST: CanaryManifest = validateCanaryManifest(MANIFEST)

/** The task ids for one purpose, in manifest order. */
export const canaryTaskIds = (purpose: CanaryPurpose): readonly string[] =>
  TERMINAL_CANARY_MANIFEST.tasks.filter((t) => t.purpose === purpose).map((t) => t.id)
