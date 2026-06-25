/**
 * CommandHookRunner — execute disk-configured shell command hooks (ADR-0454).
 *
 * On a {@link HookEvent}, select the matching armed bindings, run each ONE-SHOT
 * through the injected {@link CommandHookExecPort} (the production adapter wraps
 * `LocalSandbox`'s env-scrub + timeout + output-cap; see sandbox-exec.ts),
 * passing the event payload as JSON on the child's stdin, and fold the
 * command's exit code / stdout into a single {@link CommandHookVerdict}.
 *
 * SECURITY funnel (all enforced HERE, in order):
 *   1. gate.armed — opt-in + acknowledgement + ≥1 binding (else NO spawn);
 *   2. event maps to a quanta event AND a binding matches it;
 *   3. permission port says yes for the event/tool (else NO spawn);
 *   4. ONLY THEN exec — the user command verbatim as argv, payload as stdin.
 *
 * INJECTION-SAFETY — the payload is NEVER concatenated into the command. It is
 * serialized to JSON and handed to {@link CommandHookExecOpts.stdinJson}; the
 * command travels through {@link CommandHookExecOpts.command} untouched.
 *
 * DETERMINISM — multiple matching commands run sequentially in binding order;
 * the FIRST deny wins (mirrors HookBus deny semantics); the LAST updatedInput
 * wins (rewrites compose). The runner reads NO wall-clock and spawns NO process
 * directly — all timing + spawning lives behind the injected exec port.
 */

import { matchTool } from "../tool-matchers"
import { mapClaudeEvent } from "./gate"
import type {
  CommandHookBinding,
  CommandHookDeps,
  CommandHookGate,
  CommandHookReviewPort,
  CommandHookVerdict,
} from "./types"

/** The minimal event shape the runner needs: a quanta event type, an optional
 *  tool name (for matcher gating), and the full payload to serialize as stdin.
 *  Decoupled from the HookBus `HookEvent` union so the runner does not import
 *  the bus (the bus integration adapts a `HookEvent` into this at the call
 *  site — see `installCommandHooks`). */
export interface CommandHookEvent {
  /** quanta event type (e.g. `pre_tool_use`). */
  readonly type: string
  /** Tool name for tool-shaped events; undefined for non-tool events. */
  readonly toolName?: string
  /** The full event payload, serialized to JSON for the child's stdin. */
  readonly payload: unknown
}

const NEUTRAL: CommandHookVerdict = { deny: null, timedOut: false }

/** Compile a Claude matcher string into a predicate. Empty / `"*"` ⇒ match
 *  all. Otherwise treated as an ANCHORED regex (Claude semantics: `"Edit|Write"`
 *  matches either). A malformed regex falls back to exact-string match (never
 *  throws — a bad matcher must not poison the chain). */
const matcherPredicate = (matcher: string | undefined): ((name: string) => boolean) => {
  if (matcher === undefined || matcher === "" || matcher === "*") return () => true
  let re: RegExp | undefined
  try {
    re = new RegExp(`^(?:${matcher})$`)
  } catch {
    re = undefined
  }
  if (re === undefined) {
    return (name) => matchTool(matcher, name)
  }
  return (name) => re.test(name)
}

/** SECURITY (fail-closed by provenance) — filter `matching` down to the
 *  bindings allowed to fire. ALWAYS applied (NOT gated on the `trustGate`
 *  opt-in): the `needsReview` stamp is set by trusted code from the binding's
 *  provenance (repo/imported ⇒ untrusted ⇒ review-gated), so honoring it is the
 *  security boundary, not a feature toggle.
 *
 *  - A binding NOT flagged `needsReview` (user/managed/legacy-un-provenanced,
 *    i.e. trusted) ALWAYS passes — legit hooks are never broken.
 *  - A `needsReview` binding passes ONLY if the review port explicitly approves
 *    it; with NO review port it is HELD (deny-on-doubt — an untrusted repo hook
 *    never fires un-reviewed).
 *  - A throwing review port is treated as "not approved" (never spawns on
 *    error). */
const selectApproved = async (
  matching: readonly CommandHookBinding[],
  review: CommandHookReviewPort | undefined,
): Promise<CommandHookBinding[]> => {
  const out: CommandHookBinding[] = []
  for (const b of matching) {
    if (b.needsReview !== true) {
      out.push(b)
      continue
    }
    if (review === undefined) continue
    let approved = false
    try {
      approved = await review.isApproved(b)
    } catch {
      approved = false
    }
    if (approved) out.push(b)
  }
  return out
}

/** True iff this binding applies to this event. Non-tool events ignore the
 *  matcher (no tool name to match against). */
const bindingMatches = (binding: CommandHookBinding, event: CommandHookEvent): boolean => {
  if (mapClaudeEvent(binding.event) !== event.type) return false
  if (event.toolName === undefined) return true
  return matcherPredicate(binding.matcher)(event.toolName)
}

/** Interpret one command's exec result as a verdict.
 *
 *  - timedOut ⇒ DENY (fail-closed: an unbounded hook must not pass the tool);
 *  - exit ≠ 0 ⇒ DENY with the reason taken from stdout JSON `{deny}` /
 *    `{reason}` if present, else a generic "exit N" message (Claude Code: a
 *    non-zero PreToolUse hook blocks the call);
 *  - exit === 0 with stdout JSON `{decision:"block"}` / `{deny}` ⇒ DENY
 *    (a hook can block via structured output even on a 0 exit);
 *  - exit === 0 with stdout JSON `{updatedInput}` ⇒ rewrite (presence-of-key);
 *  - otherwise ⇒ neutral (observer). */
