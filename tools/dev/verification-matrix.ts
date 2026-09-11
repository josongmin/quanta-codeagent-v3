import { executedFileSetDigest } from "./executed-file-set"
import { TEST_RESOURCE_CLASSES, type TestResourceClass } from "./test-shard-plan"

export type MatrixChunk = {
  readonly id: string
  readonly files: readonly string[]
  readonly resourceClass: TestResourceClass
  /** Measured scheduling weight, used to launch the longest chunks first. */
  readonly predictedMs: number
  readonly testTimeoutMs: number
  readonly intraParallel: number
}

export type VerificationMatrixPlan = {
  readonly schema: "quanta.verification-matrix.v3"
  readonly headSha: string
  readonly planSha256: string
  readonly chunks: readonly MatrixChunk[]
}

const digest = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex")

const isSafeRelativePath = (file: string): boolean =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  file.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const isSafeChunkId = (id: string): boolean => /^[a-z0-9-]+$/i.test(id)

const validExecutionPolicy = (chunk: MatrixChunk): boolean =>
  TEST_RESOURCE_CLASSES.includes(chunk.resourceClass) &&
  Number.isSafeInteger(chunk.predictedMs) &&
  chunk.predictedMs >= 1 &&
  Number.isSafeInteger(chunk.testTimeoutMs) &&
  chunk.testTimeoutMs >= 1 &&
  Number.isSafeInteger(chunk.intraParallel) &&
  chunk.intraParallel >= 1

const claimChunkId = (id: string, ids: Set<string>): void => {
  if (!isSafeChunkId(id)) throw new Error(`unsafe matrix chunk id: ${id}`)
  if (ids.has(id)) throw new Error("duplicate matrix chunk id")
  ids.add(id)
}

const claimChunkFiles = (files: readonly string[], allFiles: Set<string>): readonly string[] => {
  const canonical = [...files].sort()
  if (canonical.length === 0) throw new Error("empty matrix chunk")
  for (const file of canonical) {
    if (!isSafeRelativePath(file)) throw new Error(`unsafe matrix file: ${file}`)
    if (allFiles.has(file)) throw new Error(`duplicate matrix file: ${file}`)
    allFiles.add(file)
  }
  return canonical
}

const canonicalChunks = (chunks: readonly MatrixChunk[]): readonly MatrixChunk[] => {
  if (chunks.length === 0) throw new Error("empty matrix plan")
  const ids = new Set<string>()
  const allFiles = new Set<string>()
  return [...chunks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((chunk) => {
      claimChunkId(chunk.id, ids)
      const files = claimChunkFiles(chunk.files, allFiles)
      if (!validExecutionPolicy(chunk)) {
        throw new Error(`invalid matrix execution policy: ${chunk.id}`)
      }
      return { ...chunk, files }
    })
}

const planIdentity = (headSha: string, chunks: readonly MatrixChunk[]): string =>
  digest(JSON.stringify({ headSha, chunks }))

export const planVerificationMatrix = (
  headSha: string,
  chunks: readonly MatrixChunk[],
): VerificationMatrixPlan => {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("matrix plan requires an exact HEAD SHA")
  const canonical = canonicalChunks(chunks)
  return {
    schema: "quanta.verification-matrix.v3",
    headSha,
    planSha256: planIdentity(headSha, canonical),
    chunks: canonical,
  }
}

export const parseVerificationMatrixPlan = (value: unknown): VerificationMatrixPlan => {
  if (typeof value !== "object" || value === null) throw new Error("invalid matrix plan")
  const row = value as Partial<VerificationMatrixPlan>
  if (row.schema !== "quanta.verification-matrix.v3") throw new Error("invalid matrix plan schema")
  if (typeof row.headSha !== "string" || !Array.isArray(row.chunks)) {
    throw new Error("invalid matrix plan fields")
  }
  const rebuilt = planVerificationMatrix(row.headSha, row.chunks)
  if (row.planSha256 !== rebuilt.planSha256) throw new Error("matrix plan digest mismatch")
  return rebuilt
}

export type MatrixWorkerReceipt = {
  readonly schema: "quanta.verification-matrix-worker.v3"
  readonly headSha: string
  readonly planSha256: string
  readonly chunkId: string
  readonly plannedFiles: readonly string[]
  /** Files independently recovered from JUnit, never copied from the plan. */
  readonly executedFiles: readonly string[]
  /** sha256 over the sorted executed ids — the set, in one comparable field. */
  readonly executedDigestSha256: string
  readonly testTimeoutMs: number
  readonly intraParallel: number
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly snapshotStable: boolean
  readonly junitFile: string
  readonly junitSha256: string | null
}

export const workerReceipt = (input: {
  readonly headSha: string
  readonly planSha256: string
  readonly chunkId: string
  readonly plannedFiles: readonly string[]
  readonly executedFiles: readonly string[]
  /** sha256 over the sorted executed ids — the set, in one comparable field. */
  readonly executedDigestSha256: string
  readonly testTimeoutMs: number
  readonly intraParallel: number
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly snapshotStable: boolean
  readonly junitFile: string
  readonly junitSha256?: string
}): MatrixWorkerReceipt => ({
  schema: "quanta.verification-matrix-worker.v3",
  headSha: input.headSha,
  planSha256: input.planSha256,
  chunkId: input.chunkId,
  plannedFiles: [...input.plannedFiles].sort(),
  executedFiles: [...input.executedFiles].sort(),
  executedDigestSha256: input.executedDigestSha256,
  testTimeoutMs: input.testTimeoutMs,
  intraParallel: input.intraParallel,
  outcome: input.outcome,
  snapshotStable: input.snapshotStable,
  junitFile: input.junitFile,
  junitSha256: input.junitSha256 ?? null,
})

export const parseMatrixWorkerReceipt = (value: unknown): MatrixWorkerReceipt => {
  if (typeof value !== "object" || value === null) throw new Error("invalid matrix receipt")
  const row = value as Partial<MatrixWorkerReceipt>
  if (
    row.schema !== "quanta.verification-matrix-worker.v3" ||
    typeof row.headSha !== "string" ||
    typeof row.planSha256 !== "string" ||
    typeof row.chunkId !== "string" ||
    !Array.isArray(row.plannedFiles) ||
    !row.plannedFiles.every((file) => typeof file === "string" && isSafeRelativePath(file)) ||
    !Array.isArray(row.executedFiles) ||
    !row.executedFiles.every((file) => typeof file === "string" && isSafeRelativePath(file)) ||
    typeof row.executedDigestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.executedDigestSha256) ||
    !Number.isSafeInteger(row.testTimeoutMs) ||
    (row.testTimeoutMs as number) < 1 ||
    !Number.isSafeInteger(row.intraParallel) ||
    (row.intraParallel as number) < 1 ||
    !["passed", "failed", "cancelled"].includes(row.outcome ?? "") ||
    typeof row.snapshotStable !== "boolean" ||
    typeof row.junitFile !== "string" ||
    !/^[a-z0-9-]+\.junit\.xml$/i.test(row.junitFile) ||
    !(typeof row.junitSha256 === "string" || row.junitSha256 === null)
  ) {
    throw new Error("invalid matrix receipt fields")
  }
  return row as MatrixWorkerReceipt
}

