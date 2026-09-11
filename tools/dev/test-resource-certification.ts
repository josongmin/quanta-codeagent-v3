/**
 * THE CERTIFICATION REGISTRY — which test files may overlap, and on what.
 *
 * A certification is a statement with an owner: "at THIS source digest, this
 * file's reachable claims are exactly these". The scheduler may act on it.
 * Everything else — no row, a row for different bytes, a row that itself says
 * `unknown`, a registry that will not parse — falls back to exclusive, which
 * is the behaviour the corpus already has.
 *
 * # Fail-closed is not a slogan here
 *
 * There are five distinct ways to have no usable certification and each one
 * has its own reason string, because "this file has no row" and "this file's
 * row is for source that has since changed" are different operational facts
 * and the audit has to be able to count them separately.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  holdsResource,
  isResourceClaimKey,
  type ResourceClaim,
  type ResourceClaimMode,
  resourceClaimKind,
  scheduleClaimsOverlap,
} from "./test-resource-claims"

export type ResourceMode = ResourceClaimMode
export type ResourceIsolation = "process" | "checkout" | "host"
export type CertificationStatus = "certified" | "intentionally-exclusive"
export type { ResourceClaim }
export { holdsResource, scheduleClaimsOverlap }

export const CERTIFICATION_SCHEMA = "quanta.test-resource-certifications.v2"

export interface TestResourceCertification {
  readonly testId: string
  readonly sourceSha256: string
  readonly owner: string
  readonly reason: string
  readonly status: CertificationStatus
  readonly isolation: ResourceIsolation
  readonly claims: readonly ResourceClaim[]
  /** Which analyzer version produced the claims, for `certified` rows. */
  readonly analyzer?: string
  /** Repository modules the analyzer reached. Context for a reviewer. */
  readonly moduleCount?: number
}

export interface TestResourceCertificationFile {
  readonly schema: typeof CERTIFICATION_SCHEMA
  readonly certifications: readonly TestResourceCertification[]
}

export type CertificationFallbackReason =
  | "missing"
  | "source-drift"
  | "intentionally-exclusive"
  | "unknown-claim"

export type CertificationResolution =
  | {
      readonly kind: "certified"
      readonly certification: TestResourceCertification
      readonly claims: readonly ResourceClaim[]
    }
  | {
      readonly kind: "exclusive-fallback"
      readonly reason: CertificationFallbackReason
      readonly claims: readonly [{ readonly key: "unknown"; readonly mode: "exclusive" }]
    }

const FALLBACK_CLAIMS = [{ key: "unknown", mode: "exclusive" }] as const
const SHA256 = /^[a-f0-9]{64}$/u

const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const parseClaim = (value: unknown, testId: string): ResourceClaim => {
  const row = record(value, `invalid resource claim for ${testId}`)
  // The key must be IN THE VOCABULARY, not merely shaped like one. A typo'd
  // key would otherwise be a resource nothing else ever names, i.e. a claim
  // that silently conflicts with nobody — the exact failure a registry is
  // supposed to make impossible.
  if (typeof row.key !== "string" || !isResourceClaimKey(row.key)) {
    throw new Error(`invalid resource key for ${testId}: ${String(row.key)}`)
  }
  if (row.mode !== "shared" && row.mode !== "exclusive") {
    throw new Error(`invalid resource mode for ${testId}: ${String(row.mode)}`)
  }
  return { key: row.key, mode: row.mode }
}

const requiredString = (row: Record<string, unknown>, key: string, testId: string): string => {
  const value = row[key]
  if (typeof value !== "string" || value === "") {
    throw new Error(`resource certification requires ${key} for ${testId}`)
  }
  return value
}

const certificationStatus = (value: unknown, testId: string): CertificationStatus => {
  if (value !== "certified" && value !== "intentionally-exclusive") {
    throw new Error(`invalid certification status for ${testId}`)
  }
  return value
}

const isolationScope = (value: unknown, testId: string): ResourceIsolation => {
  if (value !== "process" && value !== "checkout" && value !== "host") {
    throw new Error(`invalid isolation scope for ${testId}`)
  }
  return value
}

const certificationClaims = (
  value: unknown,
  testId: string,
  status: CertificationStatus,
): readonly ResourceClaim[] => {
  if (!Array.isArray(value)) throw new Error(`resource claims must be an array for ${testId}`)
  const claims = value.map((claim) => parseClaim(claim, testId))
  const keys = new Set<string>()
  for (const claim of claims) {
    if (keys.has(claim.key)) throw new Error(`duplicate resource key ${claim.key} for ${testId}`)
    keys.add(claim.key)
  }
  if (status === "intentionally-exclusive" && !claims.some(({ mode }) => mode === "exclusive")) {
    throw new Error(`intentionally-exclusive certification requires an exclusive claim: ${testId}`)
  }
  return claims
}

