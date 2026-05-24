/**
 * Issue-text hint extraction (Agentless paper, localization hint injection).
 *
 * Barrel — export-only. Five pure extractors compose into `extractIssueHint`,
 * and `composeIssueHint` turns the typed shape into a prompt-ready markdown
 * block. The bench driver wires this behind a default-OFF env gate
 * (`QUANTA_BENCH_ISSUE_HINT=1`) so measurement integrity is preserved.
 *
 * Slice posture (pure):
 *   - no I/O
 *   - no network
 *   - all extractors deterministic on their input
 *   - default-OFF at the bench seam (default-OFF means byte-identical
 *     measurement when the flag is unset)
 */
import { extractCodeFences, extractTracebackPaths } from "./extract-code"
import { extractErrors } from "./extract-errors"
import { extractFiles } from "./extract-files"
import { extractSymbols } from "./extract-symbols"
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
export { composeIssueHint } from "./compose"
export { extractCodeFences, extractTracebackPaths } from "./extract-code"
export { extractErrors } from "./extract-errors"
export { extractFiles } from "./extract-files"
export { extractSymbols } from "./extract-symbols"
export { EMPTY_HINT, type IssueHint } from "./types"

/** Run all five extractors over `text` and return the merged `IssueHint`. */
export const extractIssueHint = (text: string): IssueHint => {
  if (typeof text !== "string" || text === "") {
    return { files: [], symbols: [], errors: [], codeFences: [], tracebackPaths: [] }
  }
  return {
    files: extractFiles(text),
    symbols: extractSymbols(text),
    errors: extractErrors(text),
    codeFences: extractCodeFences(text),
    tracebackPaths: extractTracebackPaths(text),
  }
}
