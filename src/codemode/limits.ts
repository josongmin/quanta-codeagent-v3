/**
 * `@/codemode/limits` — pure cap helpers (RFC §4.4). The numeric DEFAULTS live
 * in the tool layer (derived from runtime-config knobs); this module only holds
 * the pure, deterministic helpers the runtime applies (output capping). No
 * `Date.now`, no randomness.
 */

import { redactSecrets } from "@/security"

/** 30 s wall-clock deadline for a code-mode cell (RFC §4.4). Named so the
 *  magic wall-clock literal is bound to a documented UPPER_SNAKE_CASE const
 *  (anti-regression `no-undocumented-magic-timeout` contract) — a single cell
 *  must terminate well inside a turn so a runaway cell can never wedge the loop. */
const CODE_MODE_TIMEOUT_MS = 30_000

/** Hard floor / sane defaults the tool layer falls back to when a knob is
 *  unset. Exposed so the tool + tests share ONE source (no magic drift). */
export const CODE_MODE_DEFAULTS = Object.freeze({
  /** 64 MiB WASM heap (RFC §4.4). */
  memoryBytes: 64 * 1024 * 1024,
  /** 30 s wall-clock deadline (RFC §4.4). */
  timeoutMs: CODE_MODE_TIMEOUT_MS,
  /** 64 in-cell dispatches per cell (RFC §4.4). */
  maxCalls: 64,
  /** 16 KiB model-facing output cap (RFC §4.4). */
  outputCap: 16 * 1024,
})

/** Truncation marker appended when output exceeds the cap. */
const TRUNCATED_MARKER = "\n…[truncated]"

/** Cap `text` to `outputCap` bytes (chars — the cap is a coarse byte-ish guard,
 *  not a Unicode-exact budget). Returns the (possibly) truncated text + a flag.
 *  Deterministic; never throws. */
export const capOutput = (
  text: string,
  outputCap: number,
): { text: string; truncated: boolean } => {
  if (text.length <= outputCap) return { text, truncated: false }
  const head = text.slice(0, Math.max(0, outputCap - TRUNCATED_MARKER.length))
  return { text: head + TRUNCATED_MARKER, truncated: true }
}

/**
 * Redact + cap the cell's model-facing output, in that order (RFC §6.3): the
 * SAME `redactSecrets` chokepoint a normal tool result passes through, THEN the
 * size cap. A secret pattern in the return value is replaced before the model
 * ever sees it; an over-cap return is truncated. Deterministic; never throws.
 */
export const redactAndCap = (
  text: string,
  outputCap: number,
): { text: string; truncated: boolean } => {
  // Layer-2 format-pattern redaction. `origin:"tool_result"` — the cell's
  // model-facing output is, to the redaction chokepoint, tool-result text
  // (RFC §6.3). No `sourceClass` ⇒ format-pattern matching (not the secret
  // short-circuit), redacted exactly like any normal tool result.
  const redacted = redactSecrets(text, { origin: "tool_result" }).text
  return capOutput(redacted, outputCap)
}
