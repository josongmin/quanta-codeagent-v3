export type MatrixChunk = {
  readonly id: string
  readonly files: readonly string[]
}

export type VerificationMatrixPlan = {
  readonly schema: "quanta.verification-matrix.v2"
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

const canonicalChunks = (chunks: readonly MatrixChunk[]): readonly MatrixChunk[] => {
  if (chunks.length === 0) throw new Error("empty matrix plan")
  const ids = new Set<string>()
  const allFiles = new Set<string>()
  return [...chunks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((chunk) => {
      if (!isSafeChunkId(chunk.id)) throw new Error(`unsafe matrix chunk id: ${chunk.id}`)
      if (ids.has(chunk.id)) throw new Error("duplicate matrix chunk id")
      ids.add(chunk.id)
      const files = [...chunk.files].sort()
      if (files.length === 0) throw new Error(`empty matrix chunk: ${chunk.id}`)
      for (const file of files) {
        if (!isSafeRelativePath(file)) throw new Error(`unsafe matrix file: ${file}`)
        if (allFiles.has(file)) throw new Error(`duplicate matrix file: ${file}`)
        allFiles.add(file)
      }
      return { id: chunk.id, files }
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
    schema: "quanta.verification-matrix.v2",
    headSha,
    planSha256: planIdentity(headSha, canonical),
    chunks: canonical,
  }
}

export const parseVerificationMatrixPlan = (value: unknown): VerificationMatrixPlan => {
  if (typeof value !== "object" || value === null) throw new Error("invalid matrix plan")
  const row = value as Partial<VerificationMatrixPlan>
  if (row.schema !== "quanta.verification-matrix.v2") throw new Error("invalid matrix plan schema")
  if (typeof row.headSha !== "string" || !Array.isArray(row.chunks)) {
    throw new Error("invalid matrix plan fields")
  }
  const rebuilt = planVerificationMatrix(row.headSha, row.chunks)
  if (row.planSha256 !== rebuilt.planSha256) throw new Error("matrix plan digest mismatch")
  return rebuilt
}

export type MatrixWorkerReceipt = {
  readonly schema: "quanta.verification-matrix-worker.v2"
  readonly headSha: string
  readonly planSha256: string
  readonly chunkId: string
  readonly files: readonly string[]
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly snapshotStable: boolean
  readonly junitFile: string
  readonly junitSha256: string | null
}

export const workerReceipt = (input: {
  readonly headSha: string
  readonly planSha256: string
  readonly chunkId: string
  readonly files: readonly string[]
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly snapshotStable: boolean
  readonly junitFile: string
  readonly junitSha256?: string
}): MatrixWorkerReceipt => ({
  schema: "quanta.verification-matrix-worker.v2",
  headSha: input.headSha,
  planSha256: input.planSha256,
  chunkId: input.chunkId,
  files: [...input.files].sort(),
  outcome: input.outcome,
  snapshotStable: input.snapshotStable,
  junitFile: input.junitFile,
  junitSha256: input.junitSha256 ?? null,
})

export const parseMatrixWorkerReceipt = (value: unknown): MatrixWorkerReceipt => {
  if (typeof value !== "object" || value === null) throw new Error("invalid matrix receipt")
  const row = value as Partial<MatrixWorkerReceipt>
  if (
    row.schema !== "quanta.verification-matrix-worker.v2" ||
    typeof row.headSha !== "string" ||
    typeof row.planSha256 !== "string" ||
    typeof row.chunkId !== "string" ||
    !Array.isArray(row.files) ||
    !row.files.every((file) => typeof file === "string") ||
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

const reasonsForReceipt = (
  plan: VerificationMatrixPlan,
  expected: MatrixChunk | undefined,
  receipt: MatrixWorkerReceipt | undefined,
  junitDigests: ReadonlyMap<string, string>,
): readonly string[] => {
  const id = expected?.id ?? receipt?.chunkId ?? "unknown"
  if (receipt === undefined) return [`missing:${id}`]
  const reasons: string[] = []
  if (receipt.headSha !== plan.headSha) reasons.push(`wrong-head:${id}`)
  if (receipt.planSha256 !== plan.planSha256) reasons.push(`wrong-plan:${id}`)
  if (!sameFiles(expected?.files ?? [], receipt.files)) reasons.push(`stale:${id}`)
  if (!receipt.snapshotStable) reasons.push(`snapshot-drift:${id}`)
  if (receipt.outcome === "cancelled") reasons.push(`cancelled:${id}`)
  if (receipt.outcome === "failed") reasons.push(`failed:${id}`)
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
