import { randomUUID } from "node:crypto"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { CAPTURE_TIMEOUT_MS, runBoundedCapture } from "./bounded-child"
import { executedFileSetDigest } from "./executed-file-set"
import { externalToolchainFingerprint, hostCapabilityFingerprint } from "./external-toolchain"
import { AUTHORITATIVE_SCAN_TIERS, type ScanReachAuthority } from "./scan-reach-authority"
import { timeoutCompatibility } from "./test-shard-timeout-policy"
import {
  isReceiptTimingRecord,
  junitMaxCaseMs,
  type ReceiptTimingRecord,
} from "./test-shard-timings"
import { isVerdictRelevantEnvKey, verdictDotenvSha256 } from "./verdict-env"

export const TEST_SHARD_CACHE_TTL_MS = 24 * 60 * 60_000
export const TEST_SHARD_RECEIPT_SCHEMA = "quanta.test-shard-success.v4" as const

/**
 * How much of the world a chunk's cache identity has to cover.
 *
 * `whole-tree` is the FAIL-SAFE: the complete tracked tree, the complete
 * manifest, and the fingerprint of every external tool the host has. Any file
 * the chunk contains that is not certified pins the whole chunk here.
 *
 * `certified` is earned. Every file in the chunk must be both input-certified
 * (declared-v1: its own bytes plus its transitive import closure, and no
 * forbidden edge that could read something undeclared) and resource-certified
 * (TVH-04: its resource claims are known and its source digest still matches).
 * Such a chunk's identity is its own declared inputs, the tool capabilities it
 * actually claims, and the producer receipts it consumes — nothing global.
 */
export type ShardScopeKind = "whole-tree" | "certified"

export interface TestShardCacheIdentity {
  readonly scopeKind: ShardScopeKind
  /**
   * Content hash of everything tracked that a test can read. See
   * {@link trackedTreeSha256}: this replaced a `src`+`tools` scan that could
   * not see `tests/setup.ts`, `bunfig.toml` or any fixture. Part of the key
   * for `whole-tree` chunks ONLY — a certified chunk states its own inputs.
   */
  readonly treeSha256: string
  /** Tier namespace. Key material for `whole-tree` chunks ONLY. */
  readonly suite: string
  /** Key material for `whole-tree` chunks ONLY. */
  readonly manifestSha256: string
  readonly shardIndex: number
  readonly shardFileCount: number
  readonly shardFilesSha256: string
  /** Bun/node/platform/arch. ALWAYS key material: it runs every test. */
  readonly runtimeSha256: string
  /** All 27 external tools when `whole-tree`; only the claimed ones when certified. */
  readonly toolScopeSha256: string
  readonly testEnvSha256: string
  readonly junit: boolean
  /** Exact intra-worker file width. Concurrent green does not answer for serial. */
  readonly intraParallel: number
  readonly executionPolicySha256: string
  /** Stable policy/base/cap — NEVER the load-derived instance value. */
  readonly timeoutPolicySha256: string
  readonly inputScopeSha256: string
  /** Digest of the shared producer artifacts this chunk consumes. */
  readonly producerReceiptsSha256: string
}

export interface SuccessfulTestShardReceipt extends TestShardCacheIdentity {
  readonly schema: typeof TEST_SHARD_RECEIPT_SCHEMA
  readonly createdAtMs: number
  readonly expiresAtMs: number
  /**
   * The EXACT repository-relative ids the worker's JUnit says it ran.
   *
   * v3 stored a COUNT. A cache HIT therefore restored the claim "146 files
   * ran", which 146 of somebody else's files satisfies: the receipt recorded
   * the plan and never the execution, so nothing downstream could tell. v4
   * stores the set and checks it against the identity it is filed under.
   */
  readonly executedFileIds: readonly string[]
  /** sha256 over the sorted ids. Checked against the list on every read. */
  readonly executedDigestSha256: string
  readonly scanReachRecords: readonly ScanReachRecord[]
  /** Compatibility field, NOT identity: the load-derived value this run used. */
  readonly testTimeoutMs: number
  /** Longest single case observed under that timeout; -1 when unparseable. */
  readonly maxObservedCaseMs: number
  /** Per-file scheduling evidence so a cache HIT can rehydrate the store. */
  readonly timingObservations: readonly ReceiptTimingRecord[]
  /** Human-readable provenance of {@link TestShardCacheIdentity.scopeKind}. */
  readonly scopeReason: string
  readonly junitXml?: string
  readonly receiptSha256: string
}

