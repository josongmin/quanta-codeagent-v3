/**
 * Multi-agent coordination — Capability B: Leader-mediated permission
 * escalation (broker) — PURE PROTOCOL PRIMITIVES.
 *
 * Plan: docs/plans/multiagent-coordination.md §2.B + §3 + §5.
 *
 * Flow (the LIVE path is `@/agent/coordination-broker-wire#buildLeaderHitlBroker`):
 * a worker that hits a SOFT-denied tool escalates. The wire composes these three
 * pure primitives IN-PROCESS within one call — there is no asynchronous mailbox
 * read-loop on the live path:
 *   1. {@link parseEscalationRequest} — typed `{ tool, scope, reason }` envelope.
 *   2. the LEADER authority (the parent agent's HITL/onConfirm, injected by the
 *      wire — never visible to the worker) decides; {@link buildDecisionResponse}
 *      serializes a leader-authored `response` round-tripping the `correlationId`.
 *   3. {@link applyDecisionResponse} — the worker-side applier (see SECURITY).
 * The mailbox carries only an AUDIT trail of these rows; it is NOT the decision
 * transport (a prior `brokerLoop`/`brokerStep` mailbox-read-loop existed here but
 * was never wired live — removed jun-07 to stop the docs advertising a mechanism
 * that does not run).
 *
 * SECURITY (load-bearing, plan §5): the broker is a GRANT path, so the only
 * authority that can widen a worker's permission is a LEADER-authored
 * `response`. {@link applyDecisionResponse} honors a decision ONLY when the
 * message is a `response`, its `correlationId` matches the worker's outstanding
 * request, AND (when a `leaderId` is pinned) it was authored by the leader. A
 * worker can NEVER self-grant: a self-authored `request`/`broadcast`, or even a
 * `response` the worker forged itself, is rejected. (Mirrors the H2/B2
 * provenance posture — grants flow from the higher-authority source only.)
 *
 * SLICE FENCE (`src/subagent/**`): this leaf imports ONLY `@/shared`. The
 * decision authority is the HOST's — injected by the wire, NOT a hard
 * `@/permission` import (which the biome fence forbids from `@/subagent`). These
 * primitives depend only on the structural shape of a mailbox message, declared
 * locally as {@link BrokerMessage}.
 *
 * NO-THROW: every function degrades gracefully on hostile / malformed input —
 * parsers return `undefined`. No function throws. No `Date.now()` /
 * `Math.random` / `localeCompare`.
 */

import { errMessage, logger } from "@/shared"

/** The escalation envelope a blocked worker serializes into a `request` body. */
export interface EscalationRequest {
  /** The denied tool the worker wants to run (e.g. `"shell"`). Non-empty. */
  readonly tool: string
  /** The specific scope/operation being requested (e.g. `"exec:rm -rf x"`). */
  readonly scope: string
  /** Human-readable justification surfaced to the decider / HITL. */
  readonly reason: string
}

/** The leader's verdict on an escalation. A deny carries a reason so the worker
 *  can surface WHY it stays blocked (no silent failure). */
export type EscalationDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string }

/** The structural shape of a mailbox message this slice consumes. A local
 *  mirror of `@/agent/subagent-mailbox#MailboxMessage` so the fence holds (no
 *  `@/agent` import); only the fields the broker reads are required. */
export interface BrokerMessage {
  readonly from: string
  readonly to: string
  readonly kind: "request" | "response" | "broadcast"
  readonly body: string
  readonly correlationId?: string
  /** Transport envelope fields the real `MailboxMessage` carries but the broker
   *  does NOT read — declared optional so the mirror accepts a full on-the-wire
   *  message without a cast (the broker's authority checks never depend on them). */
  readonly id?: string
  readonly sentAt?: number
}

/** A response the broker emits — the SAME `correlationId` round-trips so the
 *  worker can match it. The host hands this to `MailboxPort.send`. */
export interface DecisionResponse {
  readonly to: string
  readonly kind: "response"
  readonly body: string
  readonly correlationId: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isString = (v: unknown): v is string => typeof v === "string"

/** No-throw JSON parse → object, or `undefined` for any non-object / malformed
 *  input (including `null`, arrays, primitives). */
const parseJsonObject = (body: unknown): Record<string, unknown> | undefined => {
  if (!isString(body) || body.length === 0) return undefined
  try {
    const v: unknown = JSON.parse(body)
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
    return v as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Parse a worker's escalation `request` into a typed {@link EscalationRequest},
 * or `undefined` for a non-`request` kind / malformed body / missing required
 * string fields. NO-THROW.
 */
export const parseEscalationRequest = (msg: BrokerMessage): EscalationRequest | undefined => {
  try {
    if (msg === null || typeof msg !== "object") return undefined
    if (msg.kind !== "request") return undefined
    const obj = parseJsonObject(msg.body)
    if (obj === undefined) return undefined
    const { tool, scope, reason } = obj
    if (!isNonEmptyString(tool) || !isString(scope) || !isString(reason)) return undefined
    return { tool, scope, reason }
  } catch (e) {
    logger.warn(`broker.parseEscalationRequest: ${errMessage(e)}`)
    return undefined
  }
}

/**
 * Build the leader's `response` to a worker's `request`, round-tripping the
 * SAME `correlationId` so the worker can match it. Addresses the original
 * sender (`req.from`). The `correlationId` falls back to `""` only when the
 * request carried none (which `parseEscalationRequest` callers never produce);
 * the worker's matcher then rejects an empty-id mismatch. NO-THROW.
 */
export const buildDecisionResponse = (
  req: BrokerMessage,
  decision: EscalationDecision,
): DecisionResponse => ({
  to: isString(req?.from) ? req.from : "",
  kind: "response",
  body: JSON.stringify(decision),
  correlationId: isString(req?.correlationId) ? req.correlationId : "",
})

/**
 * Worker-side applier — the ONLY path by which a worker accepts a wider
 * permission. Returns the {@link EscalationDecision} ONLY when:
 *   1. `msg.kind === "response"` (a `request`/`broadcast` is rejected — a worker
 *      cannot dress up its own outbound message as a grant);
 *   2. `msg.correlationId === expectedCorrelationId` (it matches the worker's
 *      OUTSTANDING request — not some other / forged id);
 *   3. when `opts.leaderId` is pinned, `msg.from === opts.leaderId` (only the
 *      LEADER's authority widens permission — a sibling/self-authored response
 *      is rejected even with the right kind + correlationId).
 * Otherwise `undefined` (worker stays blocked). NO-THROW.
 *
 * SECURITY: this is the load-bearing invariant. A worker CANNOT self-grant —
 * the decision it applies is one it did not author.
 */
export const applyDecisionResponse = (
  msg: BrokerMessage,
  expectedCorrelationId: string,
  opts?: { leaderId?: string },
): EscalationDecision | undefined => {
  try {
    if (msg === null || typeof msg !== "object") return undefined
    if (msg.kind !== "response") return undefined
    if (!isNonEmptyString(expectedCorrelationId)) return undefined
    if (msg.correlationId !== expectedCorrelationId) return undefined
    const leaderId = opts?.leaderId
    if (isNonEmptyString(leaderId) && msg.from !== leaderId) return undefined
    const obj = parseJsonObject(msg.body)
    if (obj === undefined) return undefined
    if (obj.approved === true) return { approved: true }
    if (obj.approved === false) {
      return { approved: false, reason: isString(obj.reason) ? obj.reason : "" }
    }
    return undefined
  } catch (e) {
    logger.warn(`broker.applyDecisionResponse: ${errMessage(e)}`)
    return undefined
  }
}
