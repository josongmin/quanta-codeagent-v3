import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface ScanReachRecord {
  readonly id: string
  readonly walked: number
  readonly matched?: number
}

const parseScanReachRecord = (line: string, sink: string): ScanReachRecord => {
  const record = JSON.parse(line) as ScanReachRecord
  const invalidMatched =
    record.matched !== undefined && (!Number.isSafeInteger(record.matched) || record.matched < 0)
  if (
    record.id === "" ||
    !Number.isSafeInteger(record.walked) ||
    record.walked < 0 ||
    invalidMatched
  ) {
    throw new Error(`[test:shards] invalid scan-reach record in ${sink}`)
  }
  return record
}

const mergeRecord = (
  previous: Omit<ScanReachRecord, "id"> | undefined,
  record: ScanReachRecord,
): Omit<ScanReachRecord, "id"> => {
  const walked = previous === undefined ? record.walked : Math.min(previous.walked, record.walked)
  const matchedValues = [previous?.matched, record.matched].filter(
    (value): value is number => value !== undefined,
  )
  return matchedValues.length === 0 ? { walked } : { walked, matched: Math.min(...matchedValues) }
}

export const mergeScanReachSinks = (sinks: readonly string[]): readonly ScanReachRecord[] => {
  const records = new Map<string, Omit<ScanReachRecord, "id">>()
  for (const sink of sinks) {
    const lines = readFileSync(sink, "utf8").split("\n").filter(Boolean)
    for (const line of lines) {
      const record = parseScanReachRecord(line, sink)
      records.set(record.id, mergeRecord(records.get(record.id), record))
    }
  }
  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reach]) => ({ id, ...reach }))
}

export const writeScanReachReceiptAtomic = (input: {
  readonly path: string
  readonly head: string
  readonly suite: "unit" | "full"
  readonly manifestSha256: string
  readonly sinks: readonly string[]
}): void => {
  const records = mergeScanReachSinks(input.sinks)
  if (records.length === 0) {
    throw new Error("[test:shards] scan-reach receipt is empty after a successful suite")
  }
  mkdirSync(dirname(input.path), { recursive: true })
  const temporary = `${input.path}.tmp-${process.pid}`
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        schema: "quanta.scan-reach-receipt.v1",
        head: input.head,
        suite: input.suite,
        manifestSha256: input.manifestSha256,
        childExit: 0,
        records,
      },
      null,
      2,
    )}\n`,
  )
  renameSync(temporary, input.path)
}
