/**
 * `@/apps/web-daemon/web-ask-user-port` — A1 (jul-03) — make the structured
 * `ask_user` tool FUNCTIONAL on the web surface by ADAPTING it onto the EXISTING
 * `request_user_input` WS round-trip (`UserInputRequester` → the `planInputAnswer`
 * frame the server already peeks + resolves). No new protocol / frame / renderer:
 * the browser's existing user-input panel renders `{prompt, choices}`; this maps a
 * structured {@link AskUserRequest} DOWN to that shape and maps the returned
 * free-text / chosen-label answer BACK to the typed {@link AskUserResult}.
 *
 * TRADE-OFF (documented, not hidden): rich chip `description`/`preview` flatten to
 * the option LABEL (the pickable value). A follow-up can add a rich structured
 * agent-state frame + card renderer; THIS makes `ask_user` work on web today over
 * the channel that already exists.
 *
 * DEPENDENCY: needs a live `UserInputRequester` (the daemon's web user-input port,
 * gated on `QUANTA_WEB_AGENT_STATE`). When absent the composition root wires no
 * ask-user port ⇒ the `ask_user` tool is not registered ⇒ byte-identical.
 *
 * PURE + NO-THROW: cancelled/absent ⇒ a closed `AskUserResult` failure arm;
 * out-of-range / unparseable / off-menu input ⇒ `validation-error` / `invalid-input`
 * — never a throw (a hostile answer must not strand the agent).
 */

import type { UserInputRequester } from "@/tool"
import type { AskUserOption, AskUserPort, AskUserRequest, AskUserResult } from "@/tool/ask-user"

/** The pickable value of an option — the bare string, or the chip's `label`. */
const optionLabel = (o: AskUserOption): string => (typeof o === "string" ? o : o.label)

/** Parse a free-text boolean answer; `null` when it is neither truthy nor falsy. */
const parseBoolean = (text: string): boolean | null => {
  const t = text.trim().toLowerCase()
  if (t === "yes" || t === "y" || t === "true" || t === "1") return true
  if (t === "no" || t === "n" || t === "false" || t === "0") return false
  return null
}

/**
 * Adapt a {@link UserInputRequester} (the web `request_user_input` round-trip)
 * into an {@link AskUserPort}. `idFactory` is injectable so a test can pin the
 * generated `promptId` (default: a UUID).
 */
export const createWebAskUserPort = (
  requester: UserInputRequester,
  idFactory: () => string = () => crypto.randomUUID(),
): AskUserPort => ({
  async ask(req: AskUserRequest): Promise<AskUserResult> {
    // Empty fixed-choice set is a programming error, resolvable WITHOUT prompting.
    if ((req.kind === "select" || req.kind === "multiselect") && req.options.length === 0) {
      return { ok: false, reason: "empty-options" }
    }
    const labels =
      req.kind === "select" || req.kind === "multiselect"
        ? req.options.map(optionLabel)
        : undefined
    // Multiselect degrades to a comma-separated free-text over the single-answer
    // channel — the instruction makes that explicit to the user.
    const prompt = req.kind === "multiselect" ? `${req.prompt} (comma-separated)` : req.prompt
    const outcome = await requester({
      promptId: idFactory(),
      prompt,
      ...(labels !== undefined ? { choices: labels } : {}),
      ...(req.kind === "string" ? { multiline: true } : {}),
    })
    if (outcome.decision === "cancelled") return { ok: false, reason: "cancelled" }
    const text = outcome.text
    switch (req.kind) {
      case "string": {
        if (req.minLength !== undefined && text.length < req.minLength) {
          return { ok: false, reason: "validation-error" }
        }
        if (req.maxLength !== undefined && text.length > req.maxLength) {
          return { ok: false, reason: "validation-error" }
        }
        if (req.pattern !== undefined) {
          let re: RegExp
          try {
            re = new RegExp(req.pattern)
          } catch {
            return { ok: false, reason: "validation-error" }
          }
          if (!re.test(text)) return { ok: false, reason: "validation-error" }
        }
        return { ok: true, value: text }
      }
      case "boolean": {
        const b = parseBoolean(text)
        return b === null ? { ok: false, reason: "invalid-input" } : { ok: true, value: b }
      }
      case "number":
      case "integer": {
        const n = Number(text.trim())
        if (!Number.isFinite(n)) return { ok: false, reason: "invalid-input" }
        if (req.kind === "integer" && !Number.isInteger(n)) {
          return { ok: false, reason: "validation-error" }
        }
        if (req.min !== undefined && n < req.min) return { ok: false, reason: "validation-error" }
        if (req.max !== undefined && n > req.max) return { ok: false, reason: "validation-error" }
        return { ok: true, value: n }
      }
      case "select": {
        // The value is the chosen LABEL; a fixed-choice select rejects off-menu text.
        if (!(labels ?? []).includes(text)) return { ok: false, reason: "invalid-input" }
        return { ok: true, value: text }
      }
      case "multiselect": {
        const valid = new Set(labels ?? [])
        const picked = [
          ...new Set(
            text
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        ]
        if (picked.some((p) => !valid.has(p))) return { ok: false, reason: "invalid-input" }
        if (req.minSelected !== undefined && picked.length < req.minSelected) {
          return { ok: false, reason: "validation-error" }
        }
        if (req.maxSelected !== undefined && picked.length > req.maxSelected) {
          return { ok: false, reason: "validation-error" }
        }
        return { ok: true, value: picked }
      }
    }
  },
})