export type TestShardCacheLookup =
  | { readonly kind: "hit"; readonly receipt: SuccessfulTestShardReceipt }
  | { readonly kind: "miss"; readonly reason: string }

const sha256 = (value: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

const validSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

/** Content identity is independent of mtimes and file-system enumeration order. */
export const shardFilesSha256 = (repoRoot: string, files: readonly string[]): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of [...files].sort()) {
    hasher.update(relative(repoRoot, file))
    hasher.update("\0")
    hasher.update(sha256(readFileSync(file)))
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

/**
 * Content identity of everything the tests can read.
 *
 * MEASURED HOLE THIS CLOSES. The previous version hashed `src` and `tools`
 * `.ts` files only. `tests/setup.ts` — which bunfig preloads into EVERY test —
 * `tests/_helpers/*`, `bunfig.toml`, `package.json` and every JSON fixture a
 * ratchet reads were all invisible. Reproduced: append a line to
 * `tests/setup.ts`, commit, re-run — every chunk reported CACHE HIT and the
 * suite printed PASS having executed zero tests.
 *
 * Git already content-addresses the tree, so this is one `ls-tree` (0.2s for
 * 14k files) rather than 14k reads. The runner refuses a dirty checkout, so
 * HEAD and the working tree are the same thing here.
 */
export const trackedTreeSha256 = (repoRoot: string): string => {
  const result = runBoundedCapture({
    command: ["git", "ls-tree", "-r", "HEAD", "--format=%(path) %(objectname)"],
    cwd: repoRoot,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `[test:shards] cannot read the tree for cache identity` +
        `${result.timedOut ? ` (exceeded ${CAPTURE_TIMEOUT_MS}ms)` : ""}: ${result.stderr}`,
    )
  }
  const hasher = new Bun.CryptoHasher("sha256")
  const lines = result.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .sort()
  if (lines.length === 0) throw new Error("[test:shards] empty tree listing for cache identity")
  for (const line of lines) {
    hasher.update(line)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

const dedupePath = (value: string): string => {
  const seen = new Set<string>()
  return value
    .split(":")
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
    .join(":")
}

/**
 * Hash only the environment a test verdict can actually depend on: the CI/test
 * switches, locale/zone, PATH (first-occurrence order, duplicates collapsed —
 * `bun run` re-prepends its .bin chain per nesting level), and every BUN_ or
 * QUANTA_ knob. Hashing ALL inherited env made an unrelated terminal variable
 * (ITERM_SESSION_ID, a new SSH agent socket) a guaranteed cache miss.
 * Worker-synthesized values are replaced by stable semantic placeholders.
 *
 * `QUANTA_TEST_TIMEOUT_SCALE` is deliberately NOT derived from the live
 * timeout any more: it carries the stable policy base, for the same reason
 * {@link TestShardCacheIdentity.timeoutPolicySha256} does. A busy host must
 * not be a different cache universe.
 */
export const testEnvironmentSha256 = (
  env: Readonly<Record<string, string | undefined>>,
  timeoutPolicyBaseMs: number,
  /** REQUIRED, not optional: the untracked dotenv files under this root become
   *  environment inside the worker, and an argument that can be omitted is one
   *  that will be. */
  repoRoot: string,
): string => {
  const effective: Record<string, string | undefined> = { ...env }
  Object.assign(effective, {
    QUANTA_HOME: "<worker-quanta-home>",
    QUANTA_PREFS_HOME: "<worker-prefs-home>",
    QUANTA_BENCH_RESULTS_DIR: "<worker-bench-results>",
    QUANTA_SCAN_REACH_RECORD: "<worker-scan-reach-sink>",
    QUANTA_TEST_SOURCE_JS_CLEANED_ROOT: "<repo-source-root>",
    QUANTA_TEST_TIMEOUT_SCALE: String(timeoutPolicyBaseMs / 60_000),
    // The capability receipt's PATH is per-campaign scratch, like the four
    // worker paths above — hashing it would make every campaign a cache miss.
    // Its BINDING is deliberately NOT placeheld: it digests the host's actual
    // capabilities, and a green earned with lancedb present must not be
    // replayed on a box without it. That is the same argument the toolchain
    // fingerprint already makes, applied to the artifact that decides which
    // gated describes run at all.
    QUANTA_CAPABILITY_RECEIPT:
      env.QUANTA_CAPABILITY_RECEIPT === undefined ? undefined : "<campaign-capability-receipt>",
    // The BINDING is placeheld too, and that is a correction. It is
    // `sha256(head + policySha256 + toolchainSha256)`, so hashing it put the git
    // HEAD back into the certified identity — which excludes tree and head on
    // purpose — and re-admitted the whole 27-entry toolchain fingerprint that
    // `toolScopeSha256` had just narrowed. What belongs here is
    // `QUANTA_CAPABILITY_VERDICTS`: which gated describes will run, stable across
    // commits and across an unrelated tool's mtime.
    QUANTA_CAPABILITY_BINDING:
      env.QUANTA_CAPABILITY_BINDING === undefined ? undefined : "<campaign-capability-binding>",
  })
  const canonical = Object.entries(effective)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([key]) => isVerdictRelevantEnvKey(key))
    .filter(([key]) => !key.startsWith("QUANTA_VERIFICATION_LEASE_"))
    .map(([key, value]): [string, string] => [key, key === "PATH" ? dedupePath(value) : value])
    .sort(([left], [right]) => left.localeCompare(right))
  return sha256(JSON.stringify([canonical, verdictDotenvSha256(repoRoot)]))
}

/** The interpreter itself. Every chunk runs on it, so every chunk is bound to it. */
export const testRuntimeSha256 = (): string =>
  sha256(
    JSON.stringify({
      bun: Bun.version,
      bunRevision: Bun.revision,
      nodeCompatibility: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  )

/**
 * MEASURED DEFECT (2026-09-12): every chunk's identity carried the fingerprint
 * of all 27 entries of `EXTERNAL_TOOLS` — docker, cargo, gopls, rust-analyzer,
 * clangd, chrome… — so a `cargo install` or a Docker Desktop update changed
 * the identity of every `pure` chunk that cannot spawn a subprocess at all.
 *
 * `claimed === undefined` keeps that whole-tool fail-safe. A certified chunk
 * passes the tools its capability groups declare; a name with no fingerprint
 * entry hashes as `<unknown-tool>` rather than vanishing, so a typo in a claim
 * cannot silently drop a capability from the identity.
 */
export const toolScopeSha256 = (
  // The uncertified fail-safe hashes the WHOLE host capability set, daemon
  // state included: an uncertified chunk may do anything, including talk to a
  // daemon. A chunk that DECLARED its tools still narrows to those, so this
  // does not re-inflate the identity the `claimed` path exists to shrink.
  fingerprint: Record<string, string> = hostCapabilityFingerprint(),
  claimed?: readonly string[],
): string => {
  if (claimed === undefined) {
    return sha256(
      JSON.stringify(
        Object.entries(fingerprint).sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
  }
  return sha256(
    JSON.stringify(
      [...new Set(claimed)]
        .sort((left, right) => left.localeCompare(right))
        .map((tool) => [tool, fingerprint[tool] ?? "<unknown-tool>"]),
    ),
  )
}

/** Whole-tree projection kept for callers that want one value for the host. */
export const testToolchainSha256 = (
  externalTools: Record<string, string> = externalToolchainFingerprint(),
): string => sha256(JSON.stringify({ runtime: testRuntimeSha256(), externalTools }))

const receiptPayload = (receipt: Omit<SuccessfulTestShardReceipt, "receiptSha256">): string =>
  JSON.stringify(receipt)

const commonIdentityFields = (
  identity: TestShardCacheIdentity,
): Record<string, string | number | boolean> => ({
  shardFileCount: identity.shardFileCount,
  shardFilesSha256: identity.shardFilesSha256,
  runtimeSha256: identity.runtimeSha256,
  toolScopeSha256: identity.toolScopeSha256,
  testEnvSha256: identity.testEnvSha256,
  junit: identity.junit,
  intraParallel: identity.intraParallel,
  executionPolicySha256: identity.executionPolicySha256,
  timeoutPolicySha256: identity.timeoutPolicySha256,
  inputScopeSha256: identity.inputScopeSha256,
  producerReceiptsSha256: identity.producerReceiptsSha256,
})

/**
 * Path key for exactly the fields {@link sameIdentity} compares.
 *
 * `shardIndex` is deliberately NOT part of the identity: chunk composition is
 * bound by `shardFilesSha256` (path + content of every file), while the
 * ordinal is a presentation label that can shift when a NEIGHBOR chunk
 * changes. For a certified chunk the tree digest, the tier name and the whole
 * manifest digest are excluded for the same reason: they are not inputs to
 * THIS chunk, they are properties of the campaign that happened to schedule it.
 */
export const testShardCacheIdentitySha256 = (identity: TestShardCacheIdentity): string =>
  sha256(
    JSON.stringify(
      identity.scopeKind === "certified"
        ? { scopeKind: "certified", ...commonIdentityFields(identity) }
        : {
            scopeKind: "whole-tree",
            treeSha256: identity.treeSha256,
            suite: identity.suite,
            manifestSha256: identity.manifestSha256,
            ...commonIdentityFields(identity),
          },
    ),
  )

/**
 * Directory a chunk's receipt lives in.
 *
 * Certified chunks share ONE namespace: their identity no longer mentions a
 * tier, so `full`, `pr` and `nightly` running the same files at the same
 * policy are the same cache entry. Uncertified chunks keep the tier namespace
 * their identity still names.
 */
export const chunkCacheNamespace = (identity: TestShardCacheIdentity): string =>
  identity.scopeKind === "certified" ? "certified" : identity.suite

export const chunkCacheFileName = (identity: TestShardCacheIdentity): string =>
  `chunk-${testShardCacheIdentitySha256(identity)}.json`

const sameIdentity = (
  receipt: SuccessfulTestShardReceipt,
  expected: TestShardCacheIdentity,
): boolean =>
  receipt.scopeKind === expected.scopeKind &&
  testShardCacheIdentitySha256(receipt) === testShardCacheIdentitySha256(expected)

const isScanReachRecord = (value: unknown): value is ScanReachRecord => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    Number.isSafeInteger(row.walked) &&
    (row.walked as number) >= 0 &&
    (row.matched === undefined ||
      (Number.isSafeInteger(row.matched) && (row.matched as number) >= 0))
  )
}

const identityFieldsValid = (row: Record<string, unknown>): boolean =>
  (row.scopeKind === "whole-tree" || row.scopeKind === "certified") &&
  validSha256(row.treeSha256) &&
  typeof row.suite === "string" &&
  validSha256(row.manifestSha256) &&
  Number.isSafeInteger(row.shardIndex) &&
  (row.shardIndex as number) >= 1 &&
  Number.isSafeInteger(row.shardFileCount) &&
  (row.shardFileCount as number) >= 1 &&
  validSha256(row.shardFilesSha256) &&
  validSha256(row.runtimeSha256) &&
  validSha256(row.toolScopeSha256) &&
  validSha256(row.testEnvSha256) &&
  typeof row.junit === "boolean" &&
  Number.isSafeInteger(row.intraParallel) &&
  (row.intraParallel as number) >= 1 &&
  validSha256(row.executionPolicySha256) &&
  validSha256(row.timeoutPolicySha256) &&
  validSha256(row.inputScopeSha256) &&
  validSha256(row.producerReceiptsSha256)

const bodyFieldsValid = (row: Record<string, unknown>): boolean =>
  Number.isSafeInteger(row.createdAtMs) &&
  Number.isSafeInteger(row.expiresAtMs) &&
  Array.isArray(row.executedFileIds) &&
  (row.executedFileIds as unknown[]).length >= 1 &&
  (row.executedFileIds as unknown[]).every((id) => typeof id === "string" && id !== "") &&
  typeof row.executedDigestSha256 === "string" &&
  /^[a-f0-9]{64}$/.test(row.executedDigestSha256 as string) &&
  Array.isArray(row.scanReachRecords) &&
  row.scanReachRecords.every(isScanReachRecord) &&
  Number.isSafeInteger(row.testTimeoutMs) &&
  (row.testTimeoutMs as number) > 0 &&
  typeof row.maxObservedCaseMs === "number" &&
  Number.isFinite(row.maxObservedCaseMs) &&
  Array.isArray(row.timingObservations) &&
  row.timingObservations.every(isReceiptTimingRecord) &&
  typeof row.scopeReason === "string" &&
  (row.junitXml === undefined || typeof row.junitXml === "string") &&
  validSha256(row.receiptSha256)

const parseSuccessfulShardReceipt = (value: unknown): SuccessfulTestShardReceipt | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row.schema !== TEST_SHARD_RECEIPT_SCHEMA) return undefined
  if (!identityFieldsValid(row) || !bodyFieldsValid(row)) return undefined
  return row as unknown as SuccessfulTestShardReceipt
}

const junitShapeMiss = (receipt: SuccessfulTestShardReceipt): string | undefined => {
  if (receipt.junit !== (receipt.junitXml !== undefined)) return "junit-mismatch"
  if (receipt.junitXml === undefined) return undefined
  return receipt.junitXml.includes("<testsuites") &&
    receipt.junitXml.includes("</testsuites>") &&
    receipt.junitXml.includes("<testcase")
    ? undefined
    : "junit-invalid"
}

/**
 * A green receipt whose timing evidence was lost is INCOHERENT, and a miss is
 * the bounded cure.
 *
 * MEASURED DEFECT (2026-09-12): the shard wrote its receipt and then harvested
 * timings; a failed harvest left a green chunk with no per-file observations.
 * Every later campaign hit that receipt, never re-ran the chunk, and never
 * produced the timings — so `unit-speed-budget`, which exits 1 when an
 * executed file has no runner timing, could not be satisfied by any number of
 * retries. Missing timings now cost exactly ONE re-execution, and
 * {@link writeSuccessfulTestShardReceiptAtomic} refuses to mint an incoherent
 * receipt, so the re-execution cannot reproduce the same state.
 */
const timingCoherenceMiss = (receipt: SuccessfulTestShardReceipt): string | undefined => {
  if (!receipt.junit) return undefined
  if (receipt.timingObservations.length !== receipt.shardFileCount) {
    return `timing-incoherent:${receipt.timingObservations.length}/${receipt.shardFileCount}`
  }
  return undefined
}

export const loadSuccessfulTestShardReceipt = (input: {
  readonly path: string
  readonly expected: TestShardCacheIdentity
  /** REQUIRED: the timeout THIS campaign will use, for compatibility proof. */
  readonly expectedTestTimeoutMs: number
  /**
   * The ids the CALLER is asking about, repo-relative.
   *
   * An adversarial audit proved the reuse path was still count-based. v4 put the
   * executed ids in the receipt and checked them against `shardFileCount` and
   * against a digest of THE SAME ARRAY IN THE SAME FILE — both self-consistent
   * by construction. Nothing compared them to the chunk being asked about, and
   * `shardFilesSha256` hashes file CONTENT, not the id set. Measured: a receipt
   * whose ids were swapped, whose digest was recomputed and which was re-signed
   * returned `hit` for a completely different chunk.
   *
   * Required, not optional: a caller that omits it is exactly the caller that
   * reintroduces the hole.
   */
  readonly expectedFileIds: readonly string[]
  readonly nowMs?: number
}): TestShardCacheLookup => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(input.path, "utf8"))
  } catch {
    return { kind: "miss", reason: "absent-or-corrupt" }
  }
  const receipt = parseSuccessfulShardReceipt(parsed)
  if (receipt === undefined) return { kind: "miss", reason: "invalid-schema" }
  const { receiptSha256, ...payload } = receipt
  if (sha256(receiptPayload(payload)) !== receiptSha256) {
    return { kind: "miss", reason: "integrity" }
  }
  const nowMs = input.nowMs ?? Date.now()
  if (
    receipt.expiresAtMs - receipt.createdAtMs !== TEST_SHARD_CACHE_TTL_MS ||
    receipt.createdAtMs > nowMs ||
    receipt.expiresAtMs <= nowMs
  ) {
    return { kind: "miss", reason: "expired" }
  }
  if (!sameIdentity(receipt, input.expected)) return { kind: "miss", reason: "input-mismatch" }
  const timeout = timeoutCompatibility({
    receiptTestTimeoutMs: receipt.testTimeoutMs,
    receiptMaxObservedCaseMs: receipt.maxObservedCaseMs,
    expectedTestTimeoutMs: input.expectedTestTimeoutMs,
  })
  if (timeout.kind === "incompatible") return { kind: "miss", reason: `timeout-${timeout.reason}` }
  if (receipt.executedFileIds.length !== receipt.shardFileCount) {
    return { kind: "miss", reason: "discovery-mismatch" }
  }
  // The digest must be OF the list it travels with. A receipt carrying some
  // other set's digest is how an exact-set claim gets forged after the fact.
  if (receipt.executedDigestSha256 !== executedFileSetDigest(receipt.executedFileIds)) {
    return { kind: "miss", reason: "executed-digest-mismatch" }
  }
  // ...and the list must be the CALLER's set. Everything above compares the
  // receipt to itself; this is the only check that connects it to the chunk
  // whose green is about to be reused.
  if (receipt.executedDigestSha256 !== executedFileSetDigest(input.expectedFileIds)) {
    return { kind: "miss", reason: "executed-set-not-this-chunk" }
  }
  const junitProblem = junitShapeMiss(receipt)
  if (junitProblem !== undefined) return { kind: "miss", reason: junitProblem }
  const timingProblem = timingCoherenceMiss(receipt)
  if (timingProblem !== undefined) return { kind: "miss", reason: timingProblem }
  return { kind: "hit", receipt }
}

