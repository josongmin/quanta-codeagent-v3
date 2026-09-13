import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Per-file scheduling samples. v1 mixed JUnit body time and an evenly spread
 * chunk residual into one opaque number, then overwrote it with the newest
 * sample. v2 keeps those components and a bounded same-policy cohort.
 */
export const TEST_TIMING_SCHEMA = "quanta.test-timings.v2" as const
export const TEST_TIMING_JOURNAL_SCHEMA = "quanta.test-timings-journal.v1" as const
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

export type TimingSample = Omit<TimingObservation, "sampledAtMs">

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

/**
 * `typeof null === "object"`, and `typeof []` is "object" too.
 *
 * MEASURED DEFECT (2026-09-12): the store validator accepted
 * `{"schema":"quanta.test-timings.v2","entries":null}` because it only asked
 * `typeof store.entries !== "object"`. `Object.entries(null)` then threw
 * `TypeError: Object.entries requires that input parameter not be null or
 * undefined` out of `loadTestTimings`, which is called from the campaign's
 * planning path — so ONE corrupt advisory hint took down a whole verdict.
 * JSON.parse only ever produces `Object.prototype` (or array) objects, so the
 * prototype test below is exact rather than a heuristic.
 */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

const isTimingObservation = (value: unknown): value is TimingObservation => {
  if (!isPlainRecord(value)) return false
  const row = value
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

export type TimingStoreColdReason =
  | "absent"
  | "unreadable"
  | "corrupt-json"
  | "foreign-schema"
  | "invalid-entries"
  | "no-fresh-samples"

export interface TimingStoreRead {
  /** `cold` NEVER carries a measurement; the planner falls back deterministically. */
  readonly kind: "measured" | "cold"
  readonly timings: ReadonlyMap<string, number>
  readonly reason: TimingStoreColdReason | "fresh-samples"
  /** Where a structurally invalid hint was moved, when quarantine was possible. */
  readonly quarantinedTo?: string
  readonly expiredSamples: number
  readonly futureSkewSamples: number
  readonly invalidSamples: number
}

type StoreParse =
  | { readonly kind: "ok"; readonly store: TimingStoreFile }
  | { readonly kind: "absent"; readonly reason: "absent" | "unreadable" }
  | {
      readonly kind: "invalid"
      readonly reason: "corrupt-json" | "foreign-schema" | "invalid-entries"
      readonly raw: string
    }

const parseStore = (path: string): StoreParse => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: "absent", reason: code === "ENOENT" ? "absent" : "unreadable" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid", reason: "corrupt-json", raw }
  }
  if (!isPlainRecord(parsed)) return { kind: "invalid", reason: "corrupt-json", raw }
  if (parsed.schema !== TEST_TIMING_SCHEMA) {
    return { kind: "invalid", reason: "foreign-schema", raw }
  }
  // The exact hole: `entries: null` and `entries: []` both answer "object".
  if (!isPlainRecord(parsed.entries)) return { kind: "invalid", reason: "invalid-entries", raw }
  return { kind: "ok", store: parsed as unknown as TimingStoreFile }
}

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex")

/**
 * Move a structurally invalid hint aside instead of re-reading it every run.
 *
 * The name is derived from the CONTENT, so the same damage quarantines to the
 * same path however many campaigns hit it — a pid/timestamp suffix would grow
 * the shared cache without bound on a repeatedly-corrupt store.
 */
export const quarantineTimingStore = (path: string, raw: string): string | undefined => {
  const target = `${path}.quarantine-${sha256(raw).slice(0, 16)}.json`
  try {
    renameSync(path, target)
    return target
  } catch {
    return undefined
  }
}

interface SampleTriage {
  readonly fresh: readonly TimingObservation[]
  readonly expired: number
  readonly futureSkew: number
  readonly invalid: number
}