const parseCertification = (value: unknown): TestResourceCertification => {
  const row = record(value, "invalid test resource certification")
  const testId = requiredString(row, "testId", "unknown")
  const sourceDigest = requiredString(row, "sourceSha256", testId)
  if (!SHA256.test(sourceDigest)) throw new Error(`invalid sourceSha256 for ${testId}`)
  const status = certificationStatus(row.status, testId)
  if (status === "certified" && typeof row.analyzer !== "string") {
    throw new Error(`certified row must name the analyzer that produced it: ${testId}`)
  }
  return {
    testId,
    sourceSha256: sourceDigest,
    owner: requiredString(row, "owner", testId),
    reason: requiredString(row, "reason", testId),
    status,
    isolation: isolationScope(row.isolation, testId),
    claims: certificationClaims(row.claims, testId, status),
    ...(typeof row.analyzer === "string" ? { analyzer: row.analyzer } : {}),
    ...(typeof row.moduleCount === "number" ? { moduleCount: row.moduleCount } : {}),
  }
}

export const sourceSha256 = (source: string): string =>
  createHash("sha256").update(source).digest("hex")

export const parseTestResourceCertifications = (text: string): TestResourceCertificationFile => {
  const parsed = record(JSON.parse(text), "invalid certification file")
  if (parsed.schema !== CERTIFICATION_SCHEMA) {
    throw new Error(`unknown resource certification schema: ${String(parsed.schema)}`)
  }
  if (!Array.isArray(parsed.certifications)) throw new Error("certifications must be an array")
  const certifications = parsed.certifications.map(parseCertification)
  const ids = new Set<string>()
  for (const certification of certifications) {
    if (ids.has(certification.testId)) {
      throw new Error(`duplicate resource certification: ${certification.testId}`)
    }
    ids.add(certification.testId)
  }
  return { schema: CERTIFICATION_SCHEMA, certifications }
}

export const loadTestResourceCertifications = (path: string): TestResourceCertificationFile =>
  parseTestResourceCertifications(readFileSync(path, "utf8"))

export interface SafeCertificationLoad {
  readonly certifications: readonly TestResourceCertification[]
  /** Present when the registry could not be read or parsed. */
  readonly error?: string
}

/**
 * Load, or report zero certifications and why.
 *
 * A parse error MUST degrade to "nothing is certified" rather than an
 * exception: the registry is read from the policy layer, the planner and the
 * audit, and a stray comma in a 562-row JSON file would otherwise take out
 * every gate in the repository instead of slowing one scheduler down.
 */
export const loadTestResourceCertificationsSafe = (path: string): SafeCertificationLoad => {
  try {
    return { certifications: loadTestResourceCertifications(path).certifications }
  } catch (error) {
    return { certifications: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export const resolveResourceCertification = (input: {
  readonly testId: string
  readonly source: string
  readonly certifications: readonly TestResourceCertification[]
}): CertificationResolution => {
  const certification = input.certifications.find(({ testId }) => testId === input.testId)
  if (certification === undefined) {
    return { kind: "exclusive-fallback", reason: "missing", claims: FALLBACK_CLAIMS }
  }
  if (certification.sourceSha256 !== sourceSha256(input.source)) {
    return { kind: "exclusive-fallback", reason: "source-drift", claims: FALLBACK_CLAIMS }
  }
  if (certification.status === "intentionally-exclusive") {
    return {
      kind: "exclusive-fallback",
      reason: "intentionally-exclusive",
      claims: FALLBACK_CLAIMS,
    }
  }
  // A `certified` row whose claims still say `unknown` is a contradiction: it
  // asserts a complete enumeration and then names the marker for an incomplete
  // one. Treat the marker as authoritative and the status as a mistake.
  if (certification.claims.some(({ key }) => resourceClaimKind(key) === "unknown")) {
    return { kind: "exclusive-fallback", reason: "unknown-claim", claims: FALLBACK_CLAIMS }
  }
  return { kind: "certified", certification, claims: certification.claims }
}

export const certificationDigest = (certifications: readonly TestResourceCertification[]): string =>
  createHash("sha256")
    .update(JSON.stringify([...certifications].sort((a, b) => a.testId.localeCompare(b.testId))))
    .digest("hex")

/**
 * True only when two CERTIFIED claim sets may execute at the same time.
 *
 * Strictly stronger than `scheduleClaimsOverlap`: this one refuses any
 * `unknown` outright, including against a claim set that holds nothing. It is
 * the predicate for "both sides are certified and I am checking them against
 * each other", not the scheduler's, which has to place uncertified chunks too.
 */
export const resourceClaimSetsOverlap = (
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean => {
  if ([...left, ...right].some(({ key }) => resourceClaimKind(key) === "unknown")) return false
  const rightByKey = new Map(right.map((claim) => [claim.key, claim.mode]))
  return left.every((claim) => {
    const peerMode = rightByKey.get(claim.key)
    return peerMode === undefined || (claim.mode === "shared" && peerMode === "shared")
  })
}

/**
 * Does `certified` still cover everything `derived` found?
 *
 * The registry pins the TEST file's digest, not the digest of the hundreds of
 * production modules behind it — pinning those would invalidate every row on
 * every `src/` commit, so certification would be permanently stale and buy
 * nothing. What matters is direction: a closure that grew a hazard must not
 * keep running on a row that predates it, while a closure that lost one is
 * merely over-declared and safe. So the gate checks CONTAINMENT, not equality.
 */
export const certificationCoversDerived = (
  certified: readonly ResourceClaim[],
  derived: readonly ResourceClaim[],
): boolean => {
  const byKey = new Map(certified.map((claim) => [claim.key, claim.mode]))
  return derived.every((claim) => {
    const mode = byKey.get(claim.key)
    if (mode === undefined) return false
    return mode === "exclusive" || claim.mode === "shared"
  })
}