export interface ShardReceiptWriteInput {
  readonly path: string
  readonly identity: TestShardCacheIdentity
  /** Normalized ids from the worker's own JUnit — not the runner's tally. */
  readonly executedFileIds: readonly string[]
  readonly scanReachRecords: readonly ScanReachRecord[]
  readonly testTimeoutMs: number
  readonly timingObservations: readonly ReceiptTimingRecord[]
  readonly scopeReason: string
  readonly junitXml?: string
  readonly nowMs?: number
}

const refuseIncompleteReceipt = (input: ShardReceiptWriteInput): void => {
  if (
    input.executedFileIds.length < 1 ||
    new Set(input.executedFileIds).size !== input.executedFileIds.length ||
    input.executedFileIds.length !== input.identity.shardFileCount ||
    input.scanReachRecords.some((record) => !isScanReachRecord(record)) ||
    input.identity.junit !== (input.junitXml !== undefined) ||
    !Number.isSafeInteger(input.testTimeoutMs) ||
    input.testTimeoutMs <= 0
  ) {
    throw new Error("[test:shards] refusing to cache an incomplete shard receipt")
  }
  if (input.timingObservations.some((record) => !isReceiptTimingRecord(record))) {
    throw new Error("[test:shards] refusing to cache an invalid timing observation")
  }
  // The bound on the incoherence miss: a receipt that cannot rehydrate the
  // timings of the files it claims is never written in the first place.
  if (input.identity.junit && input.timingObservations.length !== input.identity.shardFileCount) {
    throw new Error(
      `[test:shards] refusing an incoherent receipt: ${input.timingObservations.length} timing ` +
        `observation(s) for ${input.identity.shardFileCount} file(s)`,
    )
  }
}

