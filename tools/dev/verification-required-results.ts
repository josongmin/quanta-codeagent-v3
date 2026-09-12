import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  capabilityProducers,
  parseWorkflowJobGraph,
  REQUIRED_AGGREGATOR_JOB,
  REQUIRED_WORKFLOW_PATH,
  type RequiredProducer,
  requiredProducerIds,
  requiredProducers,
  validateCapabilityResult,
} from "./verification-required-producers"
import type { VerificationOutcome } from "./verification-result"

export type GithubCheckConclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral"

const CONCLUSIONS = new Set<GithubCheckConclusion>([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
])

export const requiredCheckOutcome = (input: {
  readonly github: GithubCheckConclusion
  readonly policy: VerificationOutcome
}): "pass" | "fail" => {
  if (input.policy === "not-selected") {
    return input.github === "skipped" || input.github === "success" ? "pass" : "fail"
  }
  if (input.github === "skipped") return "fail"
  if (input.github === "cancelled") return "fail"
  if (input.github === "failure") return "fail"
  if (input.github === "neutral") return "fail"
  return input.policy === "passed" ? "pass" : "fail"
}

export interface RequiredAggregationInput {
  /** `toJSON(needs)` as GitHub passes it: keyed by JOB ID. */
  readonly needs: Readonly<Record<string, { readonly result?: unknown }>>
  /** Text of the workflow that declares the aggregator job's `needs:` list. */
  readonly workflowYaml: string
  /** `capability-result.v2` artifacts by producer id. Absent = fail closed. */
  readonly capabilityResults?: Readonly<Record<string, unknown>>
  readonly producers?: readonly RequiredProducer[]
  readonly policy?: VerificationOutcome
  readonly aggregatorJob?: string
}

export type RequiredAggregation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] }

const sorted = (values: Iterable<string>): readonly string[] => [...values].sort()

const list = (values: Iterable<string>): string => sorted(values).join(", ")

/** Side 1 vs side 2: the SSOT against the keys GitHub actually handed us. */
const keySetReasons = (
  expected: ReadonlySet<string>,
  present: ReadonlySet<string>,
): readonly string[] => {
  const reasons: string[] = []
  const missing = sorted([...expected].filter((id) => !present.has(id)))
  if (missing.length > 0) reasons.push(`missing producer ids in needs: ${list(missing)}`)
  const unknown = sorted([...present].filter((id) => !expected.has(id)))
  if (unknown.length > 0) reasons.push(`unknown producer ids in needs: ${list(unknown)}`)
  return reasons
}

/** Side 3: the `needs:` list the workflow itself declares, plus the existence
 *  of a job behind every required producer. */
const workflowReasons = (
  workflowYaml: string,
  aggregatorJob: string,
  expected: ReadonlySet<string>,
  producers: readonly RequiredProducer[],
): readonly string[] => {
  const reasons: string[] = []
  const graph = parseWorkflowJobGraph(workflowYaml)
  const jobIds = new Set(graph.jobIds)
  if (jobIds.has(aggregatorJob)) {
    const declared = new Set(graph.needsByJob[aggregatorJob] ?? [])
    const notDeclared = sorted([...expected].filter((id) => !declared.has(id)))
    if (notDeclared.length > 0) {
      reasons.push(
        `workflow "${aggregatorJob}" job does not declare needs for producer ids: ` +
          `${list(notDeclared)}`,
      )
    }
    const extra = sorted([...declared].filter((id) => !expected.has(id)))
    if (extra.length > 0) {
      reasons.push(
        `workflow "${aggregatorJob}" job declares needs not in the required SSOT: ${list(extra)}`,
      )
    }
  } else {
    reasons.push(`workflow has no "${aggregatorJob}" job`)
  }
  const jobless = sorted(
    producers.filter((producer) => !jobIds.has(producer.job)).map((producer) => producer.job),
  )
  if (jobless.length > 0) {
    reasons.push(`${REQUIRED_WORKFLOW_PATH} has no job for required producer ids: ${list(jobless)}`)
  }
  return reasons
}

const rowReason = (
  id: string,
  result: unknown,
  policy: VerificationOutcome,
): string | undefined => {
  if (typeof result !== "string" || !CONCLUSIONS.has(result as GithubCheckConclusion)) {
    return `producer "${id}" has a non-conclusion result: ${JSON.stringify(result)}`
  }
  const conclusion = result as GithubCheckConclusion
  return requiredCheckOutcome({ github: conclusion, policy }) === "fail"
    ? `producer "${id}" concluded "${conclusion}"`
    : undefined
}

