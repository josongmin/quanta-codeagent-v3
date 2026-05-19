import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Oversized tool-output spill — Phase 1 absorption of Claude Code v2's
 * `replaceOversizedResults` / `replaceOversizedImpl` content-replacement pass.
 *
 * CC enforces a per-message tool_result budget (`persistedOutputCap = 200000`,
 * see analysis/agent-loop-message-normalization.md §2.2): when a tool_result
 * exceeds the cap it persists the original to disk
 * (`.claude/tool-results/<toolUseId>.{txt|json}`) and substitutes a
 * `<persisted-output>…</persisted-output>` placeholder (`MYH`) whose body wraps
 * `DYH`'s `{filepath, preview, hasMore}`. We faithfully echo that wrapper here,
 * keyed off the tool output string (not a per-message byte budget) and writing
 * to `.quanta/tool-output/<uuid>.txt`.
 */

/** Default char cap — mirrors CC's `Xc9 / persistedOutputCap = 200000`. */
export const DEFAULT_TOOL_OUTPUT_MAX = 200_000

/** Chars kept from the head of an oversized output for the preview. */
export const HEAD_CHARS = 8_000

/** Chars kept from the tail of an oversized output for the preview. */
export const TAIL_CHARS = 4_000

export interface CapToolOutputOptions {
  /** Char cap; outputs at or below this are returned byte-identical. */
  maxChars: number
  /** Directory (created lazily) the full output is written into. */
  spillDir: string
  /**
   * Injected writer for the spill file (path, data). Defaults to a lazy
   * mkdir + writeFileSync. Override in tests to avoid IO.
   */
  write?: (path: string, data: string) => void
}

export interface CapToolOutputResult {
  /** The (possibly excerpted) output to hand back to the model. */
  output: string
  /** Absolute-ish spill path written, when the output was over cap. */
  spillPath?: string
}

function defaultWrite(path: string, data: string): void {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")))
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(path, data)
}

/**
 * Resolve the effective cap: explicit `maxChars` ›› positive value as-is;
 * `0`, negative, or non-finite ⇒ {@link DEFAULT_TOOL_OUTPUT_MAX}. The
 * `QUANTA_TOOL_OUTPUT_MAX` env override is applied by the caller (registry)
 * so this stays pure; an env of 0/unset/invalid falls back to the default.
 */
export function resolveMaxChars(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TOOL_OUTPUT_MAX
  }
  return Math.floor(raw)
}

/**
 * Read the `QUANTA_TOOL_OUTPUT_MAX` env override. Unset / empty / `0` /
 * non-numeric ⇒ {@link DEFAULT_TOOL_OUTPUT_MAX}.
 */
export function envMaxChars(env: Record<string, string | undefined>): number {
  return resolveMaxChars(Number(env.QUANTA_TOOL_OUTPUT_MAX))
}

/**
 * If `output` exceeds `maxChars`, persist the FULL output to
 * `<spillDir>/<uuid>.txt` and return a head+tail excerpt wrapped in a
 * `<persisted-output>` marker (faithfully echoing CC's `MYH` placeholder —
 * see analysis/agent-loop-message-normalization.md §2.2). Sub-cap outputs are
 * returned byte-identical with no IO.
 *
 * Pure except for the single `write` call (injectable for tests).
 */
export function capToolOutput(output: string, opts: CapToolOutputOptions): CapToolOutputResult {
  const maxChars = resolveMaxChars(opts.maxChars)
  if (output.length <= maxChars) {
    return { output }
  }

  const spillPath = join(opts.spillDir, `${randomUUID()}.txt`)
  const write = opts.write ?? defaultWrite
  write(spillPath, output)

  const originalChars = output.length
  const head = output.slice(0, HEAD_CHARS)
  // Guard against head/tail overlap on small caps: never re-show head bytes.
  const tailStart = Math.max(HEAD_CHARS, originalChars - TAIL_CHARS)
  const tail = output.slice(tailStart)
  const omitted = tailStart - HEAD_CHARS

  const marker =
    `<persisted-output>\n` +
    `Output (${originalChars} chars) exceeded the ${maxChars}-char tool-result ` +
    `budget and was persisted to disk. The full output is at: ${spillPath}\n` +
    `Read that file (e.g. with the Read tool) to see the complete output.\n` +
    `Below is a ${HEAD_CHARS}-char head + ${TAIL_CHARS}-char tail excerpt ` +
    `(${omitted} chars omitted in the middle).\n` +
    `--- head ---\n` +
    `${head}\n` +
    `--- … ${omitted} chars omitted … ---\n` +
    `${tail}\n` +
    `</persisted-output>`

  return { output: marker, spillPath }
}