export const writeSuccessfulTestShardReceiptAtomic = (
  input: ShardReceiptWriteInput,
): SuccessfulTestShardReceipt => {
  refuseIncompleteReceipt(input)
  const createdAtMs = input.nowMs ?? Date.now()
  const payload: Omit<SuccessfulTestShardReceipt, "receiptSha256"> = {
    schema: TEST_SHARD_RECEIPT_SCHEMA,
    ...input.identity,
    createdAtMs,
    expiresAtMs: createdAtMs + TEST_SHARD_CACHE_TTL_MS,
    executedFileIds: [...input.executedFileIds].sort(),
    executedDigestSha256: executedFileSetDigest(input.executedFileIds),
    scanReachRecords: [...input.scanReachRecords],
    testTimeoutMs: input.testTimeoutMs,
    maxObservedCaseMs: input.junitXml === undefined ? -1 : junitMaxCaseMs(input.junitXml),
    timingObservations: [...input.timingObservations],
    scopeReason: input.scopeReason,
    ...(input.junitXml === undefined ? {} : { junitXml: input.junitXml }),
  }
  const receipt: SuccessfulTestShardReceipt = {
    ...payload,
    receiptSha256: sha256(receiptPayload(payload)),
  }
  mkdirSync(dirname(input.path), { recursive: true })
  const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx" })
    renameSync(temporary, input.path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return receipt
}

/* ─────────────────────────────────────────────────────────────────────────
 *  TTL GARBAGE COLLECTION
 * ───────────────────────────────────────────────────────────────────────── */

export interface ShardReceiptPruneReport {
  readonly namespaces: readonly string[]
  readonly examined: number
  readonly removed: number
  readonly bytesReclaimed: number
  readonly kept: number
}

const receiptIsExpired = (path: string, nowMs: number): boolean => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { expiresAtMs?: unknown }
    return !(Number.isSafeInteger(parsed.expiresAtMs) && (parsed.expiresAtMs as number) > nowMs)
  } catch {
    return true
  }
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * MEASURED DEFECT (2026-09-12): the runner pruned `join(root, opts.suite)` —
 * the bare tier name — while tier caches are written under `full:pr`,
 * `full:nightly`, and (now) `certified`. Nothing ever collected those. It also
 * ran only after every chunk went green, so a branch that keeps failing late
 * accumulates the JUnit and scan payloads of the chunks that went green early.
 * Measured on this checkout at the previous cache root: 307 receipts,
 * 127 MiB, every one of them already expired, none collected.
 *
 * TTL is the ONLY criterion. The cache is shared across worktrees, so "not
 * part of MY plan" is not evidence of staleness — a sibling checkout at
 * another HEAD may still be resuming from its receipts.
 */
