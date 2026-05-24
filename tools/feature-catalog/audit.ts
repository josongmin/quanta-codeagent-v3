/**
 * Feature-catalog audit — single 4-lens sweep over current repo state.
 *
 * Lenses (all pure — caller provides inputs, this module computes no I/O):
 *
 *   1. orphan ADRs    — `Accepted` ADRs with no fc reference
 *   2. orphan src     — src/*.ts files not in any fc evidence.code
 *   3. empty stubs    — fc YAMLs with code:[] AND adrs:[] (migrated shells)
 *   4. recent commits — left to the CLI (needs `git`)
 *
 * The CLI (cli.ts) does the file I/O and stitches the lenses into a report.
 * Tests exercise each lens with synthetic fixtures.
 *
 * Why this lives in its own module: cli.ts is already 330 LOC of imperative
 * command dispatch; pure audit logic belongs apart so it can be unit-tested
 * deterministically (no real ADR/src filesystem dependency).
 */
import type { LoadedFeature } from "./schema"

export interface AuditInputs {
  /** All feature YAMLs loaded via `loadFeaturesStrict`. */
  readonly features: readonly LoadedFeature[]
  /** All src files in scope — caller responsible for excluding tests / index.ts.
   *  Paths are repo-relative (`src/foo/bar.ts`). */
  readonly srcFiles: readonly string[]
  /** ADR records (number + status string). `status` is the verbatim value from
   *  the ADR front-matter line; only `Accepted` counts as "must be in fc". */
  readonly adrs: readonly AdrRecord[]
}

export interface AdrRecord {
  readonly number: number
  /** Verbatim status string from ADR front-matter (e.g. "Accepted", "Proposed",
   *  "Skipped", "Reference-only"). Unknown / unparseable → empty string. */
  readonly status: string
}

export interface AuditReport {
  /** Accepted ADRs with no `evidence.adrs` reference in any feature. */
  readonly orphanAdrs: readonly number[]
  /** Src files not referenced by any feature's `evidence.code`. */
  readonly orphanSrcFiles: readonly string[]
  /** Features whose evidence is fully empty (code:[] AND adrs:[] AND no test
   *  files). These are the migrated-shell backlog. */
  readonly emptyStubs: readonly EmptyStub[]
  /** Counts derived from the above — what `lint` ratchets on. */
  readonly counts: AuditCounts
}

export interface EmptyStub {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface AuditCounts {
  readonly orphanAdrs: number
  readonly orphanSrcFiles: number
  readonly emptyStubs: number
  readonly totalFeatures: number
  readonly totalAdrs: number
  readonly totalSrcFiles: number
}

/** Run all three pure lenses and return a single report. */
export function runAudit(input: AuditInputs): AuditReport {
  const referencedAdrs = collectReferencedAdrs(input.features)
  const referencedSrc = collectReferencedSrc(input.features)

  const orphanAdrs = input.adrs
    .filter((a) => a.status === "Accepted" && !referencedAdrs.has(a.number))
    .map((a) => a.number)
    .sort((a, b) => a - b)

  const orphanSrcFiles = input.srcFiles
    .filter((p) => !referencedSrc.has(p))
    .slice()
    .sort()

  const emptyStubs = input.features
    .filter(({ feature }) => isEmptyStub(feature))
    .map(({ feature, path }) => ({ id: feature.id, title: feature.title, path }))
    .sort((a, b) => a.path.localeCompare(b.path))

  return {
    orphanAdrs,
    orphanSrcFiles,
    emptyStubs,
    counts: {
      orphanAdrs: orphanAdrs.length,
      orphanSrcFiles: orphanSrcFiles.length,
      emptyStubs: emptyStubs.length,
      totalFeatures: input.features.length,
      totalAdrs: input.adrs.length,
      totalSrcFiles: input.srcFiles.length,
    },
  }
}

/** True iff the feature has fully-empty evidence: no code, no adrs, no tests. */
export function isEmptyStub({ evidence }: LoadedFeature["feature"]): boolean {
  if (evidence.code.length > 0) return false
  if (evidence.adrs.length > 0) return false
  if (evidence.tests.unit.length > 0) return false
  if (evidence.tests.integration.length > 0) return false
  if (evidence.tests.contract.length > 0) return false
  return true
}

function collectReferencedAdrs(features: readonly LoadedFeature[]): ReadonlySet<number> {
  const out = new Set<number>()
  for (const { feature } of features) {
    for (const ref of feature.evidence.adrs) {
      const number = parseAdrReference(ref)
      if (number !== null) out.add(number)
    }
  }
  return out
}

function collectReferencedSrc(features: readonly LoadedFeature[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const { feature } of features) {
    for (const p of feature.evidence.code) out.add(p)
  }
  return out
}

function parseAdrReference(ref: string | number): number | null {
  if (typeof ref === "number") return Number.isInteger(ref) ? ref : null
  if (ref.includes("/")) {
    const pathMatch = /(?:^|\/)(\d+)-[^/]+(?:\.md)?$/.exec(ref)
    return pathMatch ? Number(pathMatch[1]) : null
  }
  const inlineMatch = /(\d+)/.exec(ref)
  return inlineMatch ? Number(inlineMatch[1]) : null
}

/** Parse the verbatim status string from an ADR markdown file's front-matter
 *  block. Looks for the first `- **Status**: X` or `- **상태**: X` line.
 *  Returns the first non-whitespace token after the colon, or `""` if absent.
 *  Pure — caller provides the file contents. */
export function parseAdrStatus(markdown: string): string {
  for (const line of markdown.split("\n").slice(0, 30)) {
    const m = /^- \*\*(?:Status|상태)\*\*:\s*(\S+)/.exec(line)
    if (m) return m[1] ?? ""
  }
  return ""
}

/** Render the report as a human-readable text block. Used by `bun fc audit`. */
export function formatAuditReport(r: AuditReport): string {
  const lines: string[] = []
  lines.push(
    `audit: ${r.counts.totalFeatures} features / ${r.counts.totalAdrs} ADRs / ${r.counts.totalSrcFiles} src files`,
  )
  lines.push("")
  lines.push(`orphan ADRs (Accepted, no fc reference): ${r.counts.orphanAdrs}`)
  for (const n of r.orphanAdrs) lines.push(`  ADR-${String(n).padStart(4, "0")}`)
  lines.push("")
  lines.push(`empty stubs (code:[] adrs:[] tests:[]): ${r.counts.emptyStubs}`)
  for (const s of r.emptyStubs.slice(0, 20)) lines.push(`  ${s.path}  (${s.id})`)
  if (r.emptyStubs.length > 20) lines.push(`  ... and ${r.emptyStubs.length - 20} more`)
  lines.push("")
  lines.push(`orphan src files (no fc evidence): ${r.counts.orphanSrcFiles}`)
  for (const p of r.orphanSrcFiles.slice(0, 20)) lines.push(`  ${p}`)
  if (r.orphanSrcFiles.length > 20) lines.push(`  ... and ${r.orphanSrcFiles.length - 20} more`)
  return lines.join("\n")
}
