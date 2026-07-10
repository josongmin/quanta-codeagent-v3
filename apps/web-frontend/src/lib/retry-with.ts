/**
 * P2 (jul-11, UUX-4-18) — /retry-with parity core (pure, DOM-free).
 *
 * The CLI /retry-with re-runs the last turn with a different model. The web
 * session protocol carries NO per-turn model (`TurnRunCommand` is an empty
 * envelope — the model is a session-level override set via `/model` →
 * `postConfig({QUANTA_MODEL})`). So the honest web equivalent is a TWO-STEP:
 *   1. switch the model override (same seam /model uses), then
 *   2. RESEND the last user message as a fresh turn under the new model.
 * The palette entry wires this plan to postConfig + sendTurn; this module is
 * the testable core (last-user extraction + the plan).
 */
import type { UiMessage } from "../types/protocol"

/** The newest USER message's text (non-empty after trim), or null. */
export const lastUserText = (messages: readonly UiMessage[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "user" && m.text.trim().length > 0) return m.text
  }
  return null
}

export type RetryWithPlan =
  | { readonly ok: true; readonly slug: string; readonly resendText: string }
  | { readonly ok: false; readonly reason: "no_slug" | "no_prior_turn" }

/** Plan a /retry-with: validate the slug + find the last user message. The
 *  caller executes (postConfig then sendTurn) only on `ok`. */
export const planRetryWith = (rawSlug: string, messages: readonly UiMessage[]): RetryWithPlan => {
  const slug = rawSlug.trim()
  if (slug.length === 0) return { ok: false, reason: "no_slug" }
  const resendText = lastUserText(messages)
  if (resendText === null) return { ok: false, reason: "no_prior_turn" }
  return { ok: true, slug, resendText }
}