const conclusionReasons = (
  needs: RequiredAggregationInput["needs"],
  present: ReadonlySet<string>,
  policy: VerificationOutcome,
): readonly string[] => {
  const reasons: string[] = []
  for (const id of sorted(present)) {
    const reason = rowReason(id, needs[id]?.result, policy)
    if (reason !== undefined) reasons.push(reason)
  }
  // A whole run in which nothing executed is never a pass, whatever the policy
  // argument says — this is the success-shaped envelope over an all-skipped
  // matrix, which reads green in every count-based check.
  const results = [...present].map((id) => needs[id]?.result)
  if (results.length > 0 && results.every((value) => value === "skipped")) {
    reasons.push(`every producer row is "skipped" — nothing executed`)
  }
  return reasons
}

const capabilityReasons = (
  producers: readonly RequiredProducer[],
  artifacts: Readonly<Record<string, unknown>>,
): readonly string[] =>
  capabilityProducers(producers)
    .map((producer) => validateCapabilityResult(producer, artifacts[producer.id]))
    .flatMap((validation) => (validation.ok ? [] : [validation.reason]))

/**
 * Three-way exact comparison of the producer set behind a required verdict.
 *
 * The three sides that must agree:
 *   1. the SSOT in `verification-required-producers.ts`,
 *   2. the keys GitHub actually handed us in `needs`,
 *   3. the `needs:` list the workflow declares for the aggregator job.
 *
 * The old reducer compared NONE of these — it checked that the object was
 * non-empty and that whatever rows it received were acceptable. So a workflow
 * edit that deleted a producer job AND its `needs:` entry silently deleted a
 * seventh of the required coverage, and a single `{"static-code":"success"}`
 * row was a PASS. Missing, extra and unknown ids are all fail-closed, and the
 * offending ids are named so the message is actionable rather than "required
 * failed".
 */
export const aggregateRequiredNeeds = (input: RequiredAggregationInput): RequiredAggregation => {
  const producers = input.producers ?? requiredProducers()
  // Anti-vacuum floor: an empty SSOT would make every comparison below
  // trivially satisfied, i.e. emptying that file would turn the guard off
  // while leaving it "green".
  if (producers.length === 0) {
    return { ok: false, reasons: ["expected producer set is empty"] }
  }
  const expected = new Set(requiredProducerIds(producers))
  const present = new Set(Object.keys(input.needs))
  const reasons = [
    ...keySetReasons(expected, present),
    ...workflowReasons(
      input.workflowYaml,
      input.aggregatorJob ?? REQUIRED_AGGREGATOR_JOB,
      expected,
      producers,
    ),
    ...conclusionReasons(input.needs, present, input.policy ?? "passed"),
    ...capabilityReasons(producers, input.capabilityResults ?? {}),
  ]
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const readJsonIfPresent = (path: string): unknown => {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return null
  }
}

export const readCapabilityResults = (
  directory: string | undefined,
  producers: readonly RequiredProducer[] = requiredProducers(),
): Readonly<Record<string, unknown>> => {
  const results: Record<string, unknown> = {}
  for (const producer of capabilityProducers(producers)) {
    results[producer.id] =
      directory === undefined || directory === ""
        ? undefined
        : readJsonIfPresent(join(directory, `${producer.id}.json`))
  }
  return results
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..", "..")
  const raw = process.env.QUANTA_REQUIRED_NEEDS ?? ""
  if (raw === "") {
    process.stderr.write("verification-required-results: missing QUANTA_REQUIRED_NEEDS\n")
    process.exit(2)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write("verification-required-results: QUANTA_REQUIRED_NEEDS is not JSON\n")
    process.exit(2)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("verification-required-results: needs must be an object\n")
    process.exit(2)
  }
  const workflowPath = join(repoRoot, REQUIRED_WORKFLOW_PATH)
  if (!existsSync(workflowPath)) {
    process.stderr.write(`verification-required-results: no workflow at ${workflowPath}\n`)
    process.exit(2)
  }
  const verdict = aggregateRequiredNeeds({
    needs: parsed as Record<string, { readonly result?: unknown }>,
    workflowYaml: readFileSync(workflowPath, "utf8"),
    capabilityResults: readCapabilityResults(process.env.QUANTA_CAPABILITY_RESULTS_DIR),
  })
  if (verdict.ok) {
    process.stdout.write("verification-required-results: pass\n")
    process.exit(0)
  }
  for (const reason of verdict.reasons) {
    process.stderr.write(`verification-required-results: ${reason}\n`)
  }
  process.exit(1)
}
