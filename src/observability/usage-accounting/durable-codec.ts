import type { NormalizedUsage, UsageCost, UsageProvenance, UsageRecord } from "./types"

export interface DurableUsageBucket {
  totalUsd: number
  estimatedUsd: number
  unpricedCalls: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  calls: number
}

export interface DurableUsageV1 {
  readonly version: 1
  readonly continuityLost: boolean
  readonly boundSessionId: string | undefined
  readonly seq: number
  readonly seen: readonly string[]
  readonly retained: readonly UsageRecord[]
  readonly total: DurableUsageBucket
  readonly byModel: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byAgent: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byKind: Readonly<Record<"root" | "subagent", DurableUsageBucket>>
}

export type MintedSequenceRange = [start: number, end: number]

export interface DurableUsageV2 {
  readonly version: 2
  readonly continuityLost: boolean
  readonly boundSessionId: string | undefined
  readonly mint: Readonly<{
    namespace: string
    highWater: number
    admitted: readonly MintedSequenceRange[]
  }>
  readonly externalSeen: readonly string[]
  readonly retained: readonly UsageRecord[]
  readonly total: DurableUsageBucket
  readonly byModel: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byAgent: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byKind: Readonly<Record<"root" | "subagent", DurableUsageBucket>>
}

export type DecodedDurableUsage = DurableUsageV1 | DurableUsageV2

type UnknownRecord = Record<string, unknown>

const BUCKET_KEYS = [
  "totalUsd",
  "estimatedUsd",
  "unpricedCalls",
  "freshInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "calls",
] as const

const isObject = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const isCount = (value: unknown): value is number =>
  isFiniteNonnegative(value) && Number.isSafeInteger(value)

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string"

const MINTED_CALL_PREFIX = "uac2"

export const encodeMintedCallId = (namespace: string, sequence: number): string =>
  `${MINTED_CALL_PREFIX}:${namespace}:${sequence}`

export const parseMintedCallId = (callId: string, namespace: string): number | undefined => {
  const prefix = `${MINTED_CALL_PREFIX}:${namespace}:`
  if (!callId.startsWith(prefix)) return undefined
  const suffix = callId.slice(prefix.length)
  const sequence = Number(suffix)
  return isCount(sequence) && sequence >= 1 && String(sequence) === suffix ? sequence : undefined
}

export const sequenceInRanges = (
  ranges: readonly MintedSequenceRange[],
  sequence: number,
): boolean => {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (range === undefined) return false
    if (sequence < range[0]) high = middle - 1
    else if (sequence > range[1]) low = middle + 1
    else return true
  }
  return false
}

const insertSequenceAt = (ranges: MintedSequenceRange[], index: number, sequence: number): void => {
  const previous = ranges[index - 1]
  const next = ranges[index]
  const joinsPrevious = previous !== undefined && previous[1] + 1 === sequence
  const joinsNext = next !== undefined && sequence + 1 === next[0]
  if (joinsPrevious && joinsNext && previous !== undefined && next !== undefined) {
    previous[1] = next[1]
    ranges.splice(index, 1)
  } else if (joinsPrevious && previous !== undefined) {
    previous[1] = sequence
  } else if (joinsNext && next !== undefined) {
    next[0] = sequence
  } else {
    ranges.splice(index, 0, [sequence, sequence])
  }
}

/** Insert one sequence into sorted, disjoint, non-adjacent exact intervals. */
export const addSequenceToRanges = (ranges: MintedSequenceRange[], sequence: number): boolean => {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (range !== undefined && range[0] <= sequence) low = middle + 1
    else high = middle
  }
  const previous = ranges[low - 1]
  if (previous !== undefined && sequence <= previous[1]) return false
  insertSequenceAt(ranges, low, sequence)
  return true
}

export const countSequences = (ranges: readonly MintedSequenceRange[]): number =>
  ranges.reduce((count, [start, end]) => count + end - start + 1, 0)

const readBucket = (value: unknown): DurableUsageBucket | undefined => {
  if (!isObject(value)) return undefined
  if (
    !isFiniteNonnegative(value.totalUsd) ||
    !isFiniteNonnegative(value.estimatedUsd) ||
    value.estimatedUsd > value.totalUsd ||
    !isCount(value.unpricedCalls) ||
    !isFiniteNonnegative(value.freshInputTokens) ||
    !isFiniteNonnegative(value.cacheReadTokens) ||
    !isFiniteNonnegative(value.cacheWriteTokens) ||
    !isFiniteNonnegative(value.outputTokens) ||
    !isCount(value.calls) ||
    value.unpricedCalls > value.calls
  ) {
    return undefined
  }
  return Object.fromEntries(
    BUCKET_KEYS.map((key) => [key, value[key]]),
  ) as unknown as DurableUsageBucket
}

