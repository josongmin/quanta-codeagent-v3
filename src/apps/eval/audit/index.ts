/**
 * Tier 0 — static audit entry. `bun run eval audit` runs every taxonomy leaf
 * through `auditOne`, appends per-leaf findings to the store, and writes a
 * matrix summary (see `report/coverage-matrix.ts`).
 */

import { logger } from "@/shared"
import { makeRunId, ResultStore } from "../storage"
import { allLeaves } from "../taxonomy"
import type { Verdict } from "../types"
import { type AuditConfig, type AuditFinding, auditOne, DEFAULT_CONFIG } from "./grep-mapper"
import { type AuditMatrix, buildMatrix } from "./matrix"
import { RULES } from "./rules"

export type { AuditConfig, AuditFinding, AuditMatrix }
export { buildMatrix, DEFAULT_CONFIG, RULES }

export interface AuditRunOpts {
  /** Override config (defaults to repo layout + curated rules). */
  config?: AuditConfig
  /** Override store dir (tests). */
  storeDir?: string
  /** Override clock (tests). */
  now?: () => number
}

export interface AuditRunResult {
  runId: string
  findings: readonly AuditFinding[]
  matrix: AuditMatrix
  durationMs: number
}

/** Run the full audit and persist results. Returns the in-memory summary too,
 *  so callers can render immediately without re-reading the store. */
export const runAudit = async (opts: AuditRunOpts = {}): Promise<AuditRunResult> => {
  const start = Date.now()
  const cfg: AuditConfig = { ...DEFAULT_CONFIG, rules: RULES, ...opts.config }
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("audit", opts.now)
  const findings: AuditFinding[] = []
  let auditErrors = 0
  for (const l of allLeaves()) {
    // `auditOne` should not throw under normal config — but a misconfigured
    // root, ENOENT race, or unexpected ripgrep crash could. Catch per-leaf so
    // one bad rule does not abort the whole audit, AND record the error
    // explicitly so the operator sees `error` count rather than mysteriously
    // missing leaves in the matrix.
    let f: AuditFinding
    try {
      f = auditOne(l.id, cfg)
    } catch (e) {
      auditErrors += 1
      const reason = e instanceof Error ? e.message : String(e)
      logger.warn("eval.audit: auditOne threw", { usecase: l.id, error: reason })
      f = { usecase: l.id, coverage: "tbd", evidence: [], note: `audit error: ${reason}` }
    }
    findings.push(f)
    await store.append(runId, {
      tier: "audit",
      usecase: l.id,
      payload: {
        kind: "audit",
        coverage: f.coverage,
        evidence: f.evidence,
        ...(f.note !== undefined ? { note: f.note } : {}),
      },
    })
  }
  const matrix = buildMatrix(findings)
  const counts: Record<Verdict, number> = {
    pass: matrix.totals.counts.ok,
    partial: matrix.totals.counts.partial,
    fail: matrix.totals.counts.no,
    error: auditErrors,
    skipped:
      matrix.totals.counts.tbd - auditErrors >= 0
        ? matrix.totals.counts.tbd - auditErrors
        : matrix.totals.counts.tbd,
  }
  const durationMs = Date.now() - start
  await store.finish({ runId, tier: "audit", argv: process.argv.slice(2), counts, durationMs })
  return { runId, findings, matrix, durationMs }
}