/**
 * TTL in BOTH directions.
 *
 * MEASURED DEFECT (2026-09-12): the filter was `now - sampledAt <= maxAge`,
 * which is unbounded above. A sample dated 100 years ahead satisfied it
 * forever, outlived every honest sample, and — being the newest — chose the
 * cohort the median is taken over. Reproduced: one 50ms file whose store also
 * held a future-dated 999,999ms sample planned at 500,025ms, and at
 * `now + 99 years` the future sample was the ONLY authority left.
 *
 * The bound is zero future tolerance, which is not a new threshold: it is the
 * rule `loadSuccessfulTestShardReceipt` already applies to receipts
 * (`createdAtMs > nowMs` is `expired`). Timing samples and receipts are
 * written by the same campaign on the same clock, so they get the same rule.
 */
const triageSamples = (entry: unknown, nowMs: number): SampleTriage => {
  const samples = isPlainRecord(entry) && Array.isArray(entry.samples) ? entry.samples : []
  const fresh: TimingObservation[] = []
  let expired = 0
  let futureSkew = 0
  let invalid = 0
  for (const sample of samples) {
    if (!isTimingObservation(sample)) {
      invalid += 1
      continue
    }
    const ageMs = nowMs - sample.sampledAtMs
    if (ageMs < 0) futureSkew += 1
    else if (ageMs > TEST_TIMING_MAX_AGE_MS) expired += 1
    else fresh.push(sample)
  }
  return { fresh, expired, futureSkew, invalid }
}

const cohortKey = (sample: TimingObservation): string =>
  `${sample.runnerClass}\0${sample.policyDigest}\0${sample.intraParallel}`

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 1
  return Math.round(((sorted[middle - 1] ?? 1) + (sorted[middle] ?? 1)) / 2)
}

const cohortMedian = (samples: readonly TimingObservation[]): number | undefined => {
  const newest = samples.reduce<TimingObservation | undefined>(
    (found, sample) =>
      found === undefined || sample.sampledAtMs > found.sampledAtMs ? sample : found,
    undefined,
  )
  if (newest === undefined) return undefined
  const key = cohortKey(newest)
  const cohort = samples.filter((sample) => cohortKey(sample) === key)
  return median(cohort.map(({ schedulingWeightMs }) => schedulingWeightMs))
}

const coldRead = (
  reason: TimingStoreColdReason,
  quarantinedTo?: string,
  counts: { expired: number; futureSkew: number; invalid: number } = {
    expired: 0,
    futureSkew: 0,
    invalid: 0,
  },
): TimingStoreRead => ({
  kind: "cold",
  timings: new Map(),
  reason,
  ...(quarantinedTo === undefined ? {} : { quarantinedTo }),
  expiredSamples: counts.expired,
  futureSkewSamples: counts.futureSkew,
  invalidSamples: counts.invalid,
})

/**
 * Typed read. A hostile or damaged hint is a `cold` result with a reason — it
 * is never an exception and never a `measured` map.
 */
export const readTestTimingStore = (
  path: string,
  options: { readonly nowMs?: number; readonly quarantine?: boolean } = {},
): TimingStoreRead => {
  const nowMs = options.nowMs ?? Date.now()
  const parsed = parseStore(path)
  if (parsed.kind === "absent") return coldRead(parsed.reason)
  if (parsed.kind === "invalid") {
    const quarantinedTo =
      options.quarantine === false ? undefined : quarantineTimingStore(path, parsed.raw)
    return coldRead(parsed.reason, quarantinedTo)
  }
  const timings = new Map<string, number>()
  let expired = 0
  let futureSkew = 0
  let invalid = 0
  for (const [file, entry] of Object.entries(parsed.store.entries)) {
    const triage = triageSamples(entry, nowMs)
    expired += triage.expired
    futureSkew += triage.futureSkew
    invalid += triage.invalid
    const weight = cohortMedian(triage.fresh)
    if (weight !== undefined) timings.set(file, weight)
  }
  const counts = { expired, futureSkew, invalid }
  if (timings.size === 0) return coldRead("no-fresh-samples", undefined, counts)
  return {
    kind: "measured",
    timings,
    reason: "fresh-samples",
    expiredSamples: expired,
    futureSkewSamples: futureSkew,
    invalidSamples: invalid,
  }
}

/** Corrupt, v1, or foreign content is an empty store, never current proof. */
export const loadTestTimings = (path: string, nowMs = Date.now()): ReadonlyMap<string, number> =>
  readTestTimingStore(path, { nowMs }).timings