const readUsage = (value: unknown): NormalizedUsage | undefined => {
  if (!isObject(value)) return undefined
  if (
    typeof value.model !== "string" ||
    (value.provider !== "openai" && value.provider !== "anthropic") ||
    !isFiniteNonnegative(value.freshInputTokens) ||
    !isFiniteNonnegative(value.cacheReadTokens) ||
    !isFiniteNonnegative(value.cacheWriteTokens) ||
    !isFiniteNonnegative(value.outputTokens) ||
    (value.reasoningTokens !== undefined && !isFiniteNonnegative(value.reasoningTokens))
  ) {
    return undefined
  }
  return {
    model: value.model,
    provider: value.provider,
    freshInputTokens: value.freshInputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    outputTokens: value.outputTokens,
    ...(value.reasoningTokens !== undefined ? { reasoningTokens: value.reasoningTokens } : {}),
  }
}

const readCost = (value: unknown): UsageCost | undefined => {
  if (!isObject(value)) return undefined
  if (
    !isFiniteNonnegative(value.totalUsd) ||
    !isFiniteNonnegative(value.freshInputUsd) ||
    !isFiniteNonnegative(value.cacheReadUsd) ||
    !isFiniteNonnegative(value.cacheWriteUsd) ||
    !isFiniteNonnegative(value.outputUsd) ||
    typeof value.pricingKnown !== "boolean" ||
    typeof value.pricingModel !== "string" ||
    typeof value.pricingVersion !== "string"
  ) {
    return undefined
  }
  const componentTotal =
    value.freshInputUsd + value.cacheReadUsd + value.cacheWriteUsd + value.outputUsd
  if (!approximatelyEqual(value.totalUsd, componentTotal)) return undefined
  return {
    totalUsd: value.totalUsd,
    freshInputUsd: value.freshInputUsd,
    cacheReadUsd: value.cacheReadUsd,
    cacheWriteUsd: value.cacheWriteUsd,
    outputUsd: value.outputUsd,
    pricingKnown: value.pricingKnown,
    pricingModel: value.pricingModel,
    pricingVersion: value.pricingVersion,
  }
}

const readProvenance = (value: unknown): UsageProvenance | undefined => {
  if (!isObject(value)) return undefined
  if (
    typeof value.sessionId !== "string" ||
    typeof value.agentId !== "string" ||
    (value.agentKind !== "root" && value.agentKind !== "subagent") ||
    !isCount(value.depth) ||
    !isOptionalString(value.parentAgentId) ||
    !isOptionalString(value.turnId)
  ) {
    return undefined
  }
  return {
    sessionId: value.sessionId,
    agentId: value.agentId,
    agentKind: value.agentKind,
    depth: value.depth,
    ...(value.parentAgentId !== undefined ? { parentAgentId: value.parentAgentId } : {}),
    ...(value.turnId !== undefined ? { turnId: value.turnId } : {}),
  }
}

const readRecord = (value: unknown): UsageRecord | undefined => {
  if (!isObject(value) || typeof value.callId !== "string") return undefined
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined
  const usage = readUsage(value.usage)
  const cost = readCost(value.cost)
  const provenance = readProvenance(value.provenance)
  if (usage === undefined || cost === undefined || provenance === undefined) return undefined
  return { callId: value.callId, at: value.at, usage, cost, provenance }
}

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined
  if (new Set(value).size !== value.length) return undefined
  return [...value]
}

const readRecords = (value: unknown): UsageRecord[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const records: UsageRecord[] = []
  for (const entry of value) {
    const record = readRecord(entry)
    if (record === undefined) return undefined
    records.push(record)
  }
  return records
}

const readBucketEntries = (
  value: unknown,
): Array<readonly [string, DurableUsageBucket]> | undefined => {
  if (!Array.isArray(value)) return undefined
  const entries: Array<readonly [string, DurableUsageBucket]> = []
  const keys = new Set<string>()
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      return undefined
    }
    const bucket = readBucket(entry[1])
    if (bucket === undefined || keys.has(entry[0])) return undefined
    keys.add(entry[0])
    entries.push([entry[0], bucket])
  }
  return entries
}

const approximatelyEqual = (left: number, right: number): boolean =>
  Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))

const sameAggregate = (expected: DurableUsageBucket, actual: DurableUsageBucket): boolean =>
  BUCKET_KEYS.every((key) =>
    key === "calls" || key === "unpricedCalls"
      ? expected[key] === actual[key]
      : approximatelyEqual(expected[key], actual[key]),
  )

const sumBuckets = (buckets: readonly DurableUsageBucket[]): DurableUsageBucket => {
  const total = Object.fromEntries(
    BUCKET_KEYS.map((key) => [key, 0]),
  ) as unknown as DurableUsageBucket
  for (const bucket of buckets) {
    for (const key of BUCKET_KEYS) total[key] += bucket[key]
  }
  return total
}

interface DecodedCommon {
  readonly continuityLost: boolean
  readonly boundSessionId: string | undefined
  readonly retained: readonly UsageRecord[]
  readonly total: DurableUsageBucket
  readonly byModel: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byAgent: ReadonlyArray<readonly [string, DurableUsageBucket]>
  readonly byKind: Readonly<Record<"root" | "subagent", DurableUsageBucket>>
}

