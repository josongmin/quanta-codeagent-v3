/**
 * ONE source-aware resolution, shared by policy, planner, scheduler and receipt.
 *
 * # The defect this replaces
 *
 * `test-policy.ts` asked the classifier what a file owned by calling
 * `classifyTestResource(id, "")` — with an EMPTY source. The classifier's
 * contract is "source evidence wins over the path heuristic", so an empty
 * source means the path heuristic ALWAYS wins, and `policy.resources` was the
 * answer to a question nobody asked. The planner, meanwhile, read the real
 * file. MEASURED at this HEAD, before the fix: **359 of 3,950** discovered
 * files resolved to a different resource in the two layers —
 *
 *     src/agent/converge/converge.test.ts          policy=pure  planner=port
 *     src/agent/mention-injection/…/anchor-synth…  policy=pure  planner=lsp
 *
 * — so the policy layer was reporting `pure` for files that open sockets, and
 * nothing consumed it, which is the only reason it went unnoticed.
 *
 * The fix is not a second classifier that happens to agree. It is ONE
 * resolution, memoised on (path, size, mtime), that every layer calls.
 *
 * # What a resolution contains
 *
 * The legacy CLASS (what the runner's chunking, membership buckets, worker
 * HOME policy and cache identity are keyed on) and the typed CLAIM SET (what
 * the scheduler should be deciding on). Both come from the same read of the
 * same bytes.
 */

import { readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadTestResourceCertificationsSafe,
  resolveResourceCertification,
  sourceSha256,
  type TestResourceCertification,
} from "./test-resource-certification"
import {
  CLASS_RESOURCE_CLAIMS,
  pathOnlyResourceClass,
  type ResourceClaim,
  resourceEvidenceFor,
  type TestResourceClass,
} from "./test-resource-claims"

export const DEFAULT_REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const CERTIFICATION_REGISTRY_PATH = "tools/dev/test-resource-certifications.json"

export type CertificationState =
  | "certified"
  | "intentionally-exclusive"
  | "missing"
  | "source-drift"
  | "unknown-claim"
  | "not-read"

export interface ResolvedTestResource {
  /** Canonical repo-relative id. */
  readonly id: string
  /** undefined when the file could not be read (synthetic ids in tests). */
  readonly sourceSha256: string | undefined
  readonly resourceClass: TestResourceClass
  /** Claims the file's OWN source supports. Reporting and audit input. */
  readonly evidenceClaims: readonly ResourceClaim[]
  /**
   * What the scheduler should use.
   *
   * Certified files expose their reviewed claim set. EVERY other file exposes
   * its CLASS's claim set, which carries `unknown` for every non-pure class —
   * the honest content of first-match classification. Deliberately NOT the
   * richer per-file evidence: `pure` overlapping everything is the shipped,
   * measured parallelism win, and handing a `pure` file a `child-process`
   * claim it was never scheduled with would withdraw that win from 3,028
   * files on the strength of an unreviewed regex.
   */
  readonly claims: readonly ResourceClaim[]
  readonly certification: CertificationState
}

interface CacheEntry {
  readonly size: number
  readonly mtimeMs: number
  readonly resolved: ResolvedTestResource
}

const cacheByRoot = new Map<string, Map<string, CacheEntry>>()
const certificationsByRoot = new Map<string, readonly TestResourceCertification[]>()

const certificationsFor = (repoRoot: string): readonly TestResourceCertification[] => {
  const cached = certificationsByRoot.get(repoRoot)
  if (cached !== undefined) return cached
  // A malformed or missing registry must degrade to "nothing is certified" —
  // i.e. every file falls back to its class claims, which carry `unknown` and
  // therefore serialize. Throwing here would instead take down every campaign
  // and every policy resolution in the repository.
  const loaded = loadTestResourceCertificationsSafe(join(repoRoot, CERTIFICATION_REGISTRY_PATH))
  certificationsByRoot.set(repoRoot, loaded.certifications)
  return loaded.certifications
}

/** Drop memoised state. For tests that write a registry and re-resolve. */
export const resetTestResourceResolution = (): void => {
  cacheByRoot.clear()
  certificationsByRoot.clear()
}

