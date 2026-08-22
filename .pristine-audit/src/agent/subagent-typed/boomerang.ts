/**
 * Boomerang result construction helpers (ADR-0218).
 *
 * The {@link BoomerangResult} surface is the SOLE thing that crosses the
 * parent/child boundary in mode-typed delegation. These helpers exist so
 * the router builds the same shape regardless of which terminal path the
 * child took (success / cancelled / budget-overflow / runner-error /
 * mode-missing / timeout). Centralizing here means the router can switch
 * on error kind without composing readonly-record literals inline.
 *
 * exactOptionalPropertyTypes: every helper OMITS absent fields rather than
 * spreading them as `undefined`. Tests assert the shape with `expect(obj).
 * not.toHaveProperty(...)` to catch silent regression.
 */

import type { AgentMode, BoomerangErrorKind, BoomerangResult } from "./port"

const SUMMARY_LIMIT = 200

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s

/** Build a SUCCESS boomerang. `summary` is truncated to ≤200 chars. */
export const successBoomerang = (params: {
  readonly mode: AgentMode
  readonly summary: string
  readonly turns: number
  readonly durationMs: number
  readonly artifacts?: Readonly<Record<string, string>>
  readonly tokens?: number
}): BoomerangResult => {
  const base: BoomerangResult = {
    ok: true,
    summary: truncate(params.summary, SUMMARY_LIMIT),
    mode: params.mode,
    turns: params.turns,
    durationMs: params.durationMs,
  }
  return {
    ...base,
    ...(params.artifacts !== undefined && Object.keys(params.artifacts).length > 0
      ? { artifacts: params.artifacts }
      : {}),
    ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
  }
}

/** Build a FAILURE boomerang. `errorKind` is mandatory so the host can
 *  branch deterministically; `errorMessage` is mandatory free-form prose. */
export const failureBoomerang = (params: {
  readonly mode: AgentMode
  readonly errorKind: BoomerangErrorKind
  readonly errorMessage: string
  readonly turns: number
  readonly durationMs: number
  /** Optional short summary — defaults to a kind-derived one-liner. */
  readonly summary?: string
  readonly tokens?: number
  readonly artifacts?: Readonly<Record<string, string>>
}): BoomerangResult => {
  const fallbackSummary = `(${params.errorKind})`
  const base: BoomerangResult = {
    ok: false,
    summary: truncate(params.summary ?? fallbackSummary, SUMMARY_LIMIT),
    mode: params.mode,
    turns: params.turns,
    durationMs: params.durationMs,
    errorKind: params.errorKind,
    errorMessage: truncate(params.errorMessage, 2000),
  }
  return {
    ...base,
    ...(params.artifacts !== undefined && Object.keys(params.artifacts).length > 0
      ? { artifacts: params.artifacts }
      : {}),
    ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
  }
}
