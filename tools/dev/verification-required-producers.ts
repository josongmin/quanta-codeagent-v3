import { parse as parseYaml } from "yaml"
import { CAPABILITY_GROUPS, type CapabilityGroup } from "./test-capability-manifest"

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
 * WAS 1 file / 1 case for a whole lane. That is the definition of "something
 * executed" and nothing more: a `toolchain` job where sixteen of seventeen
 * files skipped and one cheap case ran cleared it, and `required` went green
 * over a lane that proved almost nothing. The capability manifest has carried
 * exact per-GROUP numbers the whole time — `capabilityProducerFloors()` even
 * documents itself as "the per-group numbers the fanned-out jobs should carry
 * instead" — with zero production consumers.
 *
 * Now derived. The aggregate floor is the SUM over the producer's required
 * groups, and each group is checked separately against the executed FILE ids,
 * so a lane cannot satisfy a total by over-running one group while another
 * never starts.
 *
 * Which groups are required is not a new judgement either: `lane` already says
 * it. `pr-required-deterministic` is deterministic once provisioned and a PR
 * may block on it; `nightly-heavy` needs network, a live model or minutes of
 * wall clock and is excluded here rather than being softened into a warning.
 */
export interface CapabilityGroupFloor {
  readonly id: string
  readonly minimumExecutedFiles: number
  readonly minimumExecutedCases: number
  /** EXACT member ids, so attribution is membership and never a path prefix. */
  readonly members: readonly string[]
}

export interface CapabilityFloor {
  readonly minimumExecutedFiles: number
  readonly minimumExecutedCases: number
  readonly groups: readonly CapabilityGroupFloor[]
}

/**
 * The groups a PR-required producer must show execution for.
 *
 * Excluded: `declared-pending-gate`. Those members run inside the ordinary
 * suite and roll up to `full-suite`, which carries no capability floor — their
 * execution is currently unprovable, and a floor over them would claim evidence
 * that does not exist.
 *
 * INCLUDED: `out-of-band`. A first draft kept only `lane-gated` and silently
 * dropped `contract-docker`, `contract-lsp-lance` and `pty` — every group those
 * two producers have. `membershipAuthority` says who owns SELECTION (whether
 * the shard runner picks the files), not whether the group is evidence: these
 * run in their own job, and that job IS the producer being validated.
 */
export const requiredCapabilityGroups = (
  producerId: string,
  groups: readonly CapabilityGroup[] = CAPABILITY_GROUPS,
): readonly CapabilityGroupFloor[] =>
  groups
    .filter(
      (group) =>
        group.producer === producerId &&
        group.lane === "pr-required-deterministic" &&
        group.membershipAuthority !== "declared-pending-gate",
    )
    .map((group) => ({
      id: group.id,
      minimumExecutedFiles: group.minExecutedFiles,
      minimumExecutedCases: group.minExecutedCases,
      members: group.members,
    }))

/**
 * A producer's floor, derived from the manifest.
 *
 * A producer with no required group keeps the zero-execution floor: `pty` has
 * no manifest group, and dropping to "no floor at all" because the manifest is
 * silent would reinstate the success-shaped empty job this guard exists for.
 */
export const capabilityFloorFor = (
  producerId: string,
  groups: readonly CapabilityGroup[] = CAPABILITY_GROUPS,
): CapabilityFloor => {
  const required = requiredCapabilityGroups(producerId, groups)
  const sum = (pick: (group: CapabilityGroupFloor) => number): number =>
    required.reduce((total, group) => total + pick(group), 0)
  return {
    minimumExecutedFiles: Math.max(
      1,
      sum((group) => group.minimumExecutedFiles),
    ),
    minimumExecutedCases: Math.max(
      1,
      sum((group) => group.minimumExecutedCases),
    ),
    groups: required,
  }
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
   *
   * A FLAG, not the floor itself. The floor is derived from the capability
   * manifest, and the two modules reference each other — computing it here, at
   * module scope, made whichever loaded second observe the other
   * half-initialized. Both directions threw at runtime and `typecheck` reported
   * neither, so the numbers are resolved at validation time instead.
   */
  readonly capabilityGated?: true
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
  {
    id: "pty",
    workflow: REQUIRED_WORKFLOW_PATH,
    job: "pty",
    capabilityGated: true,
  },
  { id: "web", workflow: REQUIRED_WORKFLOW_PATH, job: "web" },
  // `*-real-e2e.test.ts` arms degrade to visible skips when clangd / lldb-dap /
  // dlv / debugpy are absent — all 32 of them, on the wrong runner.
  {
    id: "toolchain",
    workflow: REQUIRED_WORKFLOW_PATH,
    job: "toolchain",
    capabilityGated: true,
  },
  // REQUIRE_CONTRACT=1 is supposed to make an absent dependency a hard fail
  // rather than a silent skip; the floor is what PROVES that held.
  {
    id: "contract",
    workflow: REQUIRED_WORKFLOW_PATH,
    job: "contract",
    capabilityGated: true,
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
): readonly RequiredProducer[] => producers.filter((producer) => producer.capabilityGated === true)

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
  if (producer.capabilityGated !== true) return { ok: true }
  const floor = capabilityFloorFor(producer.id)
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
  // PER GROUP, not just in total. A lane can clear an aggregate floor by
  // over-running one group while another never starts — `toolchain` fans out
  // to seven groups, and "10 files ran" says nothing about whether pyright ran
  // at all. Attribution is exact membership, never a path prefix.
  const executed = new Set(result.executedFiles)
  for (const group of floor.groups) {
    const ran = group.members.filter((member) => executed.has(member))
    if (ran.length < group.minimumExecutedFiles) {
      return {
        ok: false,
        reason:
          `capability group "${group.id}" (producer "${producer.id}") executed ` +
          `${ran.length} of its ${group.members.length} member file(s), floor is ` +
          `${group.minimumExecutedFiles}`,
      }
    }
  }
  // Totals last, and only reachable once every group cleared: by then a
  // shortfall means the lane ran its groups and still under-executed, which is
  // a different sentence from "a group never started".
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
