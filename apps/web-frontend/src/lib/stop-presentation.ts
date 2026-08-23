/**
 * Stop-reason presentation for the web surface (aug-23 §13 follow-up).
 *
 * The core table lives at `src/agent/stop-category.ts`
 * (`STOP_PRESENTATION_BY_REASON_CODE`). The web bundle does not import from
 * `@/` — it consumes the protocol only — so the copy is mirrored here and a
 * drift contract test asserts the two stay in sync (adding a code to core
 * without a label here fails that test).
 *
 * `tone` decides treatment, not just color: `success` renders NOTHING. A badge
 * on a clean completion would be noise, and — more importantly — the whole
 * point of this workstream is that only real stops are marked.
 */

export type StopTone = "success" | "incomplete" | "blocked" | "failed" | "cancelled" | "refused"

export interface StopPresentation {
  readonly label: string
  readonly tone: StopTone
}

/** Mirrors `STOP_PRESENTATION_BY_REASON_CODE` in `src/agent/stop-category.ts`. */
export const STOP_PRESENTATION: Readonly<Record<string, StopPresentation>> = {
  "completed.normal": { label: "Done", tone: "success" },
  "completed.max_turns": { label: "Stopped at turn limit", tone: "incomplete" },
  "user.interrupt": { label: "Interrupted", tone: "cancelled" },
  "system.abort": { label: "Aborted by host", tone: "cancelled" },
  "budget.cost_cap": { label: "Stopped at cost cap", tone: "blocked" },
  "budget.ledger_breach": { label: "Stopped at spend ceiling", tone: "blocked" },
  "shell.needs_approval": { label: "Waiting for approval", tone: "blocked" },
  "model.refusal": { label: "Model declined", tone: "refused" },
  "model.empty_exhausted": { label: "Model returned nothing", tone: "failed" },
  "model.malformed_tool_use": { label: "Tool call was malformed", tone: "failed" },
  "compaction.thrash": { label: "Context compaction thrashed", tone: "failed" },
  "provider.rate_limit": { label: "Provider rate limit", tone: "failed" },
  "provider.overloaded": { label: "Provider overloaded", tone: "failed" },
  "provider.network": { label: "Network failure", tone: "failed" },
  "provider.auth": { label: "Provider auth failed", tone: "failed" },
  "provider.bad_request": { label: "Malformed request", tone: "failed" },
  "provider.unknown": { label: "Provider error", tone: "failed" },
  "runtime.unknown_error": { label: "Unexpected error", tone: "failed" },
  "loop.no_progress": { label: "Stopped making progress", tone: "failed" },
}

/** Presentation for a reason code. An UNKNOWN code degrades to a `failed` tone
 *  — never to `success`. Falling through to success on an unrecognized value is
 *  the exact defect this workstream exists to remove. */
export const stopPresentationFor = (reasonCode: string): StopPresentation =>
  STOP_PRESENTATION[reasonCode] ?? {
    label: "Stopped for an unrecognized reason",
    tone: "failed",
  }

/** Copy for the bubble badge, or `null` when the stop needs no marking. */
export const stopBadgeFor = (
  category: { readonly reasonCode: string } | undefined,
): StopPresentation | null => {
  if (category === undefined) return null
  const presentation = stopPresentationFor(category.reasonCode)
  return presentation.tone === "success" ? null : presentation
}