export const canonicalTestId = (file: string, repoRoot: string): string =>
  isAbsolute(file) ? relative(repoRoot, file) : file.replace(/^\.\//u, "")

const resolveFromSource = (
  id: string,
  source: string,
  certifications: readonly TestResourceCertification[],
): ResolvedTestResource => {
  const evidence = resourceEvidenceFor(source)
  const resourceClass = evidence.classSignal ?? pathOnlyResourceClass(id)
  const certification = resolveResourceCertification({ testId: id, source, certifications })
  return {
    id,
    sourceSha256: sourceSha256(source),
    resourceClass,
    evidenceClaims: evidence.claims,
    claims:
      certification.kind === "certified"
        ? certification.claims
        : CLASS_RESOURCE_CLAIMS[resourceClass],
    certification: certification.kind === "certified" ? "certified" : certification.reason,
  }
}

/**
 * Resolve one test file. `source` is for synthetic callers only; production
 * callers pass the path and let this read the bytes exactly once.
 */
export const resolveTestResource = (
  file: string,
  options: { readonly repoRoot?: string; readonly source?: string } = {},
): ResolvedTestResource => {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const id = canonicalTestId(file, repoRoot)
  const certifications = certificationsFor(repoRoot)
  if (options.source !== undefined) return resolveFromSource(id, options.source, certifications)
  const absolute = resolve(repoRoot, id)
  let stats: { size: number; mtimeMs: number }
  try {
    stats = statSync(absolute)
  } catch {
    // A path that is not on disk (a synthetic id in a unit test, a file another
    // session just deleted) has no source evidence at all, so the path
    // heuristic is the ONLY honest answer — and it is marked `not-read` so a
    // caller can tell "no evidence" from "evidence says pure".
    const resourceClass = pathOnlyResourceClass(id)
    return {
      id,
      sourceSha256: undefined,
      resourceClass,
      evidenceClaims: [],
      claims: CLASS_RESOURCE_CLAIMS[resourceClass],
      certification: "not-read",
    }
  }
  const cache = cacheByRoot.get(repoRoot) ?? new Map<string, CacheEntry>()
  cacheByRoot.set(repoRoot, cache)
  const hit = cache.get(id)
  if (hit !== undefined && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) {
    return hit.resolved
  }
  const resolved = resolveFromSource(id, readFileSync(absolute, "utf8"), certifications)
  cache.set(id, { size: stats.size, mtimeMs: stats.mtimeMs, resolved })
  return resolved
}

/**
 * The resource list `test-policy.ts` should publish.
 *
 * Shape-compatible with what `pathResources` returns today (`[]` for `pure`,
 * otherwise a one-element class list), so the integrator's diff is a single
 * call-site change and no policy consumer has to move at the same time. The
 * difference is that the answer now comes from the file's SOURCE.
 *
 * The three out-of-band prefixes keep their hand-written answers: those
 * populations are not in the shard runner's suites, are executed by a
 * different command, and their `exclusive` marker is a statement about the
 * COMMAND, not about the file's source.
 */
export const policyTestResources = (
  id: string,
  options: { readonly repoRoot?: string } = {},
): readonly string[] => {
  if (id.startsWith("tests/contract/")) return ["exclusive", "docker"]
  if (id.startsWith("tests/e2e-pty/")) return ["exclusive", "pty"]
  if (id.includes("apps/web-frontend/")) return ["exclusive"]
  const resolved = resolveTestResource(id, options)
  return resolved.resourceClass === "pure" ? [] : [resolved.resourceClass]
}

export interface ResourceResolutionSnapshot {
  readonly byId: ReadonlyMap<string, ResolvedTestResource>
  /** Identity of the resolution the receipt should record. */
  readonly digest: string
  readonly counts: Readonly<Record<CertificationState, number>>
}

const EMPTY_COUNTS: Readonly<Record<CertificationState, number>> = {
  certified: 0,
  "intentionally-exclusive": 0,
  missing: 0,
  "source-drift": 0,
  "unknown-claim": 0,
  "not-read": 0,
}

/**
 * Resolve a whole population once. The digest is over (id, class, claims,
 * certification state) so a receipt that records it proves WHICH resolution
 * the campaign scheduled on — not merely that a registry file existed.
 */
export const resolveTestResourceSnapshot = (
  files: readonly string[],
  options: { readonly repoRoot?: string } = {},
): ResourceResolutionSnapshot => {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const byId = new Map<string, ResolvedTestResource>()
  const counts: Record<CertificationState, number> = { ...EMPTY_COUNTS }
  for (const file of files) {
    const resolved = resolveTestResource(file, { repoRoot })
    byId.set(resolved.id, resolved)
    counts[resolved.certification] += 1
  }
  const hasher = new Bun.CryptoHasher("sha256")
  for (const id of [...byId.keys()].sort()) {
    const row = byId.get(id) as ResolvedTestResource
    hasher.update(
      `${id}\u0000${row.resourceClass}\u0000${row.certification}\u0000${row.claims
        .map(({ key, mode }) => `${key}=${mode}`)
        .join(",")}\n`,
    )
  }
  return { byId, digest: hasher.digest("hex"), counts }
}