export type AggregateVerdict = "passed" | "failed"

const sameFiles = (left: readonly string[], right: readonly string[]): boolean =>
  [...left].sort().join("\n") === [...right].sort().join("\n")

const reasonIf = (condition: boolean, reason: string): readonly string[] =>
  condition ? [reason] : []

const reasonsForReceipt = (
  plan: VerificationMatrixPlan,
  expected: MatrixChunk | undefined,
  receipt: MatrixWorkerReceipt | undefined,
  junitDigests: ReadonlyMap<string, string>,
): readonly string[] => {
  const id = expected?.id ?? receipt?.chunkId ?? "unknown"
  if (receipt === undefined) return [`missing:${id}`]
  const reasons = [
    ...reasonIf(receipt.headSha !== plan.headSha, `wrong-head:${id}`),
    ...reasonIf(receipt.planSha256 !== plan.planSha256, `wrong-plan:${id}`),
    ...reasonIf(!sameFiles(expected?.files ?? [], receipt.plannedFiles), `stale-plan:${id}`),
    ...reasonIf(!sameFiles(expected?.files ?? [], receipt.executedFiles), `stale-executed:${id}`),
    // The digest must agree with the list it summarises: a receipt carrying a
    // digest of some OTHER set is how an exact-set claim gets forged.
    ...reasonIf(
      receipt.executedDigestSha256 !== executedFileSetDigest(receipt.executedFiles),
      `executed-digest-mismatch:${id}`,
    ),
    ...reasonIf(receipt.testTimeoutMs !== expected?.testTimeoutMs, `wrong-timeout:${id}`),
    ...reasonIf(receipt.intraParallel !== expected?.intraParallel, `wrong-parallel:${id}`),
    ...reasonIf(!receipt.snapshotStable, `snapshot-drift:${id}`),
    ...reasonIf(receipt.outcome === "cancelled", `cancelled:${id}`),
    ...reasonIf(receipt.outcome === "failed", `failed:${id}`),
  ]
  if (receipt.outcome === "passed") {
    if (receipt.junitSha256 === null) reasons.push(`missing-junit:${id}`)
    else if (junitDigests.get(receipt.junitFile) !== receipt.junitSha256) {
      reasons.push(`junit-mismatch:${id}`)
    }
  }
  return reasons
}

export const aggregateMatrixReceipts = (input: {
  readonly plan: VerificationMatrixPlan
  readonly receipts: readonly MatrixWorkerReceipt[]
  readonly junitDigests?: ReadonlyMap<string, string>
}): {
  readonly verdict: AggregateVerdict
  readonly reasons: readonly string[]
} => {
  const expectedIds = input.plan.chunks.map((chunk) => chunk.id).sort()
  const seen = new Map(input.receipts.map((receipt) => [receipt.chunkId, receipt]))
  const junitDigests = input.junitDigests ?? new Map<string, string>()
  const reasons = [
    ...(seen.size === input.receipts.length ? [] : ["duplicate"]),
    ...expectedIds.flatMap((id) =>
      reasonsForReceipt(
        input.plan,
        input.plan.chunks.find((chunk) => chunk.id === id),
        seen.get(id),
        junitDigests,
      ),
    ),
    ...[...seen.keys()].filter((id) => !expectedIds.includes(id)).map((id) => `unexpected:${id}`),
  ]
  return reasons.length === 0 && input.receipts.length === expectedIds.length
    ? { verdict: "passed", reasons: [] }
    : { verdict: "failed", reasons }
}
