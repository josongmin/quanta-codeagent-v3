/**
 * Control-request runtime surface (ADR-0496).
 *
 * A SINGLE typed channel for mid-session runtime control of a LIVE agent. Claude
 * Code exposes a rich control-request protocol (set_model / set_permission_mode /
 * set_max_thinking_tokens / get_context_usage / interrupt / rewind / …); quanta
 * had the interrupt/cancel/set_mode/set_brief members scattered across
 * {@link ../submission} (`SubmissionOp`) and {@link ../conversation-action}
 * (`ConversationAction`) but NO unified surface for the model/permission/thinking/
 * usage controls. This slice adds the NET-NEW controls as one closed union with a
 * PURE planner; the ADR documents folding the existing ops in behind this surface.
 *
 * Design (mirrors `SubmissionOp`): a typed envelope + an exhaustive kind array +
 * a pure planner that maps each request to a typed {@link ControlEffect}. The
 * planner invents NO vocabulary — model ids, permission modes, and thinking
 * levels are validated against caller-supplied allowlists, so the composition
 * root passes the REAL sets (`@/permission` modes, the LLM model allowlist, the
 * thinking-level enum). Fail-closed: an off-allowlist / malformed request ⇒ a
 * typed `rejected` effect. NO-THROW: a garbage request never escapes the planner.
 *
 * DEFAULT-OFF: {@link isControlRequestEnabled} (`QUANTA_CONTROL_REQUEST`, via the
 * @/shared gate SSOT) governs whether a host wires {@link ControlRequestPort} and
 * polls it; unset ⇒ no surface, byte-identical. The live-loop poll site is the
 * documented follow-up wire (same posture as `SubmissionOp.set_mode` today).
 */
import { gateOn } from "@/shared"

/** Net-new runtime controls. interrupt/cancel/set_mode/set_brief already live in
 *  `SubmissionOp`; the ADR documents subsuming them under this surface. */
export type ControlRequest =
  | { readonly kind: "set_model"; readonly model: string }
  | { readonly kind: "set_permission_mode"; readonly mode: string }
  | { readonly kind: "set_thinking"; readonly level: string }
  | { readonly kind: "get_context_usage" }

/** Closed enumeration of {@link ControlRequest} kinds. Extending the union MUST
 *  extend this array — the hellgate exhaustive-coverage assertion fails CI
 *  otherwise (mirrors `ALL_SUBMISSION_OP_KINDS`). Frozen against mutation. */
export const ALL_CONTROL_REQUEST_KINDS = Object.freeze([
  "set_model",
  "set_permission_mode",
  "set_thinking",
  "get_context_usage",
] as const satisfies readonly ControlRequest["kind"][])

/** Minimal context-usage snapshot the host supplies for `get_context_usage`. */
export interface ContextUsageSnapshot {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly contextWindow?: number
  /** Fraction [0,1] of the context window in use, when the host computes it. */
  readonly utilization?: number
}

/** Typed result of planning a {@link ControlRequest}. The loop applies it. */
export type ControlEffect =
  | { readonly kind: "model-set"; readonly model: string }
  | { readonly kind: "permission-mode-set"; readonly mode: string }
  | { readonly kind: "thinking-set"; readonly level: string }
  | { readonly kind: "usage"; readonly usage: ContextUsageSnapshot }
  | { readonly kind: "rejected"; readonly reason: string }

/** Allowlists + usage snapshot the host supplies. An ABSENT allowlist means the
 *  host opted out of gating that axis (the value is accepted as-is). */
export interface ControlRequestContext {
  readonly modelAllowlist?: readonly string[]
  readonly permissionModes?: readonly string[]
  readonly thinkingLevels?: readonly string[]
  readonly usage?: ContextUsageSnapshot | undefined
}

/** Env gate name (single SSOT). */
export const CONTROL_REQUEST_FLAG = "QUANTA_CONTROL_REQUEST"

/** Default-OFF opt-in check via the @/shared gate SSOT. */
export const isControlRequestEnabled = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, CONTROL_REQUEST_FLAG)

const reject = (reason: string): ControlEffect => ({ kind: "rejected", reason })

/** Validate a string value against an optional allowlist. An ABSENT allowlist
 *  means the host opted out of gating that axis. Returns the value or a reason. */
const checkAllowed = (
  value: unknown,
  allowlist: readonly string[] | undefined,
  label: string,
): { readonly value: string } | { readonly reason: string } => {
  if (typeof value !== "string" || value.length === 0) return { reason: `empty ${label}` }
  if (allowlist !== undefined && !allowlist.includes(value)) {
    return { reason: `${label} "${value}" not recognized` }
  }
  return { value }
}

/**
 * Pure planner. Validates a {@link ControlRequest} against the caller's
 * allowlists and returns a typed {@link ControlEffect}. NO-THROW: any malformed
 * input collapses to `rejected`.
 */
export const planControlRequest = (
  req: ControlRequest,
  ctx: ControlRequestContext,
): ControlEffect => {
  if (
    req === null ||
    typeof req !== "object" ||
    typeof (req as { kind?: unknown }).kind !== "string"
  ) {
    return reject("malformed control request")
  }
  switch (req.kind) {
    case "set_model": {
      const r = checkAllowed(req.model, ctx.modelAllowlist, "model")
      return "value" in r ? { kind: "model-set", model: r.value } : reject(r.reason)
    }
    case "set_permission_mode": {
      // SECURITY (ADR-0496): permission mode is a PRIVILEGE BOUNDARY (a mode like
      // "bypassPermissions"/"acceptEdits" can disarm the gate). Unlike model /
      // thinking — where an absent allowlist means "host opted out, accept as-is"
      // — the permission axis MUST fail CLOSED on an absent allowlist: never
      // silently accept a model-issued mode without an explicit allowlist.
      if (ctx.permissionModes === undefined) {
        return reject("permission mode changes require an explicit allowlist")
      }
      const r = checkAllowed(req.mode, ctx.permissionModes, "permission mode")
      return "value" in r ? { kind: "permission-mode-set", mode: r.value } : reject(r.reason)
    }
    case "set_thinking": {
      const r = checkAllowed(req.level, ctx.thinkingLevels, "thinking level")
      return "value" in r ? { kind: "thinking-set", level: r.value } : reject(r.reason)
    }
    case "get_context_usage":
      // Defensive SHALLOW COPY: never hand the host's own snapshot object back —
      // a consumer mutating the returned `usage` would corrupt host state (the
      // host typically reuses one snapshot across turns). The snapshot is flat
      // number fields, so a spread is a sufficient (and total) copy.
      return ctx.usage === undefined
        ? reject("context usage unavailable")
        : { kind: "usage", usage: { ...ctx.usage } }
    default:
      // Unknown kind (forward-compat / garbage). Fail-closed, no throw.
      return reject(`unknown control request kind: ${String((req as { kind?: unknown }).kind)}`)
  }
}

/** Host-injected control channel (shape only; the live-loop poll is the follow-up
 *  wire). `next()` returns the next pending request or null. NO-THROW. */
export interface ControlRequestPort {
  next(): ControlRequest | null
}