const foldSamples = (
  path: string,
  updates: ReadonlyMap<string, TimingSample>,
  nowMs: number,
  sampledAtMs: number,
): Map<string, TimingObservation[]> => {
  const parsed = parseStore(path)
  const entries = new Map<string, TimingObservation[]>()
  if (parsed.kind === "ok") {
    for (const [file, entry] of Object.entries(parsed.store.entries)) {
      const { fresh } = triageSamples(entry, nowMs)
      if (fresh.length > 0) entries.set(file, [...fresh])
    }
  }
  for (const [file, update] of updates) {
    const sample: TimingObservation = { ...update, sampledAtMs }
    if (!isTimingObservation(sample)) continue
    // Through `appendSample`, the one idempotent append. This loop appended
    // inline, so the direct-merge path had no dedupe — and the commit that added
    // the dedupe claimed all three call sites had it.
    appendSample(entries, file, sample)
  }
  return entries
}

const writeStoreAtomic = (
  path: string,
  entries: ReadonlyMap<string, TimingObservation[]>,
): void => {
  const payload: TimingStoreFile = {
    schema: TEST_TIMING_SCHEMA,
    entries: Object.fromEntries(
      [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, samples]) => [file, { samples }]),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export const mergeTestTimingObservations = (
  path: string,
  updates: ReadonlyMap<string, TimingSample>,
  nowMs = Date.now(),
): void => writeStoreAtomic(path, foldSamples(path, updates, nowMs, nowMs))

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

/* ─────────────────────────────────────────────────────────────────────────
 *  JOURNAL — O(1) store writes per campaign
 * ───────────────────────────────────────────────────────────────────────── */

export interface TimingCommitResult {
  readonly files: number
  readonly storeWrites: number
  readonly recoveredJournals: number
  readonly recoveredFiles: number
}

export interface TimingJournal {
  readonly path: string
  readonly storePath: string
  /** Chunk-scoped append. Cost is the appended bytes, not the store size. */
  record(samples: ReadonlyMap<string, TimingSample>, nowMs?: number): void
  /** The single read-modify-write of the campaign. */
  commit(nowMs?: number): TimingCommitResult
  readonly recordedFiles: number
  readonly appends: number
}

const JOURNAL_SUFFIX = ".ndjson"

const journalPrefix = (storePath: string): string => `${basename(storePath)}.journal-`

const journalPidOf = (storePath: string, name: string): number | undefined => {
  const prefix = journalPrefix(storePath)
  if (!name.startsWith(prefix) || !name.endsWith(JOURNAL_SUFFIX)) return undefined
  const pid = Number.parseInt(name.slice(prefix.length).split("-")[0] ?? "", 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** EPERM means the pid exists and belongs to someone else — still alive. */
const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const parseJournalLine = (line: string): ReadonlyMap<string, TimingObservation> | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isPlainRecord(parsed) || parsed.schema !== TEST_TIMING_JOURNAL_SCHEMA) return undefined
  if (!isPlainRecord(parsed.observations)) return undefined
  const out = new Map<string, TimingObservation>()
  for (const [file, sample] of Object.entries(parsed.observations)) {
    if (typeof file === "string" && file !== "" && isTimingObservation(sample))
      out.set(file, sample)
  }
  return out
}

const readJournalFile = (path: string): ReadonlyMap<string, TimingObservation> => {
  const merged = new Map<string, TimingObservation>()
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return merged
  }
  for (const line of raw.split("\n")) {
    if (line === "") continue
    for (const [file, sample] of parseJournalLine(line) ?? new Map()) merged.set(file, sample)
  }
  return merged
}

export interface JournalRecovery {
  readonly journals: number
  readonly files: number
  readonly skippedLive: number
}

/**
 * Fold journals left by interrupted campaigns back into the store.
 *
 * A journal whose owning pid is still alive belongs to a RUNNING campaign
 * (possibly in a sibling worktree sharing this git-common cache) and is left
 * untouched — the same "not mine is not stale" rule the receipt prune uses.
 */
