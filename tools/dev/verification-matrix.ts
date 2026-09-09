export type MatrixChunk = {
  readonly id: string
  readonly files: readonly string[]
}

export const planVerificationMatrix = (
  chunks: readonly MatrixChunk[],
): {
  readonly schema: "quanta.verification-matrix.v1"
  readonly chunks: readonly MatrixChunk[]
} => {
  const ids = chunks.map((chunk) => chunk.id)
  if (new Set(ids).size !== ids.length) throw new Error("duplicate matrix chunk id")
  return { schema: "quanta.verification-matrix.v1", chunks }
}

export const workerReceipt = (input: {
  readonly chunkId: string
  readonly files: readonly string[]
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly junitSha256?: string
}): {
  readonly schema: "quanta.verification-matrix-worker.v1"
  readonly chunkId: string
  readonly files: readonly string[]
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly junitSha256: string | null
} => ({
  schema: "quanta.verification-matrix-worker.v1",
  chunkId: input.chunkId,
  files: input.files,
  outcome: input.outcome,
  junitSha256: input.junitSha256 ?? null,
})

export type AggregateVerdict = "passed" | "failed"

const sameFiles = (left: readonly string[], right: readonly string[]): boolean =>
  [...left].sort().join("\n") === [...right].sort().join("\n")

const reasonsForReceipt = (
  id: string,
  expected: MatrixChunk | undefined,
  receipt: ReturnType<typeof workerReceipt> | undefined,
): readonly string[] => {
  if (receipt === undefined) return [`missing:${id}`]
  const reasons: string[] = []
  if (!sameFiles(expected?.files ?? [], receipt.files)) reasons.push(`stale:${id}`)
  if (receipt.outcome === "cancelled") reasons.push(`cancelled:${id}`)
  if (receipt.outcome === "failed") reasons.push(`failed:${id}`)
  if (receipt.junitSha256 === null && receipt.outcome === "passed") reasons.push(`corrupt:${id}`)
  return reasons
}

export const aggregateMatrixReceipts = (input: {
  readonly expected: readonly MatrixChunk[]
  readonly receipts: readonly ReturnType<typeof workerReceipt>[]
}): {
  readonly verdict: AggregateVerdict
  readonly reasons: readonly string[]
} => {
  const expectedIds = input.expected.map((chunk) => chunk.id).sort()
  const seen = new Map(input.receipts.map((receipt) => [receipt.chunkId, receipt]))
  const reasons = [
    ...(seen.size === input.receipts.length ? [] : ["duplicate"]),
    ...expectedIds.flatMap((id) =>
      reasonsForReceipt(
        id,
        input.expected.find((chunk) => chunk.id === id),
        seen.get(id),
      ),
    ),
    ...[...seen.keys()].filter((id) => !expectedIds.includes(id)).map((id) => `unexpected:${id}`),
  ]
  return reasons.length === 0 && input.receipts.length === expectedIds.length
    ? { verdict: "passed", reasons: [] }
    : { verdict: "failed", reasons }
}
