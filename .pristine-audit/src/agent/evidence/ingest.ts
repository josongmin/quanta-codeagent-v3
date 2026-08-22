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

/** Trim + bound the claim WITHOUT splitting a surrogate pair — a naive `slice(0,200)`
 *  can cut a multibyte char (한글/emoji) in half and emit a broken UTF-16 unit that
 *  corrupts tokenization downstream (adversarial-audit R1). Drops a dangling high
 *  surrogate at the boundary. */
const clampClaim = (s: string): string => {
  const t = s.trim()
  if (t.length <= CLAIM_MAX) return t
  let cut = t.slice(0, CLAIM_MAX)
  // Drop a dangling high surrogate (broken char), THEN any trailing combining marks
  // (U+0300… etc.) that would otherwise attach to nothing and corrupt tokenization
  // (adversarial-audit R2). `\p{M}` covers all Unicode mark categories.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  while (cut.length > 0 && /\p{M}$/u.test(cut)) cut = cut.slice(0, -1)
  return cut
}

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
    // Drop vendored frames (localization noise) AND frames with an empty text/file —
    // the ledger rejects empty claims, so filtering here keeps ingest total (no throw).
    .filter((f) => f.tier !== "vendored" && f.text.trim().length > 0 && f.file.trim().length > 0)
    .map((f) => ({
      turn,
      source: "test_output" as const,
      claim: clampClaim(f.text),
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
  claim: clampClaim(claim),
  confidence: "raw",
  revealHandle,
})
