import { parse as parseYaml } from "yaml"

/**
 * WHICH producer jobs a required verdict is made of — the exact set, not a
 * count.
 *
 * WHY IT EXISTS. `aggregateRequiredNeeds` used to check two things: that the
 * needs object was non-empty, and that every row it was HANDED carried an
 * acceptable conclusion. It had no idea which producers were supposed to be
 * there. So `QUANTA_REQUIRED_NEEDS='{"static-code":{"result":"success"}}'`
 * was a PASS, and deleting a producer job together with its `needs:` entry in
 * the workflow deleted the coverage and the evidence of the coverage in one
 * commit — the aggregator saw six green rows instead of seven and said green.
 *
 * The set below is therefore an SSOT with a THREE-WAY consumer: it is compared
 * against the keys GitHub actually passes in `needs`, AND against the `needs:`
 * list the workflow declares for the aggregator job. Any of the three
 * disagreeing is fail-closed, with the offending ids named.
 */

export const REQUIRED_WORKFLOW_PATH = ".github/workflows/ci.yml" as const

/** The job in `REQUIRED_WORKFLOW_PATH` whose `needs:` list is the third side of
 *  the comparison. */
export const REQUIRED_AGGREGATOR_JOB = "required" as const

/**
 * The floor a capability job must clear to count as having run.
 *
 * `1` is not a tuned threshold — it is the definition of "something actually
 * executed". A capability lane whose arms all degrade to visible skips
 * (`pty` without a real PTY, `real-toolchain-e2e` without clangd/dlv/debugpy,
 * `contract` without docker) produces a success-shaped job with zero executed
 * cases, which is exactly the zero-coverage green this ticket exists to stop.
 *
 * Raising a floor above the zero-execution floor requires MEASURED per-runner
 * case counts from the emitted artifacts; the jobs do not emit them yet
 * (TVH-03/TVH-05 own that wiring), so no number here is invented from a
 * comment or a guess.
 */
export interface CapabilityFloor {
  readonly minimumExecutedFiles: number
  readonly minimumExecutedCases: number
}

const ZERO_EXECUTION_FLOOR: CapabilityFloor = {
  minimumExecutedFiles: 1,
  minimumExecutedCases: 1,
}

export interface RequiredProducer {
  /** Key in `toJSON(needs)` — GitHub keys needs by JOB ID, not by job name. */
  readonly id: string
  readonly workflow: string
  /** Job id that must exist in `workflow` and produce this row. */
  readonly job: string
  /**
   * Set when the job's coverage is conditional on host capability, so a
   * `success` conclusion alone does not prove anything ran.
   */
  readonly capability?: CapabilityFloor
}

export type RequiredProducerContext = "pr-required"

/**
 * Derived from the real `required` job at HEAD 85a99bb6f:
 *
 *   needs: [static-code, catalog, full-suite, pty, web, toolchain, contract]
 *
 * `pyramid` is NOT here: it is a legacy check-name aggregator over a SUBSET of
 * the same producers (it omits `contract`), not an input to `required`.
 */
const PR_REQUIRED_PRODUCERS: readonly RequiredProducer[] = [
  { id: "static-code", workflow: REQUIRED_WORKFLOW_PATH, job: "static-code" },
  { id: "catalog", workflow: REQUIRED_WORKFLOW_PATH, job: "catalog" },
  { id: "full-suite", workflow: REQUIRED_WORKFLOW_PATH, job: "full-suite" },
  // Every describe in the PTY e2e is `skipIf(!PTY_AVAILABLE)`: on a runner
  // without openpty the job is green having executed nothing.
  { id: "pty", workflow: REQUIRED_WORKFLOW_PATH, job: "pty", capability: ZERO_EXECUTION_FLOOR },
  { id: "web", workflow: REQUIRED_WORKFLOW_PATH, job: "web" },
  // `*-real-e2e.test.ts` arms degrade to visible skips when clangd / lldb-dap /
  // dlv / debugpy are absent — all 32 of them, on the wrong runner.
  {
    id: "toolchain",
    workflow: REQUIRED_WORKFLOW_PATH,
    job: "toolchain",
    capability: ZERO_EXECUTION_FLOOR,
  },
  // REQUIRE_CONTRACT=1 is supposed to make an absent dependency a hard fail
  // rather than a silent skip; the floor is what PROVES that held.
  {
    id: "contract",
    workflow: REQUIRED_WORKFLOW_PATH,
    job: "contract",
    capability: ZERO_EXECUTION_FLOOR,
  },
]

export const REQUIRED_PRODUCERS: Readonly<
  Record<RequiredProducerContext, readonly RequiredProducer[]>
> = {
  "pr-required": PR_REQUIRED_PRODUCERS,
}

export const requiredProducers = (
  context: RequiredProducerContext = "pr-required",
): readonly RequiredProducer[] => REQUIRED_PRODUCERS[context]

export const requiredProducerIds = (
  producers: readonly RequiredProducer[] = requiredProducers(),
): readonly string[] => producers.map((producer) => producer.id)

