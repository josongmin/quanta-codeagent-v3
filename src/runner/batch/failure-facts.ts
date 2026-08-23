/**
 * RFC-07 packet G4 — ATOMIC inline per-attempt failure-facts persistence.
 *
 * The runner-side PERSISTENCE adapter for the versioned facts G3 derives at the
 * bundle-live seam. It owns a self-contained, canonical per-attempt RESULT record
 * (`AttemptFactsRecord`) whose facts are INLINE (a field of the record, never a
 * separate facts file joined back to a result — NOT the rejected sidecar), plus
 * an ATOMIC writer and a STRICT reader:
 *
 *   - the writer commits a record via temp-file + rename, so a reader NEVER
 *     observes a half-written record and a write failure leaves the target
 *     UNTOUCHED (neither result nor facts published — no partial evidence);
 *   - only a fully-EXTRACTED, identity-matched fact set is persisted; an
 *     `unavailable` extraction (incomplete / mismatched identity) is REJECTED —
 *     a mismatched record can never land;
 *   - the reader is fail-closed: a missing record (legacy absence), corrupt JSON,
 *     an unknown record/facts schema version, or a run/attempt/source identity
 *     mismatch ALL collapse to an explicit `unavailable` — never a best-effort
 *     partial and never a fabricated fact.
 *
 * SCOPE (§G4): this module is the canonical per-attempt facts store. It does NOT
 * touch `runner/batch/report*` (the aggregate report envelope is G5, BLOCKED on
 * the dirty report owner) and adds NO field to the contested `InstanceResult`
 * attempt envelope. Folding these facts into the report at report time is G5.
 *
 * Architecture SSOT: `docs/plans/aug-22-흡수계획/rfc-07-observability-signals-parity.md`
 * (Executable packet G4).
 */

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
  FailureFactsExtraction,
  FailureFactsIdentity,
  FailureFactsMismatch,
  FailureFactsUnavailableReason,
} from "@/agent/observation/metrics"
import {
  decodeFailureTaxonomyFacts,
  type FailureTaxonomyFactsV1,
} from "@/observability/failure-taxonomy"
import { errMessage, isRecord, logger } from "@/shared"

/**
 * The persisted RECORD envelope version — DISTINCT from the taxonomy facts
 * schema (`FailureTaxonomyFactsV1.schemaVersion`). The reader rejects any other
 * value (`unknown_record_version`), so a future record shape can never be read
 * best-effort by an old consumer.
 */
export const ATTEMPT_FACTS_RECORD_SCHEMA_VERSION = 1 as const
export type AttemptFactsRecordSchemaVersion = typeof ATTEMPT_FACTS_RECORD_SCHEMA_VERSION

/**
 * The canonical, self-contained per-attempt record the facts are committed
 * INLINE with. ONE artifact carries the versioned envelope + the full fact set
 * (which itself carries `{runId,attemptId,sourceDigest,schemaVersion}`), so an
 * orphaned facts/result pair is unrepresentable (no join → no sidecar race).
 */
export interface AttemptFactsRecord {
  readonly recordSchemaVersion: AttemptFactsRecordSchemaVersion
  readonly facts: FailureTaxonomyFactsV1
}

/**
 * The filesystem port the store writes through. Injected so a test can drive a
 * real temp dir OR inject a writer failure (proving atomicity) without a real
 * disk fault. The default is {@link nodeFactsStoreIO}.
 */
export interface FactsStoreIO {
  /** Create `dir` (and parents) if absent. */
  readonly ensureDir: (dir: string) => void
  /** Write `data` to `path` ATOMICALLY: on POSIX a `rename` onto `path` is
   *  atomic, so a concurrent reader sees either the prior content or the whole
   *  new record — never a partial. A failure MUST leave `path` unchanged and
   *  throw (so the caller treats the commit as not-published). */
  readonly writeAtomic: (path: string, data: string) => void
  /** Read `path`, or `undefined` when it does not exist (legacy absence). */
  readonly read: (path: string) => string | undefined
}