export const pruneExpiredShardReceipts = (
  root: string,
  nowMs = Date.now(),
): ShardReceiptPruneReport => {
  let namespaceEntries: string[]
  try {
    namespaceEntries = readdirSync(root)
  } catch {
    return { namespaces: [], examined: 0, removed: 0, bytesReclaimed: 0, kept: 0 }
  }
  const namespaces: string[] = []
  let examined = 0
  let removed = 0
  let bytesReclaimed = 0
  let kept = 0
  for (const namespace of namespaceEntries.sort()) {
    const dir = join(root, namespace)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    namespaces.push(namespace)
    for (const file of files) {
      const path = join(dir, file)
      examined += 1
      if (!receiptIsExpired(path, nowMs)) {
        kept += 1
        continue
      }
      bytesReclaimed += sizeOf(path)
      rmSync(path, { force: true })
      removed += 1
    }
  }
  return { namespaces, examined, removed, bytesReclaimed, kept }
}

/* ─────────────────────────────────────────────────────────────────────────
 *  RECEIPT-SIDE TIMING RECOVERY
 * ───────────────────────────────────────────────────────────────────────── */

export interface ShardReceiptTimingScan {
  readonly timings: ReadonlyMap<string, number>
  readonly receiptsRead: number
  readonly receiptsAvailable: number
  readonly recovered: number
}