const readCommon = (value: UnknownRecord): DecodedCommon | undefined => {
  if (!isOptionalString(value.boundSessionId)) return undefined
  if (value.continuityLost !== undefined && typeof value.continuityLost !== "boolean") {
    return undefined
  }
  const retained = readRecords(value.retained)
  const total = readBucket(value.total)
  const byModel = readBucketEntries(value.byModel)
  const byAgent = readBucketEntries(value.byAgent)
  if (!isObject(value.byKind)) return undefined
  const root = readBucket(value.byKind.root)
  const subagent = readBucket(value.byKind.subagent)
  if (
    retained === undefined ||
    total === undefined ||
    byModel === undefined ||
    byAgent === undefined ||
    root === undefined ||
    subagent === undefined
  ) {
    return undefined
  }
  return {
    continuityLost: value.continuityLost ?? false,
    boundSessionId: value.boundSessionId,
    retained,
    total,
    byModel,
    byAgent,
    byKind: { root, subagent },
  }
}

const hasConsistentAggregates = (
  durable: DecodedCommon,
  seenCount: number,
  hasSeen: (callId: string) => boolean,
): boolean => {
  if (!Number.isSafeInteger(seenCount) || durable.total.calls !== seenCount) return false
  if (durable.retained.length > durable.total.calls) return false
  if ((durable.total.calls === 0) !== (durable.boundSessionId === undefined)) return false
  const retainedIds = new Set<string>()
  for (const record of durable.retained) {
    if (!hasSeen(record.callId) || retainedIds.has(record.callId)) return false
    if (record.provenance.sessionId !== durable.boundSessionId) return false
    retainedIds.add(record.callId)
  }
  return (
    sameAggregate(durable.total, sumBuckets(durable.byModel.map((entry) => entry[1]))) &&
    sameAggregate(durable.total, sumBuckets(durable.byAgent.map((entry) => entry[1]))) &&
    sameAggregate(durable.total, sumBuckets([durable.byKind.root, durable.byKind.subagent]))
  )
}

const readRanges = (value: unknown): MintedSequenceRange[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const ranges: MintedSequenceRange[] = []
  let previousEnd = -1
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined
    const [start, end] = entry
    if (!isCount(start) || !isCount(end) || start < 1 || end < start) return undefined
    if (start <= previousEnd + 1) return undefined
    ranges.push([start, end])
    previousEnd = end
  }
  return ranges
}

const decodeV1 = (value: UnknownRecord): DurableUsageV1 | undefined => {
  if (!isCount(value.seq)) return undefined
  const common = readCommon(value)
  const seen = readStringArray(value.seen)
  if (common === undefined || seen === undefined) return undefined
  const seenSet = new Set(seen)
  const durable: DurableUsageV1 = { version: 1, seq: value.seq, seen, ...common }
  return hasConsistentAggregates(common, seen.length, (callId) => seenSet.has(callId))
    ? durable
    : undefined
}

const decodeV2 = (value: UnknownRecord): DurableUsageV2 | undefined => {
  const common = readCommon(value)
  const externalSeen = readStringArray(value.externalSeen)
  if (common === undefined || externalSeen === undefined || !isObject(value.mint)) return undefined
  const { namespace, highWater } = value.mint
  if (
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.includes(":") ||
    !isCount(highWater)
  ) {
    return undefined
  }
  const admitted = readRanges(value.mint.admitted)
  if (admitted === undefined || admitted.some((range) => range[1] > highWater)) return undefined
  const externalSet = new Set(externalSeen)
  for (const callId of externalSeen) {
    const sequence = parseMintedCallId(callId, namespace)
    if (sequence !== undefined && sequenceInRanges(admitted, sequence)) return undefined
  }
  const seenCount = externalSeen.length + countSequences(admitted)
  const hasSeen = (callId: string): boolean => {
    if (externalSet.has(callId)) return true
    const sequence = parseMintedCallId(callId, namespace)
    return sequence !== undefined && sequenceInRanges(admitted, sequence)
  }
  const durable: DurableUsageV2 = {
    version: 2,
    mint: { namespace, highWater, admitted },
    externalSeen,
    ...common,
  }
  return hasConsistentAggregates(common, seenCount, hasSeen) ? durable : undefined
}

/** Decode an untrusted V1/V2 payload into fresh objects. No exception escapes. */
export const decodeDurableUsage = (json: string): DecodedDurableUsage | undefined => {
  try {
    const value: unknown = JSON.parse(json)
    if (!isObject(value)) return undefined
    if (value.v === 1) return decodeV1(value)
    if (value.v === 2) return decodeV2(value)
    return undefined
  } catch {
    return undefined
  }
}

/** Compatibility entry point for callers that explicitly accept only V1. */
export const decodeDurableUsageV1 = (json: string): DurableUsageV1 | undefined => {
  const decoded = decodeDurableUsage(json)
  return decoded?.version === 1 ? decoded : undefined
}
