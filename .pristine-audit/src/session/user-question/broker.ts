/**
 * RFC-01 A1 — `UserQuestionBroker` (`@/session/user-question`).
 *
 * The atomic owner of pending operator questions for a session. One in-memory
 * map, one monotonic domain revision. There is NO persistence and NO second
 * store: the pending request is session-lifetime (blueprint §6). Durable
 * cross-process pending questions remain PARKED until continuation persistence
 * exists (RFC-01 A1 stop rule).
 *
 * Contract highlights:
 *   - `request()` publishes the pending record SYNCHRONOUSLY (visible via
 *     `listPending()`) BEFORE the returned Promise can settle.
 *   - `answer/decline/cancel` settle EXACTLY once, gated by an expected domain
 *     revision (CAS). A settled request is removed, so a double-answer's second
 *     call reports `unknown`.
 *   - `cancelAll()` is the teardown lifecycle: it force-settles every waiter
 *     (bypassing CAS, as the lifecycle owner) so no awaiting caller hangs.
 *   - Clock and id factory are injected for deterministic tests.
 */

import { byteCompare, redactValue, sliceWholeChars } from "@/shared"
import type {
  PendingQuestion,
  QuestionAnswer,
  QuestionCancelReason,
  QuestionOutcome,
  QuestionRequest,
  QuestionResult,
} from "./types"

/** Max chars a UI-crossing preview carries. Bounded FIRST (defense against a
 *  giant prompt), then secret-scrubbed — same discipline as the subagent
 *  registry's `boundedRedact`. */
const PREVIEW_CAP = 240

/** Bound + secret-scrub a prompt into a preview safe to cross to a UI. The
 *  bound is applied first so a huge prompt never inflates the projection; the
 *  `@/shared` `redactValue` (OBSERVE SoT) then masks API-key/token/PEM material. */
const boundedRedact = (s: string): string => {
  const bounded = s.length > PREVIEW_CAP ? sliceWholeChars(s, PREVIEW_CAP) : s
  const scrubbed = redactValue(bounded)
  return typeof scrubbed === "string" ? scrubbed : bounded
}

/** Injected effects — defaulted to real implementations in production. */
export interface UserQuestionBrokerDeps {
  /** Monotonic wall clock for `askedAt`. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Opaque request-id factory. Defaults to `q_<uuid>`. */
  readonly mintId?: () => string
}

/** The pending-question authority. Read-only projection + atomic transitions. */
export interface UserQuestionBroker {
  /** Publish a pending question and await its terminal outcome. The record is
   *  visible via {@link listPending} synchronously, before the Promise settles. */
  request(input: QuestionRequest): Promise<QuestionOutcome>
  /** Settle `requestId` as answered. CAS on `expectedRevision`. */
  answer(requestId: string, answer: QuestionAnswer, expectedRevision: number): QuestionResult
  /** Settle `requestId` as declined. CAS on `expectedRevision`. */
  decline(requestId: string, expectedRevision: number): QuestionResult
  /** Settle `requestId` as cancelled with `reason`. CAS on `expectedRevision`. */
  cancel(requestId: string, reason: QuestionCancelReason, expectedRevision: number): QuestionResult
  /** Lifecycle teardown: force-cancel EVERY pending waiter (no CAS). */
  cancelAll(reason: QuestionCancelReason): void
  /** Immutable, deterministically-ordered (askedAt, then requestId) snapshot. */
  listPending(): readonly PendingQuestion[]
  /** The current domain revision (bumped on every publish and every settle). */
  revision(): number
}

interface Entry {
  readonly record: PendingQuestion
  readonly resolve: (outcome: QuestionOutcome) => void
}

export const createUserQuestionBroker = (deps: UserQuestionBrokerDeps = {}): UserQuestionBroker => {
  const now = deps.now ?? (() => Date.now())
  const mintId = deps.mintId ?? (() => `q_${crypto.randomUUID()}`)
  const pending = new Map<string, Entry>()
  let rev = 0

  /** Shared atomic settle with expected-revision CAS. */
  const settle = (
    requestId: string,
    expectedRevision: number,
    outcome: QuestionOutcome,
  ): QuestionResult => {
    const entry = pending.get(requestId)
    if (entry === undefined) return { ok: false, reason: "unknown", revision: rev }
    if (expectedRevision !== rev) return { ok: false, reason: "stale", revision: rev }
    pending.delete(requestId)
    rev += 1
    entry.resolve(outcome)
    return { ok: true, revision: rev }
  }

  return {
    request(input) {
      const requestId = mintId()
      const askedAt = now()
      const record: PendingQuestion = {
        requestId,
        owner: input.owner,
        askedAt,
        preview: boundedRedact(input.prompt),
      }
      return new Promise<QuestionOutcome>((resolve) => {
        // Publish synchronously (executor runs during `new Promise`), so the
        // record is visible before this Promise can settle.
        pending.set(requestId, { record, resolve })
        rev += 1
      })
    },
    answer(requestId, answer, expectedRevision) {
      return settle(requestId, expectedRevision, { kind: "answered", text: answer.text })
    },
    decline(requestId, expectedRevision) {
      return settle(requestId, expectedRevision, { kind: "declined" })
    },
    cancel(requestId, reason, expectedRevision) {
      return settle(requestId, expectedRevision, { kind: "cancelled", reason })
    },
    cancelAll(reason) {
      if (pending.size === 0) return
      const entries = [...pending.values()]
      pending.clear()
      rev += 1
      for (const e of entries) e.resolve({ kind: "cancelled", reason })
    },
    listPending() {
      return [...pending.values()]
        .map((e) => e.record)
        .sort((a, b) => a.askedAt - b.askedAt || byteCompare(a.requestId, b.requestId))
    },
    revision() {
      return rev
    },
  }
}
