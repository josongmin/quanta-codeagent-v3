import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Per-file scheduling samples. v1 mixed JUnit body time and an evenly spread
 * chunk residual into one opaque number, then overwrote it with the newest
 * sample. v2 keeps those components and a bounded same-policy cohort.
 */
export const TEST_TIMING_SCHEMA = "quanta.test-timings.v2" as const
export const TEST_TIMING_MAX_AGE_MS = 14 * 24 * 60 * 60_000
export const TEST_TIMING_MAX_SAMPLES = 12

export interface TimingObservation {
  readonly schedulingWeightMs: number
  readonly suiteMs: number
  readonly chunkOverheadShareMs: number
  readonly observedChunkWallMs: number
  readonly sampledAtMs: number
  readonly runnerClass: string
  readonly policyDigest: string
  readonly intraParallel: number
  readonly loadPerCore: number | null
}

export interface TimingObservationContext {
  readonly runnerClass: string
  readonly policyDigest: string
  readonly intraParallel: number
  readonly loadPerCore: number | null
}

interface TimingEntry {
  readonly samples: readonly TimingObservation[]
}

interface TimingStoreFile {
  readonly schema: typeof TEST_TIMING_SCHEMA
  readonly entries: Record<string, TimingEntry>
}

const positiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

const nonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const isTimingObservation = (value: unknown): value is TimingObservation => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return (
    positiveFinite(row.schedulingWeightMs) &&
    nonNegativeFinite(row.suiteMs) &&
    nonNegativeFinite(row.chunkOverheadShareMs) &&
    positiveFinite(row.observedChunkWallMs) &&
    Number.isSafeInteger(row.sampledAtMs) &&
    typeof row.runnerClass === "string" &&
    row.runnerClass !== "" &&
    typeof row.policyDigest === "string" &&
    row.policyDigest !== "" &&
    Number.isSafeInteger(row.intraParallel) &&
    (row.intraParallel as number) > 0 &&
    (row.loadPerCore === null || nonNegativeFinite(row.loadPerCore))
  )
}

const readStore = (path: string): TimingStoreFile | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const store = parsed as Partial<TimingStoreFile>
  if (store.schema !== TEST_TIMING_SCHEMA || typeof store.entries !== "object") return undefined
  return store as TimingStoreFile
}

const recentSamples = (
  entry: TimingEntry | undefined,
  nowMs: number,
): readonly TimingObservation[] =>
  (Array.isArray(entry?.samples) ? entry.samples : []).filter(
    (sample) => isTimingObservation(sample) && nowMs - sample.sampledAtMs <= TEST_TIMING_MAX_AGE_MS,
  )

const cohortKey = (sample: TimingObservation): string =>
  `${sample.runnerClass}\0${sample.policyDigest}\0${sample.intraParallel}`

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 1
  return Math.round(((sorted[middle - 1] ?? 1) + (sorted[middle] ?? 1)) / 2)
}

/** Corrupt, v1, or foreign content is an empty store, never current proof. */
export const loadTestTimings = (path: string, nowMs = Date.now()): ReadonlyMap<string, number> => {
  const store = readStore(path)
  if (store === undefined) return new Map()
  const timings = new Map<string, number>()
  for (const [file, entry] of Object.entries(store.entries)) {
    const samples = recentSamples(entry, nowMs)
    const newest = samples.reduce<TimingObservation | undefined>(
      (found, sample) =>
        found === undefined || sample.sampledAtMs > found.sampledAtMs ? sample : found,
      undefined,
    )
    if (newest === undefined) continue
    const key = cohortKey(newest)
    const cohort = samples.filter((sample) => cohortKey(sample) === key)
    timings.set(file, median(cohort.map(({ schedulingWeightMs }) => schedulingWeightMs)))
  }
  return timings
}

