/**
 * PMX-02 — the TWO ARTIFACTS, their digests, and their serialization.
 *
 * The gold-bearing official dataset is not the file a run consumes. Trusted
 * preparation validates it (PMX-00 + `decode.ts`) and then emits:
 *
 *   public-tasks.json      ordered PromaxAgentTaskView rows ONLY
 *   grader-bundle/         PromaxGraderTaskView rows + pinned source reference
 *
 * Both carry the SOURCE identity (which verified manifest/upstream commit they
 * came from) and a CONTENT digest (a seal over the canonical form of their own
 * rows). The source digest answers "same corpus?"; the content digest answers
 * "unmodified since preparation?". Neither answers the other, which is why both
 * are present.
 *
 * ## Canonical JSON
 *
 * Digests are computed over a canonical serialization — keys sorted, no
 * insignificant whitespace — so a re-serialization, a pretty-print, or a
 * different construction order cannot change a digest. The digest therefore
 * means "these rows", not "these bytes", which is the property a receipt needs.
 */
import { sha256Hex } from "../provenance"
import type {
  PromaxAgentTaskView,
  PromaxArtifactSource,
  PromaxGraderBundleArtifact,
  PromaxGraderTaskView,
  PromaxPublicTasksArtifact,
} from "./types"

/** Deterministic JSON: object keys sorted bytewise, arrays in order. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export const proMaxContentDigest = (tasks: readonly unknown[]): string =>
  sha256Hex(canonicalJson(tasks))

export interface BuildProMaxArtifactsInput {
  readonly agentTasks: readonly PromaxAgentTaskView[]
  readonly graderTasks: readonly PromaxGraderTaskView[]
  readonly source: PromaxArtifactSource
}

export interface ProMaxArtifacts {
  readonly publicTasks: PromaxPublicTasksArtifact
  readonly graderBundle: PromaxGraderBundleArtifact
}

/**
 * Build both artifacts from an ALREADY-DECODED corpus. Pure: no filesystem, no
 * clock, no env — so "re-preparing the same bytes is byte-identical" is a
 * property of the function rather than a hope about the machine.
 */
export const buildProMaxArtifacts = (input: BuildProMaxArtifactsInput): ProMaxArtifacts => {
  if (input.agentTasks.length !== input.graderTasks.length) {
    throw new Error(
      `promax: agent view count (${input.agentTasks.length}) != grader view count ` +
        `(${input.graderTasks.length}) — REFUSING to emit a pair of artifacts that ` +
        "cannot both cover the same assigned set.",
    )
  }
  return {
    publicTasks: {
      artifact: "promax-public-tasks",
      artifactVersion: 1,
      source: input.source,
      contentSha256: proMaxContentDigest(input.agentTasks),
      tasks: input.agentTasks,
    },
    graderBundle: {
      artifact: "promax-grader-bundle",
      artifactVersion: 1,
      source: input.source,
      contentSha256: proMaxContentDigest(input.graderTasks),
      tasks: input.graderTasks,
    },
  }
}

const serialize = (artifact: unknown): string => `${JSON.stringify(artifact, null, 2)}\n`

export const serializeProMaxPublicTasks = (artifact: PromaxPublicTasksArtifact): string =>
  serialize(artifact)

export const serializeProMaxGraderBundle = (artifact: PromaxGraderBundleArtifact): string =>
  serialize(artifact)

export class ProMaxArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProMaxArtifactError"
  }
}

const parseArtifact = <T>(text: string, kind: string, label: string): T => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ProMaxArtifactError(
      `promax ${label}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProMaxArtifactError(`promax ${label}: expected a JSON object envelope`)
  }
  const record = value as Record<string, unknown>
  if (record.artifact !== kind) {
    throw new ProMaxArtifactError(
      `promax ${label}: envelope says artifact=${JSON.stringify(record.artifact)}, expected "${kind}" — ` +
        "REFUSING to read one ProMax artifact as the other.",
    )
  }
  if (record.artifactVersion !== 1) {
    throw new ProMaxArtifactError(
      `promax ${label}: unsupported artifactVersion ${JSON.stringify(record.artifactVersion)}`,
    )
  }
  if (!Array.isArray(record.tasks)) {
    throw new ProMaxArtifactError(`promax ${label}: \`tasks\` must be an array`)
  }
  const actual = proMaxContentDigest(record.tasks)
  if (actual !== record.contentSha256) {
    throw new ProMaxArtifactError(
      `promax ${label}: content digest mismatch — rows hash to ${actual} but the envelope ` +
        `declares ${String(record.contentSha256)}. The artifact was modified after preparation; ` +
        "REFUSING to run a corpus that is not the one that was verified.",
    )
  }
  return value as T
}

export const parseProMaxPublicTasksArtifact = (text: string): PromaxPublicTasksArtifact =>
  parseArtifact<PromaxPublicTasksArtifact>(text, "promax-public-tasks", "public-tasks.json")

export const parseProMaxGraderBundleArtifact = (text: string): PromaxGraderBundleArtifact =>
  parseArtifact<PromaxGraderBundleArtifact>(text, "promax-grader-bundle", "grader-bundle")
