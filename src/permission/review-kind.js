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
/** All review kinds enumerated — used by callers/tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_REVIEW_KINDS = [
    "edit",
    "delete",
    "terminal",
    "mcp",
    "web_fetch",
    "web_search",
    "plan",
];
/**
 * Whether a pending review of this kind BLOCKS execution of the turn.
 *
 * Every kind blocks EXCEPT `"plan"`: presenting a plan is advisory — the
 * agent does not have to halt the turn to surface it (Cursor's PLAN gate is
 * explicitly non-blocking). Pure, exhaustive; a new kind added without an
 * explicit case is caught by the compiler via the `never` default.
 */
export const isExecutionBlocking = (kind) => {
    switch (kind) {
        case "edit":
        case "delete":
        case "terminal":
        case "mcp":
        case "web_fetch":
        case "web_search":
            return true;
        case "plan":
            return false;
        default: {
            const _exhaustive = kind;
            throw new Error(`Unhandled ReviewKind: ${String(_exhaustive)}`);
        }
    }
};
/** All reason codes enumerated — exhaustive-coverage helper. */
export const ALL_REASON_CODES = [
    "edit.needs_approval",
    "delete.needs_approval",
    "terminal.needs_approval",
    "mcp.needs_approval",
    "web_fetch.needs_approval",
    "web_search.needs_approval",
    "plan.needs_approval",
];
/** Map a `ReviewKind` to its typed `ReasonCode`. Pure, exhaustive. */
export const reasonCodeFor = (kind) => {
    switch (kind) {
        case "edit":
            return "edit.needs_approval";
        case "delete":
            return "delete.needs_approval";
        case "terminal":
            return "terminal.needs_approval";
        case "mcp":
            return "mcp.needs_approval";
        case "web_fetch":
            return "web_fetch.needs_approval";
        case "web_search":
            return "web_search.needs_approval";
        case "plan":
            return "plan.needs_approval";
        default: {
            const _exhaustive = kind;
            throw new Error(`Unhandled ReviewKind: ${String(_exhaustive)}`);
        }
    }
};
export const ALL_REVIEW_DECISION_VERBS = [
    "run",
    "skip",
    "allowlist_commands",
    "allowlist_tool",
    "allowlist_domain",
    "reject_and_tell",
];
/** Typed stop descriptor for a kind that requires user approval. A future
 *  caller emits this to halt the turn with a machine-readable reason rather
 *  than a free-text string. Pure value — safe to log / serialize. */
export const stopCategoryFor = (kind) => ({
    stopCategory: "needs_user_approval",
    reasonCode: reasonCodeFor(kind),
});
/**
 * Infer the {@link ReviewKind} for an action from its tool name + read-only
 * flag. Pure heuristic — extracts the WHAT-IS-BEING-REVIEWED axis from the
 * shape of the call without consulting any port.
 *
 * Rules (closed, ordered):
 *   - `web_fetch` / `webFetch` / `fetch` / `http*` tool names ⇒ `web_fetch`.
 *   - `web_search` / `webSearch` / `search`-suffixed tool names ⇒ `web_search`.
 *   - tool name starts with `mcp__` (the project MCP namespace) ⇒ `mcp`.
 *   - `delete` / `rm` / `remove`-shaped names ⇒ `delete`.
 *   - extractShellCommand-bearing tools (or names matching `bash`/`shell`/
 *     `exec`/`run`/`terminal`) ⇒ `terminal`.
 *   - read-only tools that did not match above ⇒ `plan` (advisory, non-
 *     blocking — the closest "no execution" kind we have).
 *   - everything else ⇒ `edit` (the safest mutating default).
 *
 * The caller passes `isReadOnly` explicitly — we never call into the tool
 * registry from this pure module. Returns a deterministic kind; the gate
 * uses it to attach `reviewKind` to the `ReviewContext`.
 */
export const inferReviewKind = (tool, isReadOnly) => {
    const name = tool.toLowerCase();
    // MCP namespace is checked FIRST so an `mcp_search` (e.g. the project's MCP
    // skill-search) classifies as `mcp`, not `web_search` (which is the wider
    // bucket).
    if (name.startsWith("mcp__") || name.startsWith("mcp_"))
        return "mcp";
    if (name === "web_fetch" || name === "webfetch" || name === "fetch" || name.startsWith("http")) {
        return "web_fetch";
    }
    if (name === "web_search" || name === "websearch" || name.endsWith("_search")) {
        return "web_search";
    }
    if (name === "delete" || name === "rm" || name === "remove" || name.endsWith("_delete")) {
        return "delete";
    }
    if (name === "bash" ||
        name === "shell" ||
        name === "exec" ||
        name === "run" ||
        name === "terminal" ||
        name.endsWith("_exec") ||
        name.endsWith("_shell")) {
        return "terminal";
    }
    if (isReadOnly)
        return "plan";
    return "edit";
};
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
export const isDecisionLegalFor = (kind, decision) => {
    switch (decision.verb) {
        case "run":
        case "skip":
        case "reject_and_tell":
            return true;
        case "allowlist_commands":
            return kind === "terminal";
        case "allowlist_tool":
            return kind === "mcp";
        case "allowlist_domain":
            return kind === "web_fetch" || kind === "web_search";
        default: {
            const _exhaustive = decision;
            throw new Error(`Unhandled ReviewDecision verb: ${String(_exhaustive)}`);
        }
    }
};
