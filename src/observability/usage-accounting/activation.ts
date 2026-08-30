/**
 * Activation + shadow reconciliation for usage accounting (MR-08).
 *
 * The authority replaces how several surfaces get their numbers, so it ships
 * behind a three-position knob rather than a boolean:
 *
 *   - `on`     — the surfaces project the authority. THE DEFAULT: this is the
 *                accounting that actually covers subagents and prices every
 *                call at the model it ran on, so it is what a session gets
 *                unless the operator explicitly steps off it.
 *   - `shadow` — the authority records everything, and NOTHING reads from it.
 *                The surfaces keep the legacy feed, and a reconciliation
 *                receipt reports where the two disagree — the diagnostic mode
 *                for investigating a number someone does not believe.
 *   - `off`    — no authority is constructed and every surface keeps the
 *                legacy feed. The explicit kill switch.
 *
 * Shadow exists because the interesting failures here are not crashes, they are
 * plausible wrong totals. A mode that runs the new accounting beside the old
 * one and reports the delta is the only way to see those before switching.
 */
import { createUsageAccounting } from "./authority"
import type { UsageAccountingPort, UsageAccountingSnapshot } from "./port"

export type UsageAccountingMode = "off" | "shadow" | "on"

/** Env knob: `QUANTA_USAGE_ACCOUNTING_V2`. Unset or unrecognized ⇒ `on` — the
 *  default. Only the exact words `off` and `shadow` divert from it: a typo
 *  degrades to the DEFAULT rather than silently disabling the accounting,
 *  because "off when you wanted on" loses the session's books while "on when
 *  you wanted off" merely keeps them. */
export const usageAccountingMode = (
  env: Record<string, string | undefined>,
): UsageAccountingMode => {
  const raw = env.QUANTA_USAGE_ACCOUNTING_V2?.trim().toLowerCase()
  if (raw === "off") return "off"
  if (raw === "shadow") return "shadow"
  return "on"
}

/** The session's authority, or `undefined` in `off`. Both `shadow` and `on`
 *  construct one — they differ in who READS it, not in whether it records. */
export const createSessionUsageAccounting = (
  env: Record<string, string | undefined>,
): UsageAccountingPort | undefined =>
  usageAccountingMode(env) === "off" ? undefined : createUsageAccounting()

/** `true` when surfaces should PROJECT the authority. False in `shadow`, where
 *  it records but nothing reads it. */
export const usageAccountingIsAuthoritative = (env: Record<string, string | undefined>): boolean =>
  usageAccountingMode(env) === "on"

/** What the legacy feed believes, in the authority's own terms. */
export interface LegacyCostReading {
  readonly totalUsd: number
  readonly outputTokens: number
  /**
   * Total prompt tokens — cached and fresh — or OMITTED when the legacy feed
   * cannot express that provider-neutrally.
   *
   * This is optional because of a false alarm the shadow receipt actually
   * produced: the CLI's legacy feed reads `gen_ai.usage.input_tokens`, which is
   * PROVIDER-SHAPED. OpenAI's already contains the cached portion and
   * Anthropic's does not, so on an Anthropic session with cache reads the
   * legacy number and the authority's prompt total differ by exactly the cache
   * reads — and the receipt cried DIVERGES on a session where the two feeds
   * agreed perfectly. A receipt that fires on healthy sessions teaches the
   * operator to ignore it, which costs more than not having one.
   *
   * A caller supplies this only when its number means "all prompt tokens" for
   * every provider it might see. Dollars and output tokens carry the coverage
   * signal regardless: a call one feed missed shows up in both.
   */
  readonly promptTokens?: number
}

/** One line of "these two disagree, by this much". */
export interface UsageReconciliationDelta {
  readonly field: "totalUsd" | "promptTokens" | "outputTokens"
  readonly authority: number
  readonly legacy: number
  readonly delta: number
}

export interface UsageReconciliationReceipt {
  readonly agrees: boolean
  readonly deltas: readonly UsageReconciliationDelta[]
  /** Calls the authority admitted. A receipt over zero calls proves nothing;
   *  callers should say so rather than reading `agrees: true` as evidence. */
  readonly calls: number
}

/** Compare the authority against whatever the legacy feed reported.
 *
 *  Dollar comparison is to the cent, because sub-cent float noise is not a
 *  disagreement worth reporting and would bury the real ones. Token counts are
 *  integers and must match exactly — a token delta means the two feeds saw a
 *  different set of CALLS, which is the failure mode that matters here (a
 *  subagent reaching one and not the other), not a rounding difference. */
export const reconcileUsageAccounting = (
  snapshot: UsageAccountingSnapshot,
  legacy: LegacyCostReading,
): UsageReconciliationReceipt => {
  const authorityPrompt = snapshot.freshInputTokens + snapshot.cacheReadTokens
  const cents = (n: number) => Math.round(n * 100)
  const deltas: UsageReconciliationDelta[] = []
  if (cents(snapshot.totalUsd) !== cents(legacy.totalUsd)) {
    deltas.push({
      field: "totalUsd",
      authority: snapshot.totalUsd,
      legacy: legacy.totalUsd,
      delta: snapshot.totalUsd - legacy.totalUsd,
    })
  }
  if (legacy.promptTokens !== undefined && authorityPrompt !== legacy.promptTokens) {
    deltas.push({
      field: "promptTokens",
      authority: authorityPrompt,
      legacy: legacy.promptTokens,
      delta: authorityPrompt - legacy.promptTokens,
    })
  }
  if (snapshot.outputTokens !== legacy.outputTokens) {
    deltas.push({
      field: "outputTokens",
      authority: snapshot.outputTokens,
      legacy: legacy.outputTokens,
      delta: snapshot.outputTokens - legacy.outputTokens,
    })
  }
  return { agrees: deltas.length === 0, deltas, calls: snapshot.calls }
}

/** One-line human summary for a log or a `/cost` footer. */
export const formatReconciliationReceipt = (receipt: UsageReconciliationReceipt): string => {
  if (receipt.calls === 0) return "usage-accounting shadow: no calls recorded (nothing compared)"
  if (receipt.agrees) return `usage-accounting shadow: agrees across ${receipt.calls} calls`
  const parts = receipt.deltas.map((d) => `${d.field} ${d.authority} vs ${d.legacy}`)
  return `usage-accounting shadow: DIVERGES over ${receipt.calls} calls — ${parts.join("; ")}`
}
