import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export type ResourceMode = "shared" | "exclusive"
export type ResourceIsolation = "process" | "checkout" | "host"
export type CertificationStatus = "certified" | "intentionally-exclusive"

export interface ResourceClaim {
  readonly key: string
  readonly mode: ResourceMode
}

export interface TestResourceCertification {
  readonly testId: string
  readonly sourceSha256: string
  readonly owner: string
  readonly reason: string
  readonly status: CertificationStatus
  readonly isolation: ResourceIsolation
  readonly claims: readonly ResourceClaim[]
}

export interface TestResourceCertificationFile {
  readonly schema: "quanta.test-resource-certifications.v1"
  readonly certifications: readonly TestResourceCertification[]
}

export type CertificationResolution =
  | {
      readonly kind: "certified"
      readonly certification: TestResourceCertification
      readonly claims: readonly ResourceClaim[]
    }
  | {
      readonly kind: "exclusive-fallback"
      readonly reason: "missing" | "source-drift" | "intentionally-exclusive"
      readonly claims: readonly [{ readonly key: "unknown"; readonly mode: "exclusive" }]
    }

const FALLBACK_CLAIMS = [{ key: "unknown", mode: "exclusive" }] as const
const SHA256 = /^[a-f0-9]{64}$/u
const RESOURCE_KEY = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._/-]+)?$/u

const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const parseClaim = (value: unknown, testId: string): ResourceClaim => {
  const row = record(value, `invalid resource claim for ${testId}`)
  if (typeof row.key !== "string" || !RESOURCE_KEY.test(row.key) || row.key.includes("..")) {
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
  return {
    testId,
    sourceSha256: sourceDigest,
    owner: requiredString(row, "owner", testId),
    reason: requiredString(row, "reason", testId),
    status,
    isolation: isolationScope(row.isolation, testId),
    claims: certificationClaims(row.claims, testId, status),
  }
}

export const sourceSha256 = (source: string): string =>
  createHash("sha256").update(source).digest("hex")

export const loadTestResourceCertifications = (path: string): TestResourceCertificationFile => {
  const parsed = record(JSON.parse(readFileSync(path, "utf8")), "invalid certification file")
  if (parsed.schema !== "quanta.test-resource-certifications.v1") {
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
  return { schema: "quanta.test-resource-certifications.v1", certifications }
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
  return { kind: "certified", certification, claims: certification.claims }
}

export const certificationDigest = (certifications: readonly TestResourceCertification[]): string =>
  createHash("sha256")
    .update(JSON.stringify([...certifications].sort((a, b) => a.testId.localeCompare(b.testId))))
    .digest("hex")

/**
 * Review candidates only. Every detector requires a live call/property access;
 * imports, comments, and bare identifiers do not certify a test.
 */
export const inferResourceClaimCandidates = (source: string): readonly ResourceClaim[] => {
  const claims: ResourceClaim[] = []
  const add = (key: string, mode: ResourceMode): void => {
    if (!claims.some((claim) => claim.key === key)) claims.push({ key, mode })
  }
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    add(`process-env:${match[1] ?? "unknown"}`, "exclusive")
  }
  if (/\b(?:Bun\.spawn|spawn|spawnSync|execFile|execFileSync)\s*\(/u.test(source)) {
    add("child-process", "shared")
  }
  if (/\b(?:Bun\.listen|createServer|createConnection)\s*\(/u.test(source)) {
    add("port:ephemeral", "exclusive")
  }
  if (
    /\b(?:writeFile|writeFileSync|rm|rmSync|rename|renameSync)\s*\([^\n]*(?:REPO_ROOT|repoRoot|process\.cwd\s*\()/u.test(
      source,
    )
  ) {
    add("checkout", "exclusive")
  }
  if (
    /\bgit\s+worktree\b|["']worktree["'][^\n]{0,80}["'](?:add|remove|prune|lock)["']/u.test(source)
  ) {
    add("git-common", "exclusive")
  }
  return claims.sort((left, right) => left.key.localeCompare(right.key))
}

export interface ResourceCertificationAuditRow {
  readonly testId: string
  readonly sourceSha256: string
  readonly status: "certified" | "missing" | "source-drift" | "intentionally-exclusive"
  readonly claims: readonly ResourceClaim[]
  readonly candidateClaims: readonly ResourceClaim[]
}

export const auditResourceCertifications = (
  files: readonly { readonly testId: string; readonly source: string }[],
  certifications: readonly TestResourceCertification[],
): readonly ResourceCertificationAuditRow[] =>
  [...files]
    .sort((left, right) => left.testId.localeCompare(right.testId))
    .map(({ testId, source }) => {
      const resolved = resolveResourceCertification({ testId, source, certifications })
      return {
        testId,
        sourceSha256: sourceSha256(source),
        status: resolved.kind === "certified" ? "certified" : resolved.reason,
        claims: resolved.claims,
        candidateClaims: inferResourceClaimCandidates(source),
      }
    })

/** True only when two certified claim sets may execute at the same time. */
export const resourceClaimSetsOverlap = (
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean => {
  if ([...left, ...right].some(({ key }) => key === "unknown")) return false
  const rightByKey = new Map(right.map((claim) => [claim.key, claim.mode]))
  return left.every((claim) => {
    const peerMode = rightByKey.get(claim.key)
    return peerMode === undefined || (claim.mode === "shared" && peerMode === "shared")
  })
}
