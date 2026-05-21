/**
 * Review-kind permission matrix (ADR-0070).
 *
 * Absorbed from Cursor's HITL approval gate. Cursor's gate carries a typed
 * `ReviewKind`, a per-kind `isExecutionBlocking()` (notably PLAN is
 * NON-blocking), a typed `reason_code` on the stop, and per-gate decision
 * verbs that go BEYOND allow/deny — including scoped allowlist verbs and a
 * REJECT_AND_TELL verb that carries a steering message back to the model.
 *
 * This module is PURE and ADDITIVE. It introduces NO behavior change to the
 * existing decision path (`evaluate` / `evaluateStack` / `reviewAction`):
 * nothing here is called from those paths. A future caller opts in by reading
 * `stopCategoryFor` to emit a typed stop and by validating a chosen
 * `ReviewDecision` with `isDecisionLegalFor`. Default-OFF / byte-identical:
 * absent a caller, the existing `PermissionDecision` (allow/ask/deny) is the
 * only live contract.
 *
 * Relationship to the existing axes:
 *   - `HITLTier` (ADR-0020) classifies the action's intrinsic RISK shape.
 *   - `ReviewerTier` (ADR-0029) selects WHO renders the decision.
 *   - `ReviewKind` (here) classifies WHAT KIND of operation is under review
 *     and — via `isExecutionBlocking` — whether the turn must halt for it.
 * The three axes are orthogonal and compose; this module never mutates the
 * semantics of the other two.
 *
 * Conventions mirror `src/agent/steering.ts`: closed unions via
 * union-of-literals + an `ALL_*` runtime array, exhaustive switches with a
 * `never` default, no sentinels / no silent normalization, no `any`.
 */

/**
 * The category of operation being reviewed. Closed union — adding a member
 * requires an ADR amendment and updates to every exhaustive switch below.
 *
 *  - `edit`       — a file mutation (create / overwrite / patch).
 *  - `delete`     — a file/path removal.
 *  - `terminal`   — a shell-equivalent command execution.
 *  - `mcp`        — an MCP server tool invocation.
 *  - `web_fetch`  — fetching a specific URL/domain.
 *  - `web_search` — a search-engine query.
 *  - `plan`       — presenting a plan for review. NON-blocking (see
 *                   `isExecutionBlocking`): the agent may continue while the
 *                   plan is reviewed; it does not gate execution.
 */
export type ReviewKind =
  | "edit"
  | "delete"
  | "terminal"
  | "mcp"
  | "web_fetch"
  | "web_search"
  | "plan"

/** All review kinds enumerated — used by callers/tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_REVIEW_KINDS: ReadonlyArray<ReviewKind> = [
  "edit",
  "delete",
  "terminal",
  "mcp",
  "web_fetch",
  "web_search",
  "plan",
]

/**
 * Whether a pending review of this kind BLOCKS execution of the turn.
 *
 * Every kind blocks EXCEPT `"plan"`: presenting a plan is advisory — the
 * agent does not have to halt the turn to surface it (Cursor's PLAN gate is
 * explicitly non-blocking). Pure, exhaustive; a new kind added without an
 * explicit case is caught by the compiler via the `never` default.
 */