const abandonedJournalPaths = (
  storePath: string,
  isAlive: (pid: number) => boolean,
  exclude: string | undefined,
): { readonly paths: readonly string[]; readonly skippedLive: number } => {
  const dir = dirname(storePath)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { paths: [], skippedLive: 0 }
  }
  const paths: string[] = []
  let skippedLive = 0
  for (const name of names) {
    const pid = journalPidOf(storePath, name)
    if (pid === undefined) continue
    const path = join(dir, name)
    if (exclude !== undefined && path === exclude) continue
    if (isAlive(pid)) {
      skippedLive += 1
      continue
    }
    paths.push(path)
  }
  return { paths, skippedLive }
}

/**
 * Add one observation, IDEMPOTENTLY.
 *
 * # The crash window this closes
 *
 * `recoverAbandonedTimingJournals` writes the store and THEN removes the
 * journals it folded. A process that dies between those two statements leaves a
 * journal whose observations are already in the store, and the next campaign
 * folds it again. Nothing deduplicated, so the same observation was appended
 * once per recovery — and the window is only `TEST_TIMING_MAX_SAMPLES`.
 *
 * MEASURED, one abandoned journal carrying a single 2,000ms observation
 * replayed against a store holding three honest samples of 100, 900 and 500ms:
 *
 *   baseline          [100, 900, 500]
 *   after replay 1    [100, 900, 500, 2000]
 *   after replay 3    [100, 900, 500, 2000, 2000, 2000]
 *   after replay 12   [2000 x 12]   — 0 of 3 honest samples left
 *
 * The scheduler plans chunk membership from these weights, so a crash loop does
 * not merely lose history: it manufactures a weight the corpus never produced
 * and balances every future campaign against it.
 *
 * Identity is `(file, sampledAtMs)`. A file belongs to exactly one chunk per
 * campaign and the timestamp is read from the clock at observation time, so two
 * samples of one file at the same millisecond are the same observation, never
 * two.
 */
const appendSample = (
  entries: Map<string, TimingObservation[]>,
  file: string,
  sample: TimingObservation,
): void => {
  const existing = entries.get(file) ?? []
  if (existing.some((seen) => seen.sampledAtMs === sample.sampledAtMs)) return
  const samples = [...existing, sample]
    .sort((left, right) => left.sampledAtMs - right.sampledAtMs)
    .slice(-TEST_TIMING_MAX_SAMPLES)
  entries.set(file, samples)
}

const withinTtl = (sampledAtMs: number, nowMs: number): boolean => {
  const ageMs = nowMs - sampledAtMs
  return ageMs >= 0 && ageMs <= TEST_TIMING_MAX_AGE_MS
}

/**
 * Fold journals left by interrupted campaigns back into the store.
 *
 * A journal whose owning pid is still alive belongs to a RUNNING campaign
 * (possibly in a sibling worktree sharing this git-common cache) and is left
 * untouched — the same "not mine is not stale" rule the receipt prune uses.
 */
export const recoverAbandonedTimingJournals = (
  storePath: string,
  options: {
    readonly nowMs?: number
    readonly isAlive?: (pid: number) => boolean
    /** This campaign's own journal, which its own commit folds in. */
    readonly exclude?: string
  } = {},
): JournalRecovery => {
  const nowMs = options.nowMs ?? Date.now()
  const { paths, skippedLive } = abandonedJournalPaths(
    storePath,
    options.isAlive ?? processIsAlive,
    options.exclude,
  )
  if (paths.length === 0) return { journals: 0, files: 0, skippedLive }
  const merged = new Map<string, TimingObservation>()
  for (const path of paths) {
    for (const [file, sample] of readJournalFile(path)) merged.set(file, sample)
  }
  const entries = foldSamples(storePath, new Map(), nowMs, nowMs)
  for (const [file, sample] of merged) {
    if (withinTtl(sample.sampledAtMs, nowMs)) appendSample(entries, file, sample)
  }
  writeStoreAtomic(storePath, entries)
  for (const path of paths) rmSync(path, { force: true })
  return { journals: paths.length, files: merged.size, skippedLive }
}

/**
 * MEASURED DEFECT (2026-09-12): every chunk completion called
 * `mergeTestTimingObservations`, which read, validated, sorted and rewrote the
 * ENTIRE store — up to 44 times for one full campaign, each pass touching
 * every file in the corpus. The journal makes each chunk one append of its own
 * observations and leaves exactly ONE store write, at campaign end.
 */
