/**
 * Thread-follower co-control protocol (T02 — absorbed from Codex IDE's
 * app-server follower verbs). PURE + DEFAULT-OFF.
 *
 * A FOLLOWER is an auxiliary client (a second window, a web/ide surface) that
 * co-controls ONE live thread that some primary client already drives. Codex IDE
 * exposes a verb set every follower may issue against the live thread:
 * `steer-turn`, `interrupt-turn`, `command-approval-decision`, … — each a
 * request/response/**timeout** triple.
 *
 * quanta already owns the lease-safe MECHANICS the follower verbs ride on:
 *   - steer  → the §steer / `ConversationAction.user_message` INJECT path
 *              (`@/agent/conversation-action`): the lease holder's running turn
 *              sees the text on its next step — NOT a second writer.
 *   - interrupt → the `cancel` action / `turn.cancel` command, the ONE command
 *              that bypasses the single-writer lease (`scheduler.ts` fast-path).
 *   - approval relay → the `approval.respond` session command.
 *
 * What was MISSING is the follower PROTOCOL on top: (a) a typed verb→effect
 * planner that converts a follower verb into one of the existing effects without
 * inventing a second writer, (b) the **HARD_DENY re-check at the relay boundary**
 * (a follower must never relay-approve a dangerous command — defense in depth
 * even though the dispatch gate already denies it earlier), and (c) the
 * request/response/**timeout** discipline so a follower that goes silent cannot
 * later land a STALE decision (see {@link ./timeout}).
 *
 * This file is the PURE planner (mirrors `@/agent/control-request` and
 * `@/agent/inbound-mode`): a closed verb union + an exhaustive kind array + a
 * NO-THROW planner that maps each verb to a typed {@link FollowerEffect}. The
 * planner invents NO vocabulary and reaches NO mutable state — the HARD_DENY
 * oracle + the proposed-action resolver are INJECTED, so the composition root
 * passes the REAL `@/permission` `hardDenyReason` and the live approval map.
 *
 * DEFAULT-OFF: {@link isFollowerCoControlEnabled} reuses the EXISTING
 * `QUANTA_THIN_CLIENT_DISPATCH` gate (the thin-client dispatch surface this
 * extends) via the @/shared gate SSOT — no new knob. Unset ⇒ no follower verbs
 * are accepted, byte-identical.
 */
import type { ToolAction } from "@/permission"
import { gateOn, THIN_CLIENT_DISPATCH_FLAG } from "@/shared"
import type { InboundMode } from "../inbound-mode"

/** The "approve" / "deny" relay decision a follower carries. Mirrors
 *  `ApprovalRespondCommand.decision` so the relay maps 1:1 onto the session
 *  command channel (no second decision vocabulary). */
export type FollowerApprovalDecision = "approve" | "deny"

/**
 * A verb a FOLLOWER client may issue against the live thread. Closed union (see
 * {@link ALL_FOLLOWER_VERB_KINDS}). Each maps to an EXISTING lease-safe effect:
 *
 *  - `steer-turn` — inject `text` into the lease holder's running turn (the
 *    §steer path; NOT a second writer). Empty `text` ⇒ rejected.
 *  - `interrupt-turn` — abort the running turn (the lease-bypassing cancel). A
 *    non-empty `reason` is required so the trajectory records WHY.
 *  - `command-approval-decision` — relay an approve/deny for a pending approval.
 *    On `approve` the planner RE-CHECKS HARD_DENY (fail-closed) before emitting
 *    the relay effect. Optional `steer` rides a `deny` (corrective message,
 *    mirrors `ApprovalRespondCommand.steer`).
 *  - `set-queue-mode` — set the follow-up queue mode (queue | weave | interrupt;
 *    `weave` ≈ Codex `steer`). Maps onto the existing inbound-mode SSOT.
 */
export type FollowerVerb =
  | { readonly kind: "steer-turn"; readonly text: string }
  | { readonly kind: "interrupt-turn"; readonly reason: string }
  | {
      readonly kind: "command-approval-decision"
      readonly approvalId: string
      readonly decision: FollowerApprovalDecision
      readonly steer?: string
    }
  | { readonly kind: "set-queue-mode"; readonly mode: InboundMode }

/** Closed enumeration of {@link FollowerVerb} kinds. Extending the union MUST
 *  extend this array — the drift guard below fails the build otherwise (mirrors
 *  `ALL_CONTROL_REQUEST_KINDS`). Frozen against mutation. */
export const ALL_FOLLOWER_VERB_KINDS = Object.freeze([
  "steer-turn",
  "interrupt-turn",
  "command-approval-decision",
  "set-queue-mode",
] as const satisfies readonly FollowerVerb["kind"][])
// Drift guard: a new verb arm without a matching array entry is a build error.
type _AssertVerb<T extends true> = T
export type _FollowerVerbDriftGuard = _AssertVerb<
  FollowerVerb["kind"] extends (typeof ALL_FOLLOWER_VERB_KINDS)[number] ? true : false
>

/**
 * Typed result of planning a {@link FollowerVerb}. The host applies it onto the
 * EXISTING mechanics:
 *
 *  - `inject` → `ConversationActionSurface.pushUserMessage(text)` (§steer weave).
 *  - `interrupt` → `pushCancel(reason)` / `turn.cancel`.
 *  - `approval-relay` → `approval.respond` session command.
 *  - `queue-mode-set` → mutate the inbound-mode ref.
 *  - `rejected` → fail-closed; the host surfaces `reason`, applies NOTHING.
 */