const interpret = (
  result: { stdout: string; exitCode: number; timedOut: boolean },
  command: string,
): CommandHookVerdict => {
  if (result.timedOut) {
    return { deny: { reason: `command hook timed out: ${command}` }, timedOut: true }
  }
  const json = tryParseJson(result.stdout)
  if (result.exitCode !== 0) {
    const reason = denyReasonFrom(json) ?? `command hook exited ${result.exitCode}: ${command}`
    return { deny: { reason }, timedOut: false }
  }
  // exit 0 — structured output can still block or rewrite.
  const blockReason = denyReasonFrom(json)
  if (blockReason !== null) return { deny: { reason: blockReason }, timedOut: false }
  if (json !== undefined && typeof json === "object" && json !== null && "updatedInput" in json) {
    return {
      deny: null,
      updatedInput: (json as { updatedInput: unknown }).updatedInput,
      timedOut: false,
    }
  }
  return NEUTRAL
}

const tryParseJson = (text: string): unknown | undefined => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Extract a deny reason from structured stdout JSON. Recognizes the Claude
 *  Code `{decision:"block", reason}` shape AND a plain `{deny:"reason"}` /
 *  `{deny:true, reason}`. Returns null when the JSON does not vote to block. */
const denyReasonFrom = (json: unknown): string | null => {
  if (typeof json !== "object" || json === null) return null
  const o = json as Record<string, unknown>
  if (o.decision === "block") {
    return typeof o.reason === "string" && o.reason.length > 0
      ? o.reason
      : "blocked by command hook"
  }
  if (typeof o.deny === "string" && o.deny.length > 0) return o.deny
  if (o.deny === true) {
    return typeof o.reason === "string" && o.reason.length > 0 ? o.reason : "denied by command hook"
  }
  return null
}

/**
 * Run every armed, matching, permitted command hook for `event` and fold the
 * results into ONE verdict. Returns {@link NEUTRAL} (no spawn) when the gate is
 * not armed, no binding matches, or the permission port refuses.
 */
export const runCommandHooks = async (
  gate: CommandHookGate,
  deps: CommandHookDeps,
  event: CommandHookEvent,
): Promise<CommandHookVerdict> => {
  if (!gate.armed) return NEUTRAL

  const matching = gate.bindings.filter((b) => bindingMatches(b, event))
  if (matching.length === 0) return NEUTRAL

  // SECURITY — fail-closed BY PROVENANCE. A binding flagged `needsReview`
  // (imported / repo-shipped / untrusted-source provenance) must NOT spawn until
  // it has been explicitly approved — ALWAYS, regardless of the `trustGate`
  // opt-in knob. The RCE surface is the COMMAND EXEC, so an untrusted hook that
  // could run un-approved by default is the hole; deny-on-doubt closes it. A
  // HELD binding does NOT deny the tool — it is simply not active yet.
  //
  // The `gate.trustGate` knob now controls ONLY whether an interactive approval
  // PORT / UX is offered (wired by the composition root) — NEVER whether an
  // untrusted-source hook may fire. A user/trusted-provenance binding
  // (needsReview:false / absent) always fires; `selectApproved` enforces exactly
  // that split. Fail-closed: no review port ⇒ a review-gated binding is treated
  // as NOT approved (never silently fires).
  const runnable = await selectApproved(matching, deps.review)
  if (runnable.length === 0) return NEUTRAL

  // Permission guard — a command hook is privileged. Consulted ONCE per event
  // (the bindings for one event share the same approve/deny decision).
  const permitted = await deps.permission.isAllowed({
    event: event.type,
    ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
  })
  if (!permitted) {
    return { deny: { reason: `command hooks not permitted for ${event.type}` }, timedOut: false }
  }

  // Serialize the payload ONCE. The Claude Code contract: the hook reads its
  // input as JSON on stdin. The payload is data, not code — it is NEVER part of
  // the command string.
  const stdinJson = serializePayload(event)

  let deny: { reason: string } | null = null
  let updatedInput: unknown
  let mutated = false
  let anyTimedOut = false

  for (const binding of runnable) {
    const result = await deps.exec.exec({
      command: binding.command,
      stdinJson,
      envAllowlist: gate.envAllowlist,
      timeoutMs: gate.timeoutMs,
      maxOutputBytes: gate.maxOutputBytes,
      cwd: deps.cwd,
    })
    const verdict = interpret(result, binding.command)
    if (verdict.timedOut) anyTimedOut = true
    if (deny === null && verdict.deny !== null) deny = verdict.deny
    if ("updatedInput" in verdict) {
      updatedInput = verdict.updatedInput
      mutated = true
    }
    // First deny wins for the deny channel, but later observers/rewriters still
    // run (mirrors HookBus: deny stops further deny consideration, not the
    // chain). A timed-out command already recorded its deny.
  }

  const out: CommandHookVerdict = { deny, timedOut: anyTimedOut }
  if (mutated) return { ...out, updatedInput }
  return out
}

/** Serialize the event into the Claude Code stdin shape. We include the quanta
 *  event type + (optional) tool name + the raw payload so a hook script can
 *  branch on `hook_event_name` like Claude Code does. */
const serializePayload = (event: CommandHookEvent): string => {
  const envelope = {
    hook_event_name: event.type,
    ...(event.toolName !== undefined ? { tool_name: event.toolName } : {}),
    payload: event.payload,
  }
  try {
    return JSON.stringify(envelope)
  } catch {
    // Circular / non-serializable payload — send a minimal safe envelope so the
    // command still runs and observes the event type (never throw).
    return JSON.stringify({ hook_event_name: event.type, payload: null })
  }
}
