/**
 * Observation ingest (jul-5, SOTA++ P1) — pure adapters that turn already-extracted
 * tool output into {@link EvidenceCardInput}s.
 *
 * SLICE PURITY: this file stays free of `@/tool` / `@/llm`. Source-specific PARSING
 * (e.g. `parseTestFailure` in `@/tool`) is done by the WIRING site, which then passes
 * the minimal parsed shape (`ParsedTestFrame`) here. That keeps the evidence slice a
 * pure data layer while still reusing the battle-tested parsers at the edge.
 */

import type { EvidenceCardInput } from "./types"

const CLAIM_MAX = 200

/** Minimal shape the test-failure parser yields (file:line + a tier + the raw line).
 *  Deliberately NOT importing `FailureFrame` from `@/tool` — the wiring maps it to this. */
export interface ParsedTestFrame {
  readonly file: string
  readonly line?: number
  readonly tier: "user" | "test" | "vendored"
  readonly text: string
}

/** Test output → cards. Vendored frames are dropped (noise for fault localization —
 *  same ranking rationale as `parse-test-failure`); user/test frames become `parsed`
 *  cards located at their file:line. */
export const ingestTestFrames = (
  frames: readonly ParsedTestFrame[],
  turn: number,
): EvidenceCardInput[] =>
  frames
    .filter((f) => f.tier !== "vendored")
    .map((f) => ({
      turn,
      source: "test_output" as const,
      claim: f.text.trim().slice(0, CLAIM_MAX),
      confidence: "parsed" as const,
      location: {
        file: f.file,
        ...(f.line !== undefined ? { lineStart: f.line } : {}),
      },
    }))

/** Fallback: raw tool output we don't have a structured parser for yet becomes a
 *  single `raw` card carrying only a reveal handle (the model opens it on demand —
 *  the ledger never inlines the dump). */
export const ingestRawObservation = (
  source: EvidenceCardInput["source"],
  claim: string,
  turn: number,
  revealHandle: string,
): EvidenceCardInput => ({
  turn,
  source,
  claim: claim.trim().slice(0, CLAIM_MAX),
  confidence: "raw",
  revealHandle,
})
