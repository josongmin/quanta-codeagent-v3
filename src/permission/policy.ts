import { type AutoModeClassifier, CLASSIFIER_SYSTEM_PROMPT } from "./classifier"
import { hostAllowsMutation } from "./per-host-mode"
import { threadAllowsMutation } from "./per-thread-store"
import type { PermissionReader } from "./permission-store"
import { getDefaultPermissionStore } from "./permission-store"
import { HARD_DENY, HARD_DENY_RULES, type HardDenyRule } from "./policy-rules"
import type { HITLTier, PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Exposed for the rule-level unit test (positive + negative case enforcement,
 *  unique-name check). NOT intended for production callers — use
 *  `hardDenyReason()` for the projected check. */
export { HARD_DENY_RULES, type HardDenyRule }

/** Last-resort extraction for actions whose dispatcher did NOT populate
 *  `shellCommand` (legacy callers / tests). Modern call sites populate the
 *  field via `ToolRegistry.extractShellCommand`. This back-compat probe ONLY
 *  triggers for `bash` so it cannot widen the gate; new shell tools must use
 *  the typed registry-populated path. */
const legacyBashCommand = (action: ToolAction): string | null => {
  if (action.tool !== "bash") return null
  const input = action.input
  if (input === null || typeof input !== "object" || !("command" in input)) return null
  const c = (input as { command: unknown }).command
  return typeof c === "string" ? c : null
}

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
export const hardDenyReason = (action: ToolAction): string | null => {
  const cmd =
    typeof action.shellCommand === "string" ? action.shellCommand : legacyBashCommand(action)
  if (cmd === null || cmd.length === 0) return null
  for (const pat of HARD_DENY) {
    if (pat.test(cmd)) return `Blocked dangerous command: ${cmd}`
  }
  return null
}

const hardDeny = (action: ToolAction): PermissionDecision | null => {
  const reason = hardDenyReason(action)
  return reason ? { kind: "deny", reason } : null
}

/* ------------------------------------------------------------------------- *
 * Codex HITL 4-tier (hitl-audit.md) — tier inference.
 *
 * Precedence: `tool.hitlTier(input)` explicit value wins (e.g. `bash`'s
 * network-egress + mutating-git classifier returning `always-confirm`).
 * Absent ⇒ FAIL-CLOSED fallback:
 *   - read-only tool                    ⇒ "none" (reversible, harmless)
 *   - mutating tool with NO hitlTier()  ⇒ "always-confirm" (NOT
 *     "pre-approval-ok")
 *
 * Rationale (security audit Round 3): a future high-blast-radius tool —
 * `email_send`, `payment_authorize`, `slack_dm` — that forgets to implement
 * `hitlTier()` would silently drop into a tier batch-approved by
 * `acceptEdits`/`bypass` mode. Secure-by-default reverses the burden: the
 * registry MUST explicitly opt a mutating tool into `pre-approval-ok`
 * before it can ride loose. Existing default tools (`write`/`edit`/
 * `test_runner`/`scripted_replace`) declare `hitlTier(): "pre-approval-ok"`
 * explicitly to preserve their current behavior; an audit catches a missing
 * declaration on a new tool as soon as a user invokes it under `bypass`.
 *
 * `@/permission` stays leaf: the helper duck-reads the `hitlTier` method off
 * a thin interface (no `@/tool` import).
 * ------------------------------------------------------------------------- */

interface HITLToolDuck {
  isReadOnly(): boolean
  hitlTier?(input: unknown): HITLTier
}

/** Infer the effective HITL tier for a call. The tool's own `hitlTier(input)`
 *  wins; otherwise read-only ⇒ "none", mutating ⇒ "always-confirm" (FAIL-
 *  CLOSED — see module comment). The dispatch seam composes this with the
 *  HARD_DENY check (which overrides to "hand-off-required") to obtain the
 *  final routing tier. */
export const inferToolTier = (tool: HITLToolDuck, input: unknown): HITLTier => {
  const explicit = tool.hitlTier?.(input)
  if (explicit) return explicit
  return tool.isReadOnly() ? "none" : "always-confirm"
}

/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`.
 *
 *  "auto" mode is async (needs the injected classifier) — this synchronous
 *  entrypoint cannot await it, so it degrades "auto" safely to "ask" after
 *  applying the read-only allow and the HARD_DENY guard. The main thread
 *  should call `evaluateAuto()` instead when it can drive the classifier. */
export const evaluate = (action: ToolAction, ctx: PermissionContext): PermissionDecision => {
  if (action.isReadOnly) return { kind: "allow" }

  const denied = hardDeny(action)
  if (denied) return denied

  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") return { kind: "allow" }
  if (ctx.mode === "auto") {
    return {
      kind: "ask",
      reason: "auto mode requires the async classifier (use evaluateAuto)",
    }
  }
  return { kind: "ask", reason: `${action.tool} modifies state` }
}

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
export const evaluateAuto = async (
  action: ToolAction,
  ctx: PermissionContext,
  classifier: AutoModeClassifier,
): Promise<PermissionDecision> => {
  if (ctx.mode !== "auto") return evaluate(action, ctx)

  if (action.isReadOnly) return { kind: "allow" }

  // HARD_DENY beats the classifier — it crosses a security boundary and no
  // user/model context authorizes it.
  const denied = hardDeny(action)
  if (denied) return denied

  const decision = await classifier.evaluate({
    tool: action.tool,
    input: action.input,
    systemPrompt: ctx.classify
      ? // The injected port owns the real system prompt; pass the canonical
        // taxonomy so a mock/echo port still sees the canonical wording.
        CLASSIFIER_SYSTEM_PROMPT
      : "",
  })

  if (decision.fallback) return { kind: "ask", reason: decision.reason }
  if (decision.verdict === "allow") return { kind: "allow" }
  if (decision.verdict === "deny") return { kind: "deny", reason: decision.reason }
  return { kind: "ask", reason: decision.reason }
}

/* ------------------------------------------------------------------------- *
 * ADR-0046 — Permission stack (per-thread + per-host + post-denial).
 *
 * `evaluateStack` extends the base policy with three Codex-inspired axes
 * stacked on top of HARD_DENY:
 *
 *  precedence (highest to lowest):
 *    1. HARD_DENY                  — security boundary; nothing overrides.
 *    2. post-denial user override  — `(threadId, actionSignature)` has a
 *                                    complete `denied → seenRisk → override`
 *                                    sequence ⇒ allow.
 *    3. per-thread permission      — `threadId` has an explicit record ⇒
 *                                    use its sandboxPolicy to allow/deny.
 *    4. per-host agent mode        — `hostId` has an explicit record ⇒
 *                                    `read-only`/`full-access` decides.
 *    5. global default             — fall through to `evaluate(action, ctx)`.
 *
 * read-only actions still bypass everything except HARD_DENY (consistent
 * with the base `evaluate`). The function is SYNCHRONOUS — the same
 * "auto mode degrades to ask" contract as `evaluate`. Callers needing the
 * classifier path should compose `evaluateAuto` themselves.
 *
 * Pure with respect to global state: the store is the singleton by default,
 * but tests can inject a per-test instance via `opts.store`.
 * ------------------------------------------------------------------------- */

export interface PermissionStackContext {
  /** Thread id — anchors per-thread + post-denial precedence. */
  threadId: string
  /** Host id — anchors per-host mode. Use `resolveHostId()` from
   *  `per-host-mode.ts` when uncertain. */
  hostId: string
  /** Canonical action signature for the post-denial axis. Caller computes
   *  via `computeActionSignature({tool, workdir, args})`. */
  actionSignature: string
  /** Workdir — feeds `threadAllowsMutation`'s writable-root check. */
  workdir: string
}

export interface EvaluateStackOptions {
  /** Override the store (test isolation). Defaults to the process singleton.
   *  Narrowed to {@link PermissionReader} — `evaluateStack` only reads
   *  (ISP, refactor #3); the concrete `PermissionStore` still satisfies it. */
  store?: PermissionReader
}

/** Synchronous precedence-aware permission resolver. Returns the same
 *  `PermissionDecision` shape as `evaluate()` so call sites that wrap it
 *  remain interchangeable.
 *
 *  See module comment for the precedence table. */
export const evaluateStack = (
  action: ToolAction,
  ctx: PermissionContext,
  stack: PermissionStackContext,
  opts: EvaluateStackOptions = {},
): PermissionDecision => {
  // HARD_DENY ALWAYS wins — even read-only actions can't reach a shell-
  // equivalent path that hits the denylist (defensive: `isReadOnly=true`
  // for a shell tool would be a registry bug, but the gate fires anyway).
  const denied = hardDeny(action)
  if (denied) return denied

  if (action.isReadOnly) return { kind: "allow" }

  const store = opts.store ?? getDefaultPermissionStore()

  // 2. Post-denial user override — explicit re-approval after seeing risk
  //    overrides any rule below. The store enforces the timestamp ordering
  //    invariant (deniedAt ≤ seenRiskAt ≤ userOverrideAt).
  if (store.hasPostDenialOverride(stack.threadId, stack.actionSignature)) {
    return { kind: "allow" }
  }

  // 3. Per-thread permission record (highest among rule-based axes).
  const threadPerm = store.getThread(stack.threadId)
  if (threadPerm !== undefined) {
    const writable = threadAllowsMutation(threadPerm, stack.workdir)
    if (writable) return { kind: "allow" }
    return {
      kind: "deny",
      reason: `Per-thread policy (${threadPerm.sandboxPolicy.type}) refuses ${action.tool} on ${stack.workdir}`,
    }
  }

  // 4. Per-host agent-mode default.
  const hostMode = store.getHost(stack.hostId)
  const hostVerdict = hostAllowsMutation(hostMode)
  if (hostVerdict === false) {
    return {
      kind: "deny",
      reason: `Per-host mode (${hostMode}) refuses ${action.tool} on host ${stack.hostId}`,
    }
  }
  if (hostVerdict === true) {
    return { kind: "allow" }
  }

  // 5. Fall through to the global default (mode-based evaluate).
  return evaluate(action, ctx)
}