/**
 * Bounded recovery of per-file scheduling weights from green receipts.
 *
 * BOUNDED means two things and neither is a tuned number: the scan stops the
 * moment every wanted file has a weight, and it never reads a receipt twice.
 * A receipt older than the timing TTL is skipped — a replayed measurement must
 * age out exactly like the one it replays.
 */
const receiptFilePaths = (root: string): readonly string[] => {
  const paths: string[] = []
  let namespaces: string[]
  try {
    namespaces = readdirSync(root).sort()
  } catch {
    return paths
  }
  for (const namespace of namespaces) {
    try {
      for (const file of readdirSync(join(root, namespace)).sort()) {
        paths.push(join(root, namespace, file))
      }
    } catch {
      /* a namespace removed mid-scan is simply not scanned */
    }
  }
  return paths
}

/** Timing records a receipt file can contribute, or an empty list. */
const receiptTimingRecords = (
  path: string,
  nowMs: number,
  maxAgeMs: number,
): readonly ReceiptTimingRecord[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null) return []
  const row = parsed as Record<string, unknown>
  if (row.schema !== TEST_SHARD_RECEIPT_SCHEMA || !Array.isArray(row.timingObservations)) return []
  if (!Number.isSafeInteger(row.createdAtMs)) return []
  const ageMs = nowMs - (row.createdAtMs as number)
  if (ageMs < 0 || ageMs > maxAgeMs) return []
  return row.timingObservations.filter(isReceiptTimingRecord)
}

