/**
 * Multi-agent coordination — Capability B: Leader-mediated permission
 * escalation (broker).
 *
 * Plan: docs/plans/multiagent-coordination.md §2.B + §3 + §5.
 *
 * Flow: a worker that hits a denied tool sends a mailbox `request` whose `body`
 * is an escalation envelope `{ tool, scope, reason }` (JSON) addressed to the
 * LEADER, carrying a `correlationId`. The leader's `brokerLoop` reads the
 * pending requests, runs each through the injected {@link EscalationDeciderPort}
 * (which wraps the host's `@/permission` decide / HITL), and sends a `response`
 * back with the SAME `correlationId`. The worker matches that response by
 * correlationId and applies the decision it did NOT author.
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
 * decision authority is the HOST's — injected via the duck-typed
 * {@link EscalationDeciderPort} (a `decide` function), NOT a hard `@/permission`
 * import (which the biome fence forbids from `@/subagent`). The transport
 * ({@link MailboxPort}) is likewise injected; we depend only on the structural
 * shape of a mailbox message, declared locally as {@link BrokerMessage}.
 *
 * NO-THROW: every public function degrades gracefully on hostile / malformed
 * input — parsers return `undefined`, `brokerStep` skips the offending entry,
 * `brokerLoop` returns the count it actually sent. No function throws. No
 * `Date.now()` / `Math.random` / `localeCompare`.
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

/**
 * Injected decision seam — the LEADER owns it; the worker never sees it. The
 * host wires this to its `@/permission` decide path / HITL prompter. Duck-typed
 * (a plain function) so the slice fence holds: the decision LOGIC lives in the
 * host, not in `@/subagent`.
 */
export type EscalationDeciderPort = (req: EscalationRequest) => EscalationDecision

/** The structural shape of a mailbox message this slice consumes. A local
 *  mirror of `@/agent/subagent-mailbox#MailboxMessage` so the fence holds (no
 *  `@/agent` import); only the fields the broker reads are required. */
export interface BrokerMessage {
  readonly from: string
  readonly to: string
  readonly kind: "request" | "response" | "broadcast"
  readonly body: string
  readonly correlationId?: string
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
 * Pure loop body: map each PARSEABLE pending `request` → exactly one decision
 * response via the injected `decide`. Non-`request` / malformed entries are
 * skipped (no response, no crash). If `decide` itself throws on an entry, that
 * entry is skipped (no response) rather than aborting the whole step — a hostile
 * envelope cannot poison the leader's loop.
 *
 * Idempotent on re-read: the SAME pending list ⇒ the SAME responses (the
 * function is a pure projection — it grants nothing on its own; the transport's
 * read-cursor is what makes the LIVE loop drain-once, see `brokerLoop`).
 */
export const brokerStep = (
  pending: readonly BrokerMessage[],
  decide: EscalationDeciderPort,
): DecisionResponse[] => {
  const out: DecisionResponse[] = []
  if (!Array.isArray(pending)) return out
  for (const msg of pending) {
    const req = parseEscalationRequest(msg)
    if (req === undefined) continue
    let decision: EscalationDecision
    try {
      decision = decide(req)
    } catch (e) {
      logger.warn(`broker.brokerStep decide: ${errMessage(e)}`)
      continue
    }
    out.push(buildDecisionResponse(msg, decision))
  }
  return out
}

/** The minimal transport surface `brokerLoop` needs from a `MailboxPort` —
 *  injected, duck-typed, so the slice fence holds (no `@/agent` import). */
export interface BrokerMailbox {
  /** Returns undelivered messages for the leader and MARKS them delivered. */
  read(agentId: string): readonly BrokerMessage[]
  send(init: {
    from: string
    to: string
    kind: "request" | "response" | "broadcast"
    body: string
    correlationId?: string
  }): unknown
}

/**
 * Thin leader-side loop: read the leader's pending `request`s, broker them, and
 * send each `response` back over the mailbox. Returns the number of responses
 * actually sent. NO-THROW — a transport failure logs and returns the count so
 * far. Default-OFF: the host only calls this when `QUANTA_TEAM_BROKER` is on.
 */
export const brokerLoop = (opts: {
  mailbox: BrokerMailbox
  leaderId: string
  decide: EscalationDeciderPort
}): number => {
  const { mailbox, leaderId, decide } = opts
  try {
    if (!isNonEmptyString(leaderId)) return 0
    const pending = mailbox.read(leaderId)
    const responses = brokerStep(pending, decide)
    let sent = 0
    for (const r of responses) {
      try {
        mailbox.send({
          from: leaderId,
          to: r.to,
          kind: r.kind,
          body: r.body,
          correlationId: r.correlationId,
        })
        sent++
      } catch (e) {
        logger.warn(`broker.brokerLoop send: ${errMessage(e)}`)
      }
    }
    return sent
  } catch (e) {
    logger.warn(`broker.brokerLoop: ${errMessage(e)}`)
    return 0
  }
}

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
