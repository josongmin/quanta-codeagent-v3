#!/usr/bin/env bun
/**
 * The certification gate and the certification generator, in one command.
 *
 *   bun run tools/dev/test-resource-certification-audit.ts            report
 *   bun run tools/dev/test-resource-certification-audit.ts --check    gate
 *   bun run tools/dev/test-resource-certification-audit.ts --emit     regenerate
 *
 * `--check` answers three questions, and they are deliberately different from
 * each other:
 *
 *   1. Does every integration-path file have a DECISION? A file with no row is
 *      `missing`, which is the state all 562 of them were in.
 *   2. Has a certified file's own source changed since it was reviewed?
 *      (`source-drift` — the registry pins the test file's digest.)
 *   3. Has the PRODUCTION closure behind a certified file grown a hazard its
 *      row does not cover? This is containment, not equality: a closure that
 *      shed a claim is merely over-declared, and demanding equality would
 *      invalidate the registry on every `src/` commit.
 *
 * Never repairs the registry by itself. `--emit` writes; `--check` reports.
 */

import { writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import {
  analyzeTestFiles,
  createResourceAnalyzer,
  RESOURCE_ANALYZER_VERSION,
} from "./test-resource-analysis"
import {
  CERTIFICATION_SCHEMA,
  certificationCoversDerived,
  certificationDigest,
  loadTestResourceCertificationsSafe,
  type TestResourceCertification,
} from "./test-resource-certification"
import { resourceClaimKind } from "./test-resource-claims"
import {
  CERTIFICATION_REGISTRY_PATH,
  DEFAULT_REPO_ROOT,
  resetTestResourceResolution,
  resolveTestResource,
} from "./test-resource-resolution"
import { discoverSuiteFiles, SUITE_FLOORS } from "./test-shard-discovery"

const REPO_ROOT = DEFAULT_REPO_ROOT
const REGISTRY = join(REPO_ROOT, CERTIFICATION_REGISTRY_PATH)
const OWNER = "verification"

export interface CertificationAuditRow {
  readonly testId: string
  readonly status: "certified" | "intentionally-exclusive" | "missing" | "source-drift"
  readonly claims: readonly { readonly key: string; readonly mode: string }[]
  readonly derivedClaims: readonly { readonly key: string; readonly mode: string }[]
  readonly covered: boolean
  readonly unanalyzable: readonly string[]
}

const reasonForCertified = (moduleCount: number): string =>
  `Claims enumerated from the import closure (${moduleCount} repository modules) by ` +
  `${RESOURCE_ANALYZER_VERSION}; every reachable module and external specifier is accounted for.`

const reasonForExclusive = (unanalyzable: readonly string[]): string =>
  "Exclusive fallback: the import closure contains constructs this analyzer cannot read — " +
  `${unanalyzable.slice(0, 4).join(", ")}${unanalyzable.length > 4 ? ", …" : ""}. ` +
  "Claims cannot be justified from source, so the file keeps whole-resource exclusivity."

/** One registry row per analysed file. Certified only when nothing is opaque. */
const certificationFor = (analysis: {
  readonly id: string
  readonly sourceSha256: string
  readonly closureClaims: readonly { readonly key: string; readonly mode: string }[]
  readonly moduleCount: number
  readonly unanalyzable: readonly string[]
}): TestResourceCertification => {
  const opaque = analysis.closureClaims.some(({ key }) => resourceClaimKind(key) === "unknown")
  if (opaque) {
    return {
      testId: analysis.id,
      sourceSha256: analysis.sourceSha256,
      owner: OWNER,
      reason: reasonForExclusive(analysis.unanalyzable),
      status: "intentionally-exclusive",
      isolation: "checkout",
      claims: [{ key: "unknown", mode: "exclusive" }],
    }
  }
  return {
    testId: analysis.id,
    sourceSha256: analysis.sourceSha256,
    owner: OWNER,
    reason: reasonForCertified(analysis.moduleCount),
    status: "certified",
    isolation: "process",
    claims: analysis.closureClaims as readonly { key: string; mode: "shared" | "exclusive" }[],
    analyzer: RESOURCE_ANALYZER_VERSION,
    moduleCount: analysis.moduleCount,
  }
}

export const integrationPathPopulation = (repoRoot: string): readonly string[] => {
  const discovered = discoverSuiteFiles(repoRoot, "full")
  // Anti-vacuum floor on DISCOVERY, not on the answer: an audit that reports
  // "0 missing" because the walk returned nothing is the failure mode a pinned
  // population count was reaching for, and this catches it without pinning a
  // number that a growing corpus makes wrong by morning.
  if (discovered.length < SUITE_FLOORS.full) {
    throw new Error(
      `[resource-audit] discovery returned ${discovered.length} files, below the suite floor ` +
        `${SUITE_FLOORS.full}; refusing to audit a truncated universe`,
    )
  }
  return discovered
    .map((file) => relative(repoRoot, file))
    .filter((id) => resolveTestResource(id, { repoRoot }).resourceClass === "integration-path")
    .sort()
}

const main = (): void => {
  const emit = process.argv.includes("--emit")
  const check = process.argv.includes("--check")
  const population = integrationPathPopulation(REPO_ROOT)
  const analyzer = createResourceAnalyzer(REPO_ROOT)
  const analyses = analyzeTestFiles(REPO_ROOT, population, analyzer)

  if (emit) {
    const certifications = analyses.map(certificationFor)
    writeFileSync(
      REGISTRY,
      `${JSON.stringify({ schema: CERTIFICATION_SCHEMA, certifications }, null, 2)}\n`,
    )
    resetTestResourceResolution()
  }

  const loaded = loadTestResourceCertificationsSafe(REGISTRY)
  const byId = new Map(loaded.certifications.map((row) => [row.testId, row]))
  const rows: CertificationAuditRow[] = analyses.map((analysis) => {
    const row = byId.get(analysis.id)
    const derivedClaims = analysis.closureClaims
    if (row === undefined) {
      return {
        testId: analysis.id,
        status: "missing",
        claims: [],
        derivedClaims,
        covered: false,
        unanalyzable: analysis.unanalyzable,
      }
    }
    if (row.sourceSha256 !== analysis.sourceSha256) {
      return {
        testId: analysis.id,
        status: "source-drift",
        claims: row.claims,
        derivedClaims,
        covered: false,
        unanalyzable: analysis.unanalyzable,
      }
    }
    return {
      testId: analysis.id,
      status: row.status,
      claims: row.claims,
      derivedClaims,
      // An `intentionally-exclusive` row claims `unknown`, which covers
      // everything by construction; only a `certified` row can under-declare.
      covered:
        row.status === "intentionally-exclusive" ||
        certificationCoversDerived(row.claims, derivedClaims),
      unanalyzable: analysis.unanalyzable,
    }
  })

  const counts = rows.reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1
    return result
  }, {})
  const underDeclared = rows.filter((row) => !row.covered && row.status === "certified")
  const unresolved = rows.filter((row) => row.status === "missing" || row.status === "source-drift")
  const orphans = [...byId.keys()].filter((id) => !analyses.some((analysis) => analysis.id === id))

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "quanta.test-resource-certification-audit.v2",
        analyzer: RESOURCE_ANALYZER_VERSION,
        population: rows.length,
        modulesAnalyzed: analyzer.moduleCount,
        certificationDigest: certificationDigest(loaded.certifications),
        registryError: loaded.error,
        counts,
        unresolved: unresolved.map(({ testId, status }) => ({ testId, status })),
        underDeclared: underDeclared.map(({ testId, claims, derivedClaims }) => ({
          testId,
          claims,
          derivedClaims,
        })),
        orphans,
        rows,
      },
      null,
      2,
    )}\n`,
  )

  if (!check) return
  const failures: string[] = []
  if (loaded.error !== undefined) failures.push(`registry does not parse: ${loaded.error}`)
  if (unresolved.length > 0) {
    failures.push(
      `${unresolved.length} integration-path file(s) have no usable certification ` +
        `(${unresolved
          .slice(0, 3)
          .map(({ testId, status }) => `${testId}:${status}`)
          .join(", ")}${unresolved.length > 3 ? ", …" : ""})`,
    )
  }
  if (underDeclared.length > 0) {
    failures.push(
      `${underDeclared.length} certified file(s) under-declare their closure ` +
        `(${underDeclared
          .slice(0, 3)
          .map(({ testId }) => testId)
          .join(", ")}${underDeclared.length > 3 ? ", …" : ""}); re-run with --emit and review`,
    )
  }
  if (orphans.length > 0) {
    failures.push(
      `${orphans.length} certification(s) name files that are no longer integration-path ` +
        `(${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? ", …" : ""})`,
    )
  }
  if (failures.length === 0) return
  process.stderr.write(`[resource-audit] FAIL\n  - ${failures.join("\n  - ")}\n`)
  process.exitCode = 1
}

if (import.meta.main) main()
