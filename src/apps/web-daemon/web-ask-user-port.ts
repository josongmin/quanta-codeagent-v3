/**
 * `@/apps/web-daemon/web-ask-user-port` — A1 (jul-03) — make the structured
 * `ask_user` tool FUNCTIONAL on the web surface by ADAPTING it onto the EXISTING
 * `request_user_input` WS round-trip (`UserInputRequester` → the `planInputAnswer`
 * frame the server already peeks + resolves). No new protocol / frame / renderer:
 * the browser's existing user-input panel renders `{prompt, choices}`; this maps a
 * structured {@link AskUserRequest} DOWN to that shape and maps the returned
 * free-text / chosen-label answer BACK to the typed {@link AskUserResult}.
 *
 * UUX-2-17 (jul-10 W4): `choices` stays the label-only pickable-value list
 * (label-only clients keep working), and option structure now rides ALONGSIDE
 * as optional `choiceDetails` (label + description) so the browser chips can
 * render description subtext. Remaining documented drop: `preview`.
 *
 * DEPENDENCY: needs a live `UserInputRequester` (the daemon's web user-input port,
 * gated on `QUANTA_WEB_AGENT_STATE`). When absent the composition root wires no
 * ask-user port ⇒ the `ask_user` tool is not registered ⇒ byte-identical.
 *
 * PURE + NO-THROW: cancelled/absent ⇒ a closed `AskUserResult` failure arm;
 * out-of-range / unparseable / off-menu input ⇒ `validation-error` / `invalid-input`
 * — never a throw (a hostile answer must not strand the agent).
 */

import type { PlanInputChoiceDetail } from "@/protocol/agent-state"
import type { AskUserOption, AskUserPort, AskUserRequest, AskUserResult } from "@/tool/ask-user"
import type { WebUserInputRequester } from "./web-user-input-port"

/** The pickable value of an option — the bare string, or the chip's `label`. */
const optionLabel = (o: AskUserOption): string => (typeof o === "string" ? o : o.label)

/** UUX-2-17 — per-option rich detail (label + description subtext). Returns
 *  `undefined` when NO option carries a description, so the request (and the
 *  wire frame downstream) stays byte-identical for label-only option sets.
 *  (`preview` remains a documented drop — the chips render label+description.) */
const optionDetails = (
  options: readonly AskUserOption[],
): readonly PlanInputChoiceDetail[] | undefined => {
  const details = options.map((o) =>
    typeof o === "string"
      ? { label: o }
      : { label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) },
  )
  return details.some((d) => d.description !== undefined) ? details : undefined
}

/** Parse a free-text boolean answer; `null` when it is neither truthy nor falsy. */
const parseBoolean = (text: string): boolean | null => {
  const t = text.trim().toLowerCase()
  if (t === "yes" || t === "y" || t === "true" || t === "1") return true
  if (t === "no" || t === "n" || t === "false" || t === "0") return false
  return null
}

/** Responsibility: validate a free-text `string` answer against the request's
 *  length window and pattern. An UNPARSEABLE pattern is a validation error, not
 *  a throw (a hostile answer must not strand the agent). */
const validateStringAnswer = (
  req: Extract<AskUserRequest, { kind: "string" }>,
  text: string,
): AskUserResult => {
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

/** Responsibility: validate a `number` / `integer` answer — the finite parse
 *  (unparseable ⇒ `invalid-input`), the integer-ness demand, then the min/max
 *  window (both ⇒ `validation-error`). */
const validateNumericAnswer = (
  req: Extract<AskUserRequest, { kind: "number" | "integer" }>,
  text: string,
): AskUserResult => {
  const n = Number(text.trim())
  if (!Number.isFinite(n)) return { ok: false, reason: "invalid-input" }
  if (req.kind === "integer" && !Number.isInteger(n)) {
    return { ok: false, reason: "validation-error" }
  }
  if (req.min !== undefined && n < req.min) return { ok: false, reason: "validation-error" }
  if (req.max !== undefined && n > req.max) return { ok: false, reason: "validation-error" }
  return { ok: true, value: n }
}

/** Responsibility: validate a `multiselect` answer — undo the comma-separated
 *  free-text degrade (split, trim, drop blanks, de-duplicate), reject anything
 *  off the fixed menu, then enforce the min/max selection counts. */
const validateMultiselectAnswer = (
  req: Extract<AskUserRequest, { kind: "multiselect" }>,
  labels: readonly string[] | undefined,
  text: string,
): AskUserResult => {
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

/** Responsibility: map the returned free-text answer BACK to the typed
 *  {@link AskUserResult}, dispatching on the request kind. */
const validateAnswer = (
  req: AskUserRequest,
  labels: readonly string[] | undefined,
  text: string,
): AskUserResult => {
  switch (req.kind) {
    case "string":
      return validateStringAnswer(req, text)
    case "boolean": {
      const b = parseBoolean(text)
      return b === null ? { ok: false, reason: "invalid-input" } : { ok: true, value: b }
    }
    case "number":
    case "integer":
      return validateNumericAnswer(req, text)
    case "select": {
      // The value is the chosen LABEL; a fixed-choice select rejects off-menu text.
      if (!(labels ?? []).includes(text)) return { ok: false, reason: "invalid-input" }
      return { ok: true, value: text }
    }
    case "multiselect":
      return validateMultiselectAnswer(req, labels, text)
  }
}

/** Responsibility: run ONE structured question over the web
 *  `request_user_input` round-trip — map the request DOWN to the
 *  `{prompt, choices, choiceDetails}` frame, await the single free-text answer,
 *  and hand it to the per-kind validator. */
const askOverUserInput = async (
  requester: WebUserInputRequester,
  idFactory: () => string,
  req: AskUserRequest,
): Promise<AskUserResult> => {
  // Empty fixed-choice set is a programming error, resolvable WITHOUT prompting.
  if ((req.kind === "select" || req.kind === "multiselect") && req.options.length === 0) {
    return { ok: false, reason: "empty-options" }
  }
  const labels =
    req.kind === "select" || req.kind === "multiselect" ? req.options.map(optionLabel) : undefined
  // UUX-2-17 — the rich structure rides ALONGSIDE the label-only `choices`
  // (which stays the pickable-value contract for label-only clients).
  const details =
    req.kind === "select" || req.kind === "multiselect" ? optionDetails(req.options) : undefined
  // Multiselect degrades to a comma-separated free-text over the single-answer
  // channel — the instruction makes that explicit to the user.
  const prompt = req.kind === "multiselect" ? `${req.prompt} (comma-separated)` : req.prompt
  const outcome = await requester({
    promptId: idFactory(),
    prompt,
    ...(labels !== undefined ? { choices: labels } : {}),
    ...(details !== undefined ? { choiceDetails: details } : {}),
    ...(req.kind === "string" ? { multiline: true } : {}),
  })
  if (outcome.decision === "cancelled") return { ok: false, reason: "cancelled" }
  return validateAnswer(req, labels, outcome.text)
}

/**
 * Adapt a {@link UserInputRequester} (the web `request_user_input` round-trip)
 * into an {@link AskUserPort}. `idFactory` is injectable so a test can pin the
 * generated `promptId` (default: a UUID).
 */
export const createWebAskUserPort = (
  requester: WebUserInputRequester,
  idFactory: () => string = () => crypto.randomUUID(),
): AskUserPort => ({
  async ask(req: AskUserRequest): Promise<AskUserResult> {
    return await askOverUserInput(requester, idFactory, req)
  },
})