/**
 * Bounded recovery of per-file scheduling weights from green receipts.
 *
 * BOUNDED means two things and neither is a tuned number: the scan stops the
 * moment every wanted file has a weight, and it never reads a receipt twice.
 * A receipt older than the timing TTL is skipped — a replayed measurement must
 * age out exactly like the one it replays.
 */
export const scanShardReceiptTimings = (
  root: string,
  wanted: ReadonlySet<string>,
  nowMs = Date.now(),
  maxAgeMs = 14 * 24 * 60 * 60_000,
): ShardReceiptTimingScan => {
  const timings = new Map<string, number>()
  const outstanding = new Set(wanted)
  const paths = receiptFilePaths(root)
  let receiptsRead = 0
  for (const path of paths) {
    if (outstanding.size === 0) break
    receiptsRead += 1
    for (const record of receiptTimingRecords(path, nowMs, maxAgeMs)) {
      if (!outstanding.has(record.file)) continue
      timings.set(record.file, record.schedulingWeightMs)
      outstanding.delete(record.file)
    }
  }
  return { timings, receiptsRead, receiptsAvailable: paths.length, recovered: timings.size }
}

/* ─────────────────────────────────────────────────────────────────────────
 *  SCAN REACH
 * ───────────────────────────────────────────────────────────────────────── */

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
  readonly manifestSha256: string
  readonly sinks: readonly string[]
  readonly authority: ScanReachAuthority
}): void => {
  // Refused at the SOURCE, not only at the consumer. A narrowed tier walks a
  // subset of the enrolled ids, so a receipt it mints is not weaker evidence —
  // it is evidence about a different population, and writing one at all invites
  // a future consumer to read it as the real thing.
  if (!AUTHORITATIVE_SCAN_TIERS.includes(input.authority.tier)) {
    throw new Error(
      `[test:shards] refusing to mint a scan-reach receipt from tier ` +
        `"${input.authority.tier}": only ${AUTHORITATIVE_SCAN_TIERS.join("/")} walk the whole ` +
        "enrolled universe",
    )
  }
  if (input.authority.suite !== "full") {
    throw new Error(
      `[test:shards] refusing to mint a scan-reach receipt from suite ` +
        `"${input.authority.suite}": only full covers every enrolled scan id`,
    )
  }
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
        schema: "quanta.scan-reach-receipt.v2",
        head: input.head,
        manifestSha256: input.manifestSha256,
        childExit: 0,
        ...input.authority,
        records,
      },
      null,
      2,
    )}\n`,
  )
  renameSync(temporary, input.path)
}
