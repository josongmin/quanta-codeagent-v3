import { CLASSIFIER_SYSTEM_PROMPT } from "./classifier";
import { hostAllowsMutation } from "./per-host-mode";
import { threadAllowsMutation } from "./per-thread-store";
import { HARD_DENY, HARD_DENY_RULES } from "./policy-rules";
/** Exposed for the rule-level unit test (positive + negative case enforcement,
 *  unique-name check). NOT intended for production callers — use
 *  `hardDenyReason()` for the projected check. */
export { HARD_DENY_RULES };
/** Last-resort extraction for actions whose dispatcher did NOT populate
 *  `shellCommand` (legacy callers / tests). Modern call sites populate the
 *  field via `ToolRegistry.extractShellCommand`. This back-compat probe ONLY
 *  triggers for `bash` so it cannot widen the gate; new shell tools must use
 *  the typed registry-populated path. */
const legacyBashCommand = (action) => {
    if (action.tool !== "bash")
        return null;
    const input = action.input;
    if (input === null || typeof input !== "object" || !("command" in input))
        return null;
    const c = input.command;
    return typeof c === "string" ? c : null;
};
/** Returns the HARD_DENY reason string for any shell-equivalent action, or
 *  null if no pattern matches. Path-independent dangerous patterns always win
 *  first, before mode. HARD_DENY hits ARE the `hand-off-required` tier —
 *  they cross a security boundary that no agent mode can authorize.
 *
 *  S16 — STRUCTURAL CHANGE: this previously gated on `action.tool === "bash"`,
 *  which meant any sibling shell tool (a future `shell`/`exec`/MCP `run`, a
 *  typo'd `Bash`) silently sidestepped the entire dangerous-command denylist.
 *  Now the gate fires on EVERY action whose `shellCommand` is set — populated
 *  by the dispatch seam from `ToolRegistry.extractShellCommand` which in turn
 *  reads each tool's own `extractShellCommand` method. Tools that don't
 *  represent shell commands leave `shellCommand` unset and skip the gate. */
export const hardDenyReason = (action) => {
    const cmd = typeof action.shellCommand === "string" ? action.shellCommand : legacyBashCommand(action);
    if (cmd === null || cmd.length === 0)
        return null;
    for (const pat of HARD_DENY) {
        if (pat.test(cmd))
            return `Blocked dangerous command: ${cmd}`;
    }
    return null;
};
const hardDeny = (action) => {
    const reason = hardDenyReason(action);
    return reason ? { kind: "deny", reason } : null;
};
/** Infer the effective HITL tier for a call. The tool's own `hitlTier(input)`
 *  wins; otherwise read-only ⇒ "none", mutating ⇒ "always-confirm" (FAIL-
 *  CLOSED — see module comment). The dispatch seam composes this with the
 *  HARD_DENY check (which overrides to "hand-off-required") to obtain the
 *  final routing tier. */
