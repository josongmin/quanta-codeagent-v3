/**
 * Tier-agnostic reporter. Reads the whole store, builds the matrix, renders
 * markdown. The CLI subcommand `eval report` writes to stdout (or a file via
 * shell redirect); programmatic callers receive the strings directly.
 */
import { ResultStore } from "../storage"
import { buildCoverageMatrix, type CoverageMatrix } from "./coverage-matrix"
import { renderHeadline, renderMatrixMarkdown } from "./markdown"

export type { CoverageMatrix }
export { buildCoverageMatrix, renderHeadline, renderMatrixMarkdown }

export interface ReportOpts {
  /** Override store dir. */
  storeDir?: string
}

export interface ReportOutput {
  headline: string
  markdown: string
  matrix: CoverageMatrix
}

export const buildReport = (opts: ReportOpts = {}): ReportOutput => {
  const store = new ResultStore({ ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}) })
  const matrix = buildCoverageMatrix(store.readAll())
  return {
    headline: renderHeadline(matrix),
    markdown: renderMatrixMarkdown(matrix),
    matrix,
  }
}