export const mergeTestTimingObservations = (
  path: string,
  updates: ReadonlyMap<string, Omit<TimingObservation, "sampledAtMs">>,
  nowMs = Date.now(),
): void => {
  const existing = readStore(path)
  const entries = new Map<string, TimingObservation[]>()
  for (const [file, entry] of Object.entries(existing?.entries ?? {})) {
    const samples = recentSamples(entry, nowMs)
    if (samples.length > 0) entries.set(file, [...samples])
  }
  for (const [file, update] of updates) {
    const sample: TimingObservation = { ...update, sampledAtMs: nowMs }
    if (!isTimingObservation(sample)) continue
    const samples = [...(entries.get(file) ?? []), sample]
      .sort((left, right) => left.sampledAtMs - right.sampledAtMs)
      .slice(-TEST_TIMING_MAX_SAMPLES)
    entries.set(file, samples)
  }
  const payload: TimingStoreFile = {
    schema: TEST_TIMING_SCHEMA,
    entries: Object.fromEntries(
      [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, samples]) => [file, { samples }]),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Compatibility helper for focused callers; production harvest uses rich observations. */
export const mergeTestTimings = (
  path: string,
  updates: ReadonlyMap<string, number>,
  nowMs = Date.now(),
): void =>
  mergeTestTimingObservations(
    path,
    new Map(
      [...updates].map(([file, ms]) => [
        file,
        {
          schedulingWeightMs: Math.max(1, Math.round(ms)),
          suiteMs: Math.max(0, ms),
          chunkOverheadShareMs: 0,
          observedChunkWallMs: Math.max(1, ms),
          runnerClass: "compatibility",
          policyDigest: "compatibility",
          intraParallel: 1,
          loadPerCore: null,
        },
      ]),
    ),
    nowMs,
  )

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)
  return match?.[1]
}

const decodeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

/** Exact test-file set independently emitted by Bun's JUnit reporter. */
export const junitExecutedFiles = (junitXml: string): readonly string[] => {
  const files = new Set<string>()
  for (const match of junitXml.matchAll(/<testsuite\b[^>]*>/g)) {
    const file = attribute(match[0] ?? "", "file")
    if (file !== undefined && file !== "") files.add(decodeXmlAttribute(file))
  }
  return [...files].sort((left, right) => left.localeCompare(right))
}

const suiteTimings = (junitXml: string): ReadonlyMap<string, number> => {
  const result = new Map<string, number>()
  for (const match of junitXml.matchAll(/<testsuite\b[^>]*>/g)) {
    const tag = match[0] ?? ""
    const file = attribute(tag, "file")
    const seconds = Number.parseFloat(attribute(tag, "time") ?? "")
    if (file !== undefined && Number.isFinite(seconds) && seconds >= 0) {
      result.set(file, (result.get(file) ?? 0) + seconds * 1_000)
    }
  }
  return result
}

export const harvestChunkTimingObservations = (
  junitXml: string,
  files: readonly string[],
  chunkElapsedMs: number,
  context: TimingObservationContext,
): ReadonlyMap<string, Omit<TimingObservation, "sampledAtMs">> => {
  if (files.length === 0) return new Map()
  const suites = suiteTimings(junitXml)
  const attributed = files.reduce((sum, file) => sum + (suites.get(file) ?? 0), 0)
  const overheadShare = Math.max(0, chunkElapsedMs - attributed) / files.length
  return new Map(
    files.map((file) => {
      const suiteMs = suites.get(file) ?? 0
      return [
        file,
        {
          schedulingWeightMs: Math.max(1, Math.round(suiteMs + overheadShare)),
          suiteMs,
          chunkOverheadShareMs: overheadShare,
          observedChunkWallMs: Math.max(1, chunkElapsedMs),
          ...context,
        },
      ]
    }),
  )
}

/** Compatibility projection used by existing focused tests. */
export const harvestChunkTimings = (
  junitXml: string,
  files: readonly string[],
  chunkElapsedMs: number,
): ReadonlyMap<string, number> =>
  new Map(
    [
      ...harvestChunkTimingObservations(junitXml, files, chunkElapsedMs, {
        runnerClass: "compatibility",
        policyDigest: "compatibility",
        intraParallel: 1,
        loadPerCore: null,
      }),
    ].map(([file, observation]) => [file, observation.schedulingWeightMs]),
  )