export const capabilityProducers = (
  producers: readonly RequiredProducer[] = requiredProducers(),
): readonly RequiredProducer[] => producers.filter((producer) => producer.capability !== undefined)

/* ------------------------------------------------------------------ */
/* workflow side                                                       */
/* ------------------------------------------------------------------ */

export interface WorkflowJobGraph {
  readonly jobIds: readonly string[]
  readonly needsByJob: Readonly<Record<string, readonly string[]>>
}

const asNeedsList = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/**
 * Job ids and `needs:` edges out of a workflow document.
 *
 * Takes TEXT, not a path, so a synthetic workflow with one `needs:` entry
 * deleted is a first-class test input rather than something that has to be
 * simulated.
 */
export const parseWorkflowJobGraph = (workflowYaml: string): WorkflowJobGraph => {
  const document: unknown = parseYaml(workflowYaml)
  if (typeof document !== "object" || document === null) {
    return { jobIds: [], needsByJob: {} }
  }
  const jobs = (document as { readonly jobs?: unknown }).jobs
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) {
    return { jobIds: [], needsByJob: {} }
  }
  const needsByJob: Record<string, readonly string[]> = {}
  for (const [id, job] of Object.entries(jobs as Record<string, unknown>)) {
    needsByJob[id] =
      typeof job === "object" && job !== null
        ? asNeedsList((job as { readonly needs?: unknown }).needs)
        : []
  }
  return { jobIds: Object.keys(jobs as Record<string, unknown>), needsByJob }
}

/* ------------------------------------------------------------------ */
/* capability-result.v1                                                */
/* ------------------------------------------------------------------ */

export const CAPABILITY_RESULT_SCHEMA = "quanta.capability-result.v1" as const

/**
 * What a capability job must publish for its `success` to mean anything.
 *
 * The four outcome buckets are deliberately distinct (ticket item 5):
 * `executedCases` ran, `skippedUnsupported` did not run because the host
 * cannot, `blockedMissing` did not run because a REQUIRED dependency was
 * absent, `failedSetup` did not run because provisioning broke. Only the first
 * is coverage; the last two are failures wearing a skip's clothes.
 */
export interface CapabilityResult {
  readonly schema: typeof CAPABILITY_RESULT_SCHEMA
  readonly producer: string
  /** Exact test file paths that executed at least one case. */
  readonly executedFiles: readonly string[]
  readonly executedCases: number
  readonly skippedUnsupported: number
  readonly blockedMissing: number
  readonly failedSetup: number
}

export type CapabilityValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

/**
 * ABSENT IS A FAILURE, NOT A PASS. A capability job that publishes no
 * `capability-result.v1` artifact has proved nothing about what it executed,
 * and "proved nothing" is the state this guard exists to reject — treating it
 * as a pass reintroduces the zero-coverage green through the back door.
 */
export const validateCapabilityResult = (
  producer: RequiredProducer,
  candidate: unknown,
): CapabilityValidation => {
  const floor = producer.capability
  if (floor === undefined) return { ok: true }
  if (candidate === undefined || candidate === null) {
    return { ok: false, reason: `capability artifact absent for producer "${producer.id}"` }
  }
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      ok: false,
      reason: `capability artifact for producer "${producer.id}" is not an object`,
    }
  }
  const result = candidate as Partial<CapabilityResult>
  if (result.schema !== CAPABILITY_RESULT_SCHEMA) {
    return {
      ok: false,
      reason:
        `capability artifact for producer "${producer.id}" has schema ` +
        `"${String(result.schema)}" (expected ${CAPABILITY_RESULT_SCHEMA})`,
    }
  }
  if (result.producer !== producer.id) {
    return {
      ok: false,
      reason:
        `capability artifact producer mismatch: artifact says "${String(result.producer)}", ` +
        `expected "${producer.id}"`,
    }
  }
  if (
    !isCount(result.executedCases) ||
    !isCount(result.skippedUnsupported) ||
    !isCount(result.blockedMissing) ||
    !isCount(result.failedSetup) ||
    !Array.isArray(result.executedFiles)
  ) {
    return {
      ok: false,
      reason: `capability producer "${producer.id}" reports malformed executed/skipped counts`,
    }
  }
  if (result.failedSetup > 0) {
    return {
      ok: false,
      reason: `capability producer "${producer.id}" reports ${result.failedSetup} failed-setup case(s)`,
    }
  }
  if (result.blockedMissing > 0) {
    return {
      ok: false,
      reason:
        `capability producer "${producer.id}" reports ${result.blockedMissing} ` +
        `blocked-missing dependency(ies)`,
    }
  }
  if (result.executedCases < floor.minimumExecutedCases) {
    return {
      ok: false,
      reason:
        `capability producer "${producer.id}" executed ${result.executedCases} case(s), ` +
        `floor is ${floor.minimumExecutedCases}`,
    }
  }
  if (result.executedFiles.length < floor.minimumExecutedFiles) {
    return {
      ok: false,
      reason:
        `capability producer "${producer.id}" executed ${result.executedFiles.length} file(s), ` +
        `floor is ${floor.minimumExecutedFiles}`,
    }
  }
  return { ok: true }
}