export const openTimingJournal = (input: {
  readonly storePath: string
  readonly journalPath?: string
}): TimingJournal => {
  const storePath = input.storePath
  const path =
    input.journalPath ??
    join(
      dirname(storePath),
      `${journalPrefix(storePath)}${process.pid}-${randomUUID()}${JOURNAL_SUFFIX}`,
    )
  const pending = new Map<string, TimingObservation>()
  let appends = 0
  return {
    path,
    storePath,
    get recordedFiles() {
      return pending.size
    },
    get appends() {
      return appends
    },
    record(samples, nowMs = Date.now()) {
      const observations: Record<string, TimingObservation> = {}
      for (const [file, sample] of samples) {
        const observation: TimingObservation = { ...sample, sampledAtMs: nowMs }
        if (!isTimingObservation(observation)) continue
        pending.set(file, observation)
        observations[file] = observation
      }
      if (Object.keys(observations).length === 0) return
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(
        path,
        `${JSON.stringify({ schema: TEST_TIMING_JOURNAL_SCHEMA, observations })}\n`,
      )
      appends += 1
    },
    commit(nowMs = Date.now()) {
      const recovered = recoverAbandonedTimingJournals(storePath, { nowMs, exclude: path })
      const entries = foldSamples(storePath, new Map(), nowMs, nowMs)
      for (const [file, sample] of pending) appendSample(entries, file, sample)
      writeStoreAtomic(storePath, entries)
      rmSync(path, { force: true })
      return {
        files: pending.size,
        storeWrites: recovered.journals > 0 ? 2 : 1,
        recoveredJournals: recovered.journals,
        recoveredFiles: recovered.files,
      }
    },
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 *  JUNIT HARVEST
 * ───────────────────────────────────────────────────────────────────────── */

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

/** Longest single test CASE in a JUnit body, in ms; -1 when none is parseable. */
export const junitMaxCaseMs = (junitXml: string): number => {
  let worst = -1
  for (const match of junitXml.matchAll(/<testcase\b[^>]*>/g)) {
    const seconds = Number.parseFloat(attribute(match[0] ?? "", "time") ?? "")
    if (Number.isFinite(seconds) && seconds >= 0) worst = Math.max(worst, seconds * 1_000)
  }
  return worst
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
): ReadonlyMap<string, TimingSample> => {
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

/* ─────────────────────────────────────────────────────────────────────────
 *  RECEIPT REHYDRATION
 * ───────────────────────────────────────────────────────────────────────── */

export interface ReceiptTimingRecord extends TimingSample {
  readonly file: string
}

export const isReceiptTimingRecord = (value: unknown): value is ReceiptTimingRecord =>
  isPlainRecord(value) &&
  typeof value.file === "string" &&
  value.file !== "" &&
  isTimingObservation({ ...value, sampledAtMs: 0 })

/**
 * A cache HIT must restore the scheduling evidence the executed run produced,
 * or `unit-speed-budget` sees a green shard with no timings forever. The
 * sample keeps the RECEIPT's creation time, never `now`: a replayed
 * measurement must age out exactly like the one it replays.
 */
export const receiptTimingSamples = (
  records: readonly ReceiptTimingRecord[],
): ReadonlyMap<string, TimingSample> =>
  new Map(records.map(({ file, ...sample }) => [file, sample]))

export const rehydrateTimingsFromReceipts = (
  storePath: string,
  receipts: readonly {
    readonly createdAtMs: number
    readonly timingObservations: readonly ReceiptTimingRecord[]
  }[],
  nowMs = Date.now(),
): number => {
  const entries = foldSamples(storePath, new Map(), nowMs, nowMs)
  let restored = 0
  for (const receipt of receipts) {
    for (const { file, ...sample } of receipt.timingObservations) {
      const observation: TimingObservation = { ...sample, sampledAtMs: receipt.createdAtMs }
      if (!isTimingObservation(observation)) continue
      if (!withinTtl(observation.sampledAtMs, nowMs)) continue
      appendSample(entries, file, observation)
      restored += 1
    }
  }
  if (restored > 0) writeStoreAtomic(storePath, entries)
  return restored
}
