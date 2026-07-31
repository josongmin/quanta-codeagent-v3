/**
 * Issue-text hint extraction (Agentless paper, localization hint injection +
 * reproduction test gen).
 *
 * Barrel — export-only. The seven pure extractors compose into
 * `extractIssueHint`, and `composeIssueHint` turns the typed shape into a
 * prompt-ready markdown block. The bench driver wires this behind a
 * default-OFF env gate (`QUANTA_BENCH_ISSUE_HINT=1`) so measurement integrity
 * is preserved.
 *
 * Expected/Actual extraction is opt-in via a SEPARATE gate
 * (`QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`) because the pattern is
 * false-positive-prone in prose. Default-OFF even when the parent
 * `QUANTA_BENCH_ISSUE_HINT` is enabled.
 *
 * Slice posture (pure):
 *   - no I/O
 *   - no network
 *   - all extractors deterministic on their input
 *   - default-OFF at the bench seam (byte-identical measurement when unset)
 */

import { normalizePublicIssueText } from "@/shared"
import { extractCodeFences, extractTracebackPaths } from "./extract-code"
import { extractErrors } from "./extract-errors"
import { extractExpectedActual } from "./extract-expected-actual"
import { extractFiles } from "./extract-files"
import { extractRefs } from "./extract-refs"
import { extractSymbols } from "./extract-symbols"
import { extractTracebacks } from "./extract-tracebacks"
import type { IssueHint } from "./types"

export type {
  AgentlessLocalizeDeps,
  AgentlessLocalizeResult,
} from "./agentless-localize"
export {
  agentlessLocalize,
  buildAgentlessPrompt,
  composeAgentlessHint,
  parseAgentlessResponse,
} from "./agentless-localize"
export type { BudgetOverflow, BudgetSegment } from "./budget-collector"
export { collectBudgeted } from "./budget-collector"
export { composeIssueHint } from "./compose"
export type { CodeFenceSegment } from "./extract-code"
export {
  extractCodeFenceSegments,
  extractCodeFences,
  extractTracebackPaths,
} from "./extract-code"
export { extractErrors } from "./extract-errors"
export { extractExpectedActual } from "./extract-expected-actual"
export { extractFiles } from "./extract-files"
export { extractRefs } from "./extract-refs"
export { extractSymbols } from "./extract-symbols"
export type { TracebackSegment } from "./extract-tracebacks"
export { extractTracebackSegments, extractTracebacks } from "./extract-tracebacks"
export { EMPTY_HINT, type IssueHint } from "./types"

/** Options for `extractIssueHint`. `withExpectedActual` toggles the opt-in
 *  E/A extraction. Default false — the bench driver decides based on its
 *  own env var (`QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL`). */
export interface ExtractIssueHintOptions {
  readonly withExpectedActual?: boolean
}

const EMPTY_RESULT: IssueHint = {
  files: [],
  symbols: [],
  errors: [],
  codeFences: [],
  tracebacks: [],
  tracebackPaths: [],
  refs: [],
}

/** Run all extractors over `text` and return the merged `IssueHint`. The
 *  optional `withExpectedActual` flag controls whether the opt-in E/A
 *  extractor runs; when true and matches are found, the `expectedActual`
 *  property is added; when false (or no matches found), the property is
 *  OMITTED entirely (exactOptionalPropertyTypes-compatible). */
export const extractIssueHint = (text: string, opts?: ExtractIssueHintOptions): IssueHint => {
  if (typeof text !== "string" || text === "") return EMPTY_RESULT
  const normalized = normalizePublicIssueText(text)
  if (normalized === undefined || normalized === "") return EMPTY_RESULT
  const base: IssueHint = {
    files: extractFiles(normalized),
    symbols: extractSymbols(normalized),
    errors: extractErrors(normalized),
    codeFences: extractCodeFences(normalized),
    tracebacks: extractTracebacks(normalized),
    tracebackPaths: extractTracebackPaths(normalized),
    refs: extractRefs(normalized),
  }
  if (opts?.withExpectedActual === true) {
    const ea = extractExpectedActual(normalized)
    if (ea.length > 0) return { ...base, expectedActual: ea }
  }
  return base
}