/** Production filesystem store: temp-file + rename for atomicity. */
export const nodeFactsStoreIO: FactsStoreIO = {
  ensureDir: (dir) => {
    mkdirSync(dir, { recursive: true })
  },
  writeAtomic: (path, data) => {
    // Unique temp sibling (crypto-random suffix — never Math.random, and no
    // collision under parallel attempts writing sibling records). Rename is the
    // atomic publish; a write/rename throw leaves `path` untouched (no partial).
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`
    try {
      writeFileSync(tmp, data)
      renameSync(tmp, path)
    } catch (e) {
      // Best-effort remove the orphaned temp, then rethrow so the caller knows
      // the commit did NOT publish (neither result nor facts landed).
      rmSync(tmp, { force: true })
      throw e
    }
  },
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
}

/** The canonical on-disk path for one attempt's facts record, under the run's
 *  observe dir and keyed by the SAME `<instanceId>.<attempt>` identity the
 *  trajectory recorder uses (so G5 can join facts ↔ report by attempt). */
export const attemptFactsRecordPath = (
  observeDir: string,
  runId: string,
  instanceId: string,
  attempt: number,
): string => join(observeDir, runId, `${instanceId}.${attempt}.facts.json`)

/** Disposition of a commit attempt. `rejected` carries WHY the extraction was
 *  not persistable (so the caller can surface an explicit unavailable). */
export type AttemptFactsCommit =
  | { readonly kind: "persisted" }
  | { readonly kind: "rejected"; readonly reason: FailureFactsUnavailableReason }

/**
 * Atomically COMMIT one attempt's failure-facts. ONLY a fully-`extracted`,
 * identity-matched fact set is written (the record + its inline facts commit
 * together). An `unavailable` extraction is REJECTED — nothing is written, so a
 * mismatched/partial record can never land and a later read sees `absent`. A
 * writer IO failure propagates (the temp+rename left no partial), so the caller
 * treats the attempt as publishing NEITHER result nor facts.
 */
export const commitAttemptFacts = (
  io: FactsStoreIO,
  path: string,
  extraction: FailureFactsExtraction,
): AttemptFactsCommit => {
  if (extraction.kind !== "extracted") {
    return { kind: "rejected", reason: extraction.reason }
  }
  const record: AttemptFactsRecord = {
    recordSchemaVersion: ATTEMPT_FACTS_RECORD_SCHEMA_VERSION,
    facts: extraction.facts,
  }
  io.ensureDir(dirname(path))
  io.writeAtomic(path, `${JSON.stringify(record)}\n`)
  return { kind: "persisted" }
}

/** Fail-closed unavailability reasons the strict reader can surface. */
export const ATTEMPT_FACTS_UNAVAILABLE_REASONS = [
  "absent",
  "corrupt",
  "unknown_record_version",
  "unknown_facts_version",
  "malformed_facts",
  "identity_mismatch",
] as const
export type AttemptFactsUnavailableReason = (typeof ATTEMPT_FACTS_UNAVAILABLE_REASONS)[number]

/** Strict read outcome: an identity-matched fact set, or an explicit reason it
 *  could not be produced (never a best-effort partial). */
export type AttemptFactsRead =
  | { readonly kind: "available"; readonly facts: FailureTaxonomyFactsV1 }
  | {
      readonly kind: "unavailable"
      readonly reason: AttemptFactsUnavailableReason
      readonly mismatch?: FailureFactsMismatch
    }

/** First disagreeing identity axis (run → attempt → source), or `undefined` when
 *  the persisted facts match the caller's EXACT binding on all three. */
const firstIdentityMismatch = (
  expected: FailureFactsIdentity,
  facts: FailureTaxonomyFactsV1,
): FailureFactsMismatch | undefined => {
  if (facts.runId !== expected.runId) {
    return { axis: "runId", expected: expected.runId, observed: facts.runId }
  }
  if (facts.attemptId !== expected.attemptId) {
    return { axis: "attemptId", expected: expected.attemptId, observed: facts.attemptId }
  }
  if (facts.sourceDigest !== expected.sourceDigest) {
    return { axis: "sourceDigest", expected: expected.sourceDigest, observed: facts.sourceDigest }
  }
  return undefined
}

/**
 * Strictly READ one attempt's persisted facts, bound to the caller's EXACT
 * identity. Fail-closed on every non-match: a missing record (legacy absence),
 * unparseable JSON, an unknown record/facts schema version, malformation, or a
 * run/attempt/source mismatch each yields an explicit `unavailable`. Reuses the
 * G2 domain's strict facts decoder (`decodeFailureTaxonomyFacts`) so the facts
 * shape/version is validated by ONE authority.
 */
export const readAttemptFacts = (
  io: FactsStoreIO,
  path: string,
  expected: FailureFactsIdentity,
): AttemptFactsRead => {
  const raw = io.read(path)
  if (raw === undefined) return { kind: "unavailable", reason: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // Unparseable payload — a corrupt record is NOT a partial we can trust. The
    // verdict stays `corrupt` (callers branch on it), but the parse fault is
    // ATTRIBUTED: silently classifying a record as corrupt hides whether the
    // writer truncated it or the reader is looking at the wrong file.
    logger.warn(`failure-facts.readAttemptFacts[${path}]: ${errMessage(e)}`)
    return { kind: "unavailable", reason: "corrupt" }
  }
  if (!isRecord(parsed)) return { kind: "unavailable", reason: "corrupt" }
  if (parsed.recordSchemaVersion !== ATTEMPT_FACTS_RECORD_SCHEMA_VERSION) {
    return { kind: "unavailable", reason: "unknown_record_version" }
  }
  const decoded = decodeFailureTaxonomyFacts(parsed.facts)
  if (!decoded.ok) {
    return {
      kind: "unavailable",
      reason:
        decoded.reason === "unknown_schema_version" ? "unknown_facts_version" : "malformed_facts",
    }
  }
  const mismatch = firstIdentityMismatch(expected, decoded.facts)
  if (mismatch !== undefined) {
    return { kind: "unavailable", reason: "identity_mismatch", mismatch }
  }
  return { kind: "available", facts: decoded.facts }
}