export const isExecutionBlocking = (kind: ReviewKind): boolean => {
  switch (kind) {
    case "edit":
    case "delete":
    case "terminal":
    case "mcp":
    case "web_fetch":
    case "web_search":
      return true
    case "plan":
      return false
    default: {
      const _exhaustive: never = kind
      throw new Error(`Unhandled ReviewKind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Typed reason code carried on a stop when a review is required. Closed
 * union, one per `ReviewKind`. Mirrors Cursor's `reason_code` strings (e.g.
 * `"shell.needs_approval"`); kept as literal strings so trajectory exports
 * can interoperate without translation.
 */
export type ReasonCode =
  | "edit.needs_approval"
  | "delete.needs_approval"
  | "terminal.needs_approval"
  | "mcp.needs_approval"
  | "web_fetch.needs_approval"
  | "web_search.needs_approval"
  | "plan.needs_approval"

/** All reason codes enumerated — exhaustive-coverage helper. */
export const ALL_REASON_CODES: ReadonlyArray<ReasonCode> = [
  "edit.needs_approval",
  "delete.needs_approval",
  "terminal.needs_approval",
  "mcp.needs_approval",
  "web_fetch.needs_approval",
  "web_search.needs_approval",
  "plan.needs_approval",
]

/** Map a `ReviewKind` to its typed `ReasonCode`. Pure, exhaustive. */
export const reasonCodeFor = (kind: ReviewKind): ReasonCode => {
  switch (kind) {
    case "edit":
      return "edit.needs_approval"
    case "delete":
      return "delete.needs_approval"
    case "terminal":
      return "terminal.needs_approval"
    case "mcp":
      return "mcp.needs_approval"
    case "web_fetch":
      return "web_fetch.needs_approval"
    case "web_search":
      return "web_search.needs_approval"
    case "plan":
      return "plan.needs_approval"
    default: {
      const _exhaustive: never = kind
      throw new Error(`Unhandled ReviewKind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * The per-gate decision a reviewer renders. Goes BEYOND allow/deny — this is
 * the Cursor approval-gate verb set:
 *
 *  - `run`                — proceed with this action once.
 *  - `skip`               — do not run this action; do NOT steer the model.
 *  - `allowlist_commands` — proceed AND remember the listed shell commands so
 *                           future structurally-equivalent terminal calls run
 *                           without prompting (scoped to `commands`).
 *  - `allowlist_tool`     — proceed AND remember a specific MCP `server`/`tool`
 *                           pair.
 *  - `allowlist_domain`   — proceed AND remember a web `domain`.
 *  - `reject_and_tell`    — reject the action AND feed `message` back to the
 *                           model as steering (Cursor's
 *                           REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY). The
 *                           caller is responsible for routing `message` into
 *                           the steering seam; this module only carries it.
 */
export type ReviewDecision =
  | { verb: "run" }
  | { verb: "skip" }
  | { verb: "allowlist_commands"; commands: string[] }
  | { verb: "allowlist_tool"; server: string; tool: string }
  | { verb: "allowlist_domain"; domain: string }
  | { verb: "reject_and_tell"; message: string }

/** All decision verbs enumerated — exhaustive-coverage helper. */
export type ReviewDecisionVerb = ReviewDecision["verb"]

export const ALL_REVIEW_DECISION_VERBS: ReadonlyArray<ReviewDecisionVerb> = [
  "run",
  "skip",
  "allowlist_commands",
  "allowlist_tool",
  "allowlist_domain",
  "reject_and_tell",
]

/** Typed stop descriptor for a kind that requires user approval. A future
 *  caller emits this to halt the turn with a machine-readable reason rather
 *  than a free-text string. Pure value — safe to log / serialize. */
export const stopCategoryFor = (
  kind: ReviewKind,
): { stopCategory: "needs_user_approval"; reasonCode: ReasonCode } => ({
  stopCategory: "needs_user_approval",
  reasonCode: reasonCodeFor(kind),
})

/**
 * Whether `decision` is a legal verb for `kind`.
 *
 * The universal verbs (`run`, `skip`, `reject_and_tell`) are legal for every
 * kind. The scoped-allowlist verbs are restricted to the kind whose state
 * they remember:
 *   - `allowlist_commands` ⇒ `terminal` only.
 *   - `allowlist_tool`     ⇒ `mcp` only.
 *   - `allowlist_domain`   ⇒ `web_fetch` / `web_search` only.
 *
 * Pure, exhaustive over the decision verb via a `never` default — a new verb
 * added to `ReviewDecision` without a case here fails to compile.
 */
export const isDecisionLegalFor = (kind: ReviewKind, decision: ReviewDecision): boolean => {
  switch (decision.verb) {
    case "run":
    case "skip":
    case "reject_and_tell":
      return true
    case "allowlist_commands":
      return kind === "terminal"
    case "allowlist_tool":
      return kind === "mcp"
    case "allowlist_domain":
      return kind === "web_fetch" || kind === "web_search"
    default: {
      const _exhaustive: never = decision
      throw new Error(`Unhandled ReviewDecision verb: ${String(_exhaustive)}`)
    }
  }
}