export const inferToolTier = (tool, input) => {
    const explicit = tool.hitlTier?.(input);
    if (explicit)
        return explicit;
    return tool.isReadOnly() ? "none" : "always-confirm";
};
/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`.
 *
 *  "auto" mode is async (needs the injected classifier) — this synchronous
 *  entrypoint cannot await it, so it degrades "auto" safely to "ask" after
 *  applying the read-only allow and the HARD_DENY guard. The main thread
 *  should call `evaluateAuto()` instead when it can drive the classifier. */
export const evaluate = (action, ctx) => {
    // HARD_DENY ALWAYS wins — checked BEFORE the read-only fast-path so a tool
    // mislabeled `isReadOnly:true` that nonetheless carries a shell-equivalent
    // `shellCommand` (registry bug / spoofed action) can never sidestep the
    // denylist. `hardDeny` only fires when a shell command is present, so a
    // genuine read-only tool (no `shellCommand`) still falls straight through
    // to the allow below. This mirrors `evaluateStack`'s ordering (precedence
    // level 1) and the documented "HARD_DENY beats everything" invariant.
    const denied = hardDeny(action);
    if (denied)
        return denied;
    if (action.isReadOnly)
        return { kind: "allow" };
    if (ctx.mode === "bypass" || ctx.mode === "acceptEdits")
        return { kind: "allow" };
    if (ctx.mode === "auto") {
        return {
            kind: "ask",
            reason: "auto mode requires the async classifier (use evaluateAuto)",
        };
    }
    return { kind: "ask", reason: `${action.tool} modifies state` };
};
/**
 * Async permission evaluation for "auto" mode. Ordering (permission-system.md
 * §3.5): read-only → allow; HARD_DENY still wins first; otherwise consult the
 * injected classifier via the stateful AutoModeClassifier. A `fallback`
 * verdict from the classifier (denial-limit exceeded, circuit-broken, or
 * classifier absent) surfaces as a hard "ask".
 *
 * Behavior-preserving for the 3 existing modes: anything that is not "auto"
 * delegates verbatim to the synchronous `evaluate()`.
 */
export const evaluateAuto = async (action, ctx, classifier) => {
    if (ctx.mode !== "auto")
        return evaluate(action, ctx);
    // HARD_DENY beats the classifier AND the read-only fast-path — it crosses a
    // security boundary and no user/model context (nor a possibly-spoofed
    // `isReadOnly:true` on a shell-bearing action) authorizes it. Checked first
    // so it matches `evaluate`/`evaluateStack` precedence level 1. `hardDeny`
    // is a no-op when no `shellCommand` is present, so genuine read-only tools
    // still allow below.
    const denied = hardDeny(action);
    if (denied)
        return denied;
    if (action.isReadOnly)
        return { kind: "allow" };
    const decision = await classifier.evaluate({
        tool: action.tool,
        input: action.input,
        systemPrompt: ctx.classify
            ? // The injected port owns the real system prompt; pass the canonical
                // taxonomy so a mock/echo port still sees the canonical wording.
                CLASSIFIER_SYSTEM_PROMPT
            : "",
    });
    if (decision.fallback)
        return { kind: "ask", reason: decision.reason };
    if (decision.verdict === "allow")
        return { kind: "allow" };
    if (decision.verdict === "deny")
        return { kind: "deny", reason: decision.reason };
    return { kind: "ask", reason: decision.reason };
};
/** Synchronous precedence-aware permission resolver. Returns the same
 *  `PermissionDecision` shape as `evaluate()` so call sites that wrap it
 *  remain interchangeable.
 *
 *  See module comment for the precedence table. */
export const evaluateStack = (action, ctx, stack, opts) => {
    // HARD_DENY ALWAYS wins — even read-only actions can't reach a shell-
    // equivalent path that hits the denylist (defensive: `isReadOnly=true`
    // for a shell tool would be a registry bug, but the gate fires anyway).
    const denied = hardDeny(action);
    if (denied)
        return denied;
    if (action.isReadOnly)
        return { kind: "allow" };
    const store = opts.store;
    // 2. Post-denial user override — explicit re-approval after seeing risk
    //    overrides any rule below. The store enforces the timestamp ordering
    //    invariant (deniedAt ≤ seenRiskAt ≤ userOverrideAt).
    if (store.hasPostDenialOverride(stack.threadId, stack.actionSignature)) {
        return { kind: "allow" };
    }
    // 3. Per-thread permission record (highest among rule-based axes).
    const threadPerm = store.getThread(stack.threadId);
    if (threadPerm !== undefined) {
        const writable = threadAllowsMutation(threadPerm, stack.workdir);
        if (writable)
            return { kind: "allow" };
        return {
            kind: "deny",
            reason: `Per-thread policy (${threadPerm.sandboxPolicy.type}) refuses ${action.tool} on ${stack.workdir}`,
        };
    }
    // 4. Per-host agent-mode default.
    const hostMode = store.getHost(stack.hostId);
    const hostVerdict = hostAllowsMutation(hostMode);
    if (hostVerdict === false) {
        return {
            kind: "deny",
            reason: `Per-host mode (${hostMode}) refuses ${action.tool} on host ${stack.hostId}`,
        };
    }
    if (hostVerdict === true) {
        return { kind: "allow" };
    }
    // 5. Fall through to the global default (mode-based evaluate).
    return evaluate(action, ctx);
};