export type FollowerEffect =
  | { readonly kind: "inject"; readonly text: string }
  | { readonly kind: "interrupt"; readonly reason: string }
  | {
      readonly kind: "approval-relay"
      readonly approvalId: string
      readonly decision: FollowerApprovalDecision
      readonly steer?: string
    }
  | { readonly kind: "queue-mode-set"; readonly mode: InboundMode }
  | { readonly kind: "rejected"; readonly reason: string }

/**
 * Injected context the planner needs to make a SECURITY decision on an approval
 * relay. Both fields are optional: when EITHER is absent the HARD_DENY re-check
 * is skipped (the relay is forwarded as-is — same posture as a surface that
 * never wired the gate). When BOTH are present the planner re-runs HARD_DENY on
 * the resolved action before forwarding an APPROVE, and rejects (fail-closed) on
 * a hit.
 */
export interface FollowerPlanContext {
  /** Resolve the proposed {@link ToolAction} a pending approval is gating, so the
   *  planner can re-check HARD_DENY. The composition root wires this to the live
   *  approval map; `undefined` ⇒ the action is not resolvable here. */
  readonly resolveProposedAction?: (approvalId: string) => ToolAction | undefined
  /** HARD_DENY oracle — inject the real `@/permission` `hardDenyReason`. Returns
   *  the deny prose (non-null) for a dangerous command, else `null`. */
  readonly hardDenyReason?: (action: ToolAction) => string | null
}

const reject = (reason: string): FollowerEffect => ({ kind: "rejected", reason })

/** Env gate — REUSES the thin-client dispatch flag (no new knob; this slice
 *  extends that surface). */
export const FOLLOWER_CO_CONTROL_FLAG = THIN_CLIENT_DISPATCH_FLAG

/** Default-OFF opt-in check via the @/shared gate SSOT. */
export const isFollowerCoControlEnabled = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, FOLLOWER_CO_CONTROL_FLAG)

/**
 * Plan an approval relay. The SECURITY core of T02: a follower may relay an
 * approve/deny for a pending approval, BUT a relay-approve of a HARD_DENY
 * (dangerous) command is rejected fail-closed at the relay boundary — even
 * though the dispatch gate already denies such commands earlier, the relay must
 * never be the path that launders one through. A DENY always forwards (denying
 * is always safe). Extracted so {@link planFollowerVerb} stays flat.
 */
const planApprovalRelay = (
  verb: Extract<FollowerVerb, { kind: "command-approval-decision" }>,
  ctx: FollowerPlanContext,
): FollowerEffect => {
  if (typeof verb.approvalId !== "string" || verb.approvalId.length === 0) {
    return reject("approval relay requires a non-empty approvalId")
  }
  if (verb.decision !== "approve" && verb.decision !== "deny") {
    return reject(`approval relay decision must be approve|deny (got ${String(verb.decision)})`)
  }
  // HARD_DENY re-check applies ONLY to an APPROVE (a deny is always safe). It
  // fires only when BOTH the action resolver AND the oracle are wired; a
  // resolved action that HARD_DENY matches is rejected fail-closed.
  if (verb.decision === "approve" && ctx.resolveProposedAction && ctx.hardDenyReason) {
    const action = ctx.resolveProposedAction(verb.approvalId)
    if (action !== undefined) {
      const hit = ctx.hardDenyReason(action)
      if (hit !== null) {
        return reject(`relay-approve blocked: ${hit}`)
      }
    }
  }
  // `steer` is a DENY-only corrective (mirrors `ApprovalRespondCommand.steer`,
  // which the host ignores on an approve) — never attach it to an approve effect.
  return verb.decision === "deny" && verb.steer !== undefined && verb.steer.length > 0
    ? {
        kind: "approval-relay",
        approvalId: verb.approvalId,
        decision: verb.decision,
        steer: verb.steer,
      }
    : { kind: "approval-relay", approvalId: verb.approvalId, decision: verb.decision }
}

/**
 * Pure planner. Validates a {@link FollowerVerb} and maps it to a typed
 * {@link FollowerEffect}. NO-THROW: any malformed input collapses to `rejected`.
 * The planner performs NO side effect and reads NO mutable state — the host
 * applies the returned effect onto the existing lease-safe mechanics.
 */
export const planFollowerVerb = (verb: FollowerVerb, ctx: FollowerPlanContext): FollowerEffect => {
  if (
    verb === null ||
    typeof verb !== "object" ||
    typeof (verb as { kind?: unknown }).kind !== "string"
  ) {
    return reject("malformed follower verb")
  }
  switch (verb.kind) {
    case "steer-turn": {
      if (typeof verb.text !== "string" || verb.text.trim().length === 0) {
        return reject("steer-turn requires non-empty text")
      }
      return { kind: "inject", text: verb.text }
    }
    case "interrupt-turn": {
      if (typeof verb.reason !== "string" || verb.reason.trim().length === 0) {
        return reject("interrupt-turn requires a non-empty reason")
      }
      return { kind: "interrupt", reason: verb.reason }
    }
    case "command-approval-decision":
      return planApprovalRelay(verb, ctx)
    case "set-queue-mode": {
      const m = verb.mode
      if (m !== "queue" && m !== "weave" && m !== "interrupt") {
        return reject(`set-queue-mode requires a known mode (got ${String(m)})`)
      }
      return { kind: "queue-mode-set", mode: m }
    }
    default: {
      // Unknown kind (forward-compat / garbage). Fail-closed, no throw.
      return reject(`unknown follower verb kind: ${String((verb as { kind?: unknown }).kind)}`)
    }
  }
}
