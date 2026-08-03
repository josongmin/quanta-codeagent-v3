/**
 * ADR-0403 — In-memory `ApprovalStateMachinePort` implementation.
 *
 * Zero-dep reference store. The only mutator of the approval state machine.
 * Mirrors the Objective (ADR-0394) + Run Ledger (ADR-0395) port shape:
 *   - frozen returns (no post-return mutation leaks),
 *   - NO-THROW contract on every method,
 *   - injected `now` clock seam for deterministic tests.
 *
 * Attribution: the store calls `objective.addBlocker` + `ledger.start`/`touch`/
 * `settle` ONLY when those ports are supplied via `deps`. The calls are wrapped
 * in try/catch so a misbehaving / hostile fake CANNOT break the approval state
 * itself — the request is still recorded, just without a `blockerId` /
 * `runEntryId` back-reference. That is the slice's hard invariant: attribution
 * is best-effort, approval state is authoritative.
 *
 * Slice fence: imports = `node:crypto` (for `randomUUID`), `@/agent/objective`
 * (TYPES ONLY), `@/agent/run-ledger` (TYPES ONLY), `@/shared` (leaf utils:
 * `errMessage` + `logger` for attribution-catch telemetry), and `./types`. NO
 * `@/agent` core, NO `@/apps`, NO `@/tool`.
 */

import { randomUUID } from "node:crypto"
import type { ObjectivePort } from "@/agent/objective"
import type { RunLedgerPort } from "@/agent/run-ledger"
import { errMessage, logger } from "@/shared"
import type {
  ApprovalAttributionGap,
  ApprovalDecision,
  ApprovalGapOp,
  ApprovalKind,
  ApprovalRequest,
  ApprovalSnapshot,
  ApprovalStateMachinePort,
  ApprovalStatus,
} from "./types"

/** Closed allow-lists used by NO-THROW guards. Anything outside these is
 *  silently ignored / coerced; we never throw on a bad enum value. */
const APPROVAL_KIND = new Set<ApprovalKind>(["permission", "clarification", "escalation"])
const APPROVAL_STATUS = new Set<ApprovalStatus>([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
])
const APPROVAL_DECISION = new Set<ApprovalDecision>(["approve", "deny", "modify"])

/** Maximum number of `options` retained on a request (defensive cap, matches
 *  the port doc "3 max"). Extra options are silently truncated. */
const MAX_OPTIONS = 3

const isString = (v: unknown): v is string => typeof v === "string"

const finiteOrNow = (v: unknown, fallback: () => number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback()

/** Coerce + freeze a list of clarification options (cap = MAX_OPTIONS).
 *  A non-array / hostile value returns `null` (omit the field). */
const normalizeOptions = (raw: unknown): readonly string[] | null => {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const v of raw) {
    if (isString(v)) out.push(v)
    if (out.length >= MAX_OPTIONS) break
  }
  return out.length === 0 ? null : Object.freeze(out)
}

/** Freeze a record (and its options array) so a returned reference is inert. */
const freezeRequest = (r: ApprovalRequest): ApprovalRequest => {
  const optsFrozen = r.options ? Object.freeze([...r.options]) : undefined
  const base: ApprovalRequest = {
    ...r,
    ...(optsFrozen !== undefined ? { options: optsFrozen } : {}),
  }
  return Object.freeze(base)
}

/** Build the initial pending record. Pure — clock value passed in. */
const buildPending = (
  init: {
    id?: string
    threadId: string
    kind: ApprovalKind
    reason: string
    proposedAction: string
    resumeStep: string
    options?: readonly string[]
    artifactRef?: string
    artifactHash?: string
  },
  at: number,
): ApprovalRequest => {
  const opts = normalizeOptions(init.options)
  return {
    id: isString(init.id) && init.id.length > 0 ? init.id : randomUUID(),
    threadId: isString(init.threadId) ? init.threadId : "",
    kind: APPROVAL_KIND.has(init.kind) ? init.kind : "permission",
    reason: isString(init.reason) ? init.reason : "",
    proposedAction: isString(init.proposedAction) ? init.proposedAction : "",
    resumeStep: isString(init.resumeStep) ? init.resumeStep : "",
    ...(opts !== null ? { options: opts } : {}),
    // RFC03-3 — additive artifact binding; omitted when absent (exactOptional).
    ...(isString(init.artifactRef) ? { artifactRef: init.artifactRef } : {}),
    ...(isString(init.artifactHash) ? { artifactHash: init.artifactHash } : {}),
    status: "pending",
    createdAt: at,
  }
}

/** Map a decision → a Run Ledger terminal status.
 *  approve / modify ⇒ completed; deny ⇒ stopped. */
const decisionToLedgerStatus = (d: ApprovalDecision): "completed" | "stopped" =>
  d === "approve" || d === "modify" ? "completed" : "stopped"

/** Map a status that exits via expire/cancel → ledger terminal.
 *  Both halt the wait without an explicit user decision ⇒ stopped. */
const statusToLedgerStatus = (s: ApprovalStatus): "completed" | "stopped" => {
  if (s === "approved") return "completed"
  return "stopped"
}

/** Required-field gate for a hostile snapshot entry. Returns `null` if any
 *  required field is missing or has the wrong type — keeps `cleanSnapshotEntry`
 *  under the cognitive-complexity cap. */
const hasValidRequired = (r: Record<string, unknown>): boolean => {
  if (!isString(r.id) || r.id.length === 0) return false
  if (!isString(r.threadId)) return false
  if (!APPROVAL_KIND.has(r.kind as ApprovalKind)) return false
  if (!APPROVAL_STATUS.has(r.status as ApprovalStatus)) return false
  if (!isString(r.reason)) return false
  if (!isString(r.proposedAction)) return false
  if (!isString(r.resumeStep)) return false
  return true
}

/** Spread-or-omit a string optional (exactOptional): included only when the raw
 *  value is a string. Keeps {@link buildOptionalFields} flat. */
const optStr = <K extends string>(key: K, raw: unknown): Partial<Record<K, string>> =>
  isString(raw) ? ({ [key]: raw } as Record<K, string>) : {}

/** Build the optional-fields portion of a record (everything beyond the
 *  required gate). Each optional is omitted when absent (exactOptional). */
const buildOptionalFields = (r: Record<string, unknown>): Partial<ApprovalRequest> => {
  const opts = normalizeOptions(r.options)
  const settledAt =
    typeof r.settledAt === "number" && Number.isFinite(r.settledAt) ? r.settledAt : undefined
  const decision = APPROVAL_DECISION.has(r.decision as ApprovalDecision)
    ? (r.decision as ApprovalDecision)
    : undefined
  return {
    ...(opts !== null ? { options: opts } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...optStr("modifiedAction", r.modifiedAction),
    ...optStr("blockerId", r.blockerId),
    ...optStr("runEntryId", r.runEntryId),
    ...optStr("artifactRef", r.artifactRef),
    ...optStr("artifactHash", r.artifactHash),
  }
}

/** Defensive snapshot-entry normaliser. Returns `null` on hostile input. */
const cleanSnapshotEntry = (e: unknown): ApprovalRequest | null => {
  if (e === null || typeof e !== "object") return null
  const r = e as Record<string, unknown>
  if (!hasValidRequired(r)) return null
  const createdAt =
    typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0
  return freezeRequest({
    id: r.id as string,
    threadId: r.threadId as string,
    kind: r.kind as ApprovalKind,
    reason: r.reason as string,
    proposedAction: r.proposedAction as string,
    resumeStep: r.resumeStep as string,
    status: r.status as ApprovalStatus,
    createdAt,
    ...buildOptionalFields(r),
  })
}

/** Capture the id of the NEWEST blocker on an Objective — used after a
 *  successful `objective.addBlocker` to record `blockerId` on the request. */
const newestBlockerId = (objective: ObjectivePort, threadId: string): string | null => {
  try {
    const obj = objective.get(threadId)
    if (obj === null) return null
    const blockers = obj.blockers
    if (!Array.isArray(blockers) || blockers.length === 0) return null
    const last = blockers[blockers.length - 1]
    return last && isString(last.id) ? last.id : null
  } catch (e) {
    logger.warn(`approval-state.attr.newestBlockerId: ${errMessage(e)}`)
    return null
  }
}

/** Try to attribute the pause to the Objective. Returns the new blocker id,
 *  or `null` on any failure. NO-THROW. */
const attributeObjective = (
  objective: ObjectivePort | undefined,
  threadId: string,
  reason: string,
): string | null => {
  if (objective === undefined) return null
  try {
    const updated = objective.addBlocker(threadId, { reason, waitingOn: "user" })
    if (updated === null) return null
    return newestBlockerId(objective, threadId)
  } catch (e) {
    logger.warn(`approval-state.attr.attributeObjective: ${errMessage(e)}`)
    return null
  }
}

/** Try to attribute the pause to the Run Ledger. Returns the entry id used,
 *  or `null` on any failure. NO-THROW. */
const attributeLedger = (
  ledger: RunLedgerPort | undefined,
  approvalId: string,
  threadId: string,
  reason: string,
  resumeStep: string,
): string | null => {
  if (ledger === undefined) return null
  try {
    ledger.start({
      id: approvalId,
      kind: "exec",
      owner: threadId,
      title: reason,
      resumeAction: resumeStep,
    })
    ledger.touch(approvalId, { status: "waiting", waitingOn: "user" })
    return approvalId
  } catch (e) {
    logger.warn(`approval-state.attr.attributeLedger: ${errMessage(e)}`)
    return null
  }
}

/** Best-effort: clear the matched objective blocker. NO-THROW. */
const clearObjectiveBlocker = (
  objective: ObjectivePort | undefined,
  threadId: string,
  blockerId: string | undefined,
): void => {
  if (objective === undefined || blockerId === undefined) return
  try {
    objective.clearBlocker(threadId, blockerId)
  } catch (e) {
    // attribution failure must not break approval state — log + swallow
    logger.warn(`approval-state.attr.clearBlocker: ${errMessage(e)}`)
  }
}

/** Best-effort: settle the matched ledger entry. NO-THROW. */
const settleLedger = (
  ledger: RunLedgerPort | undefined,
  runEntryId: string | undefined,
  status: "completed" | "stopped",
): void => {
  if (ledger === undefined || runEntryId === undefined) return
  try {
    ledger.settle(runEntryId, status)
  } catch (e) {
    // attribution failure must not break approval state — log + swallow
    logger.warn(`approval-state.attr.settleLedger: ${errMessage(e)}`)
  }
}

/** Default cap on retained requests. SETTLED records are LRU-evicted past
 *  this; PENDING records are never evicted (a pause must stay observable until
 *  resolved). Mirrors the mailbox / run-ledger bounded-retention discipline so
 *  a long session cannot grow the request Map without bound. */
const DEFAULT_MAX_RETAINED = 1024

export const createApprovalStateMachine = (opts?: {
  now?: () => number
  objective?: ObjectivePort
  ledger?: RunLedgerPort
  maxRetained?: number
  /** FAIL-CLOSED audit-gap sink (DOF-40). Invoked when a terminal mutator
   *  (`settle` / `expire` / `cancel`) is called for an id the machine has NO
   *  record of — i.e. a producer never `request()`ed it, so the resolution
   *  attributes NOTHING. The observer surfaces the missing audit trail instead
   *  of the swallowed `null`. Absent ⇒ byte-identical legacy (zero calls). The
   *  sink itself is invoked NO-THROW — a throwing observer cannot break the
   *  mutator's `null`-return contract. */
  onUnattributed?: (gap: ApprovalAttributionGap) => void
}): ApprovalStateMachinePort => {
  const objective = opts?.objective
  const ledger = opts?.ledger
  const onUnattributed = opts?.onUnattributed
  const maxRetained =
    typeof opts?.maxRetained === "number" &&
    Number.isFinite(opts.maxRetained) &&
    opts.maxRetained > 0
      ? Math.floor(opts.maxRetained)
      : DEFAULT_MAX_RETAINED
  const requests = new Map<string, ApprovalRequest>()

  /** Audit R2 (F3): evict oldest SETTLED requests when over `maxRetained`.
   *  PENDING are never dropped (an unresolved pause must stay visible). NO-THROW. */
  const evictIfOverCap = (): void => {
    try {
      if (requests.size <= maxRetained) return
      const settled = [...requests.values()]
        .filter((r) => r.status !== "pending")
        .sort((a, b) => (a.settledAt ?? a.createdAt) - (b.settledAt ?? b.createdAt))
      let over = requests.size - maxRetained
      for (const r of settled) {
        if (over <= 0) break
        requests.delete(r.id)
        over -= 1
      }
    } catch (e) {
      // NO-THROW — eviction is best-effort hygiene, never breaks the port.
      logger.warn(`approval-state.attr.evictIfOverCap: ${errMessage(e)}`)
    }
  }

  /** Defensive clock: a host-supplied `now` that throws or returns a
   *  non-finite value falls back to `Date.now()`. */
  const clock = (): number => {
    try {
      const t = opts?.now ? opts.now() : Date.now()
      return Number.isFinite(t) ? t : finiteOrNow(undefined, () => Date.now())
    } catch {
      try {
        return Date.now()
      } catch {
        return 0
      }
    }
  }

  const store = (r: ApprovalRequest): ApprovalRequest => {
    const frozen = freezeRequest(r)
    requests.set(frozen.id, frozen)
    // Evict AFTER every set (request creation + settle/expire/cancel
    // transitions) so the "settle later" pattern triggers eviction once a
    // record becomes settled — request-time alone can't (all-pending then).
    evictIfOverCap()
    return frozen
  }

  const matchesFilter = (
    r: ApprovalRequest,
    f: { status?: ApprovalStatus; threadId?: string },
  ): boolean => {
    if (f.status !== undefined && r.status !== f.status) return false
    if (f.threadId !== undefined && r.threadId !== f.threadId) return false
    return true
  }

  /** FAIL-CLOSED audit-gap emit (DOF-40). A terminal mutator hit an id with NO
   *  record ⇒ the resolution can attribute nothing (missing producer). Surface
   *  it through the injected observer so the un-attributed escalation is never
   *  silently dropped. NO-THROW: a throwing observer cannot break the mutator.
   *  Absent observer ⇒ zero work (byte-identical legacy). */
  const emitGap = (op: ApprovalGapOp, id: string, decision?: ApprovalDecision): void => {
    if (onUnattributed === undefined) return
    try {
      const gap: ApprovalAttributionGap = {
        approvalId: isString(id) ? id : "",
        op,
        ...(decision !== undefined ? { decision } : {}),
        at: clock(),
      }
      onUnattributed(Object.freeze(gap))
    } catch (e) {
      // Observer failure must not break the mutator's null-return contract.
      logger.warn(`approval-state.attr.gapObserver: ${errMessage(e)}`)
    }
  }

  /** Lookup + run `fn` on a pending entry. Returns null on unknown id; returns
   *  the existing entry unchanged on an already-settled record (idempotent
   *  no-op). On an UNKNOWN id emits a fail-closed attribution-gap under `op`
   *  (DOF-40) before returning null — an already-settled record is NOT a gap
   *  (it WAS attributed). NO-THROW. */
  const onlyIfPending = (
    id: string,
    op: ApprovalGapOp,
    fn: (cur: ApprovalRequest) => ApprovalRequest,
    decision?: ApprovalDecision,
  ): ApprovalRequest | null => {
    try {
      if (!isString(id)) {
        emitGap(op, id, decision)
        return null
      }
      const cur = requests.get(id)
      if (cur === undefined) {
        emitGap(op, id, decision)
        return null
      }
      if (cur.status !== "pending") return cur
      return store(fn(cur))
    } catch (e) {
      logger.warn(`approval-state.attr.onlyIfPending[${op}]: ${errMessage(e)}`)
      return null
    }
  }

  return {
    request(req): ApprovalRequest {
      try {
        const at = clock()
        // Garbage in still produces a non-null ApprovalRequest (port contract).
        const safe =
          req !== null && typeof req === "object"
            ? req
            : {
                threadId: "",
                kind: "permission" as ApprovalKind,
                reason: "",
                proposedAction: "",
                resumeStep: "",
              }
        const pending = buildPending(safe, at)
        // A kernel replay can deliver the same deferred approval more than
        // once. Preserve the original attribution rather than double-starting
        // its ledger entry or adding another objective blocker.
        const existing = requests.get(pending.id)
        if (existing !== undefined) return existing
        // Best-effort attribution — failure must not propagate.
        const blockerId = attributeObjective(objective, pending.threadId, pending.reason)
        const runEntryId = attributeLedger(
          ledger,
          pending.id,
          pending.threadId,
          pending.reason,
          pending.resumeStep,
        )
        return store({
          ...pending,
          ...(blockerId !== null ? { blockerId } : {}),
          ...(runEntryId !== null ? { runEntryId } : {}),
        })
      } catch (e) {
        logger.warn(`approval-state.attr.request: ${errMessage(e)}`)
        // Fall back to an empty pending — the port contract forbids throwing.
        return store(
          buildPending(
            {
              threadId: "",
              kind: "permission",
              reason: "",
              proposedAction: "",
              resumeStep: "",
            },
            0,
          ),
        )
      }
    },

    settle(id, decision, settleOpts): ApprovalRequest | null {
      // Idempotent: settling an already-settled record is a no-op returning it.
      // The gap decision mirrors the SM's own coercion so an unknown-id gap
      // reports the SAME decision the mutator would have applied.
      const dForGap = APPROVAL_DECISION.has(decision) ? decision : "deny"
      return onlyIfPending(
        id,
        "settle",
        (cur) => {
          const d = APPROVAL_DECISION.has(decision) ? decision : "deny"
          const status: ApprovalStatus = d === "deny" ? "denied" : "approved"
          const modifiedAction =
            d === "modify" && settleOpts && isString(settleOpts.modifiedAction)
              ? settleOpts.modifiedAction
              : undefined
          const next: ApprovalRequest = {
            ...cur,
            status,
            settledAt: clock(),
            decision: d,
            ...(modifiedAction !== undefined ? { modifiedAction } : {}),
          }
          clearObjectiveBlocker(objective, cur.threadId, cur.blockerId)
          settleLedger(ledger, cur.runEntryId, decisionToLedgerStatus(d))
          return next
        },
        dForGap,
      )
    },

    expire(id): ApprovalRequest | null {
      return onlyIfPending(id, "expire", (cur) => {
        const next: ApprovalRequest = { ...cur, status: "expired", settledAt: clock() }
        clearObjectiveBlocker(objective, cur.threadId, cur.blockerId)
        settleLedger(ledger, cur.runEntryId, statusToLedgerStatus("expired"))
        return next
      })
    },

    cancel(id): ApprovalRequest | null {
      return onlyIfPending(id, "cancel", (cur) => {
        const next: ApprovalRequest = { ...cur, status: "cancelled", settledAt: clock() }
        clearObjectiveBlocker(objective, cur.threadId, cur.blockerId)
        settleLedger(ledger, cur.runEntryId, statusToLedgerStatus("cancelled"))
        return next
      })
    },

    get(id): ApprovalRequest | null {
      try {
        if (!isString(id)) return null
        return requests.get(id) ?? null
      } catch (e) {
        logger.warn(`approval-state.attr.get: ${errMessage(e)}`)
        return null
      }
    },

    list(filter): readonly ApprovalRequest[] {
      try {
        const f = filter && typeof filter === "object" ? filter : {}
        const out: ApprovalRequest[] = []
        for (const r of requests.values()) if (matchesFilter(r, f)) out.push(r)
        return Object.freeze(out)
      } catch (e) {
        logger.warn(`approval-state.attr.list: ${errMessage(e)}`)
        return Object.freeze([])
      }
    },

    pending(): readonly ApprovalRequest[] {
      return this.list({ status: "pending" })
    },

    toSnapshot(): ApprovalSnapshot {
      try {
        return Object.freeze({ approvals: Object.freeze([...requests.values()]) })
      } catch (e) {
        logger.warn(`approval-state.attr.toSnapshot: ${errMessage(e)}`)
        return Object.freeze({ approvals: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        if (snap === null || typeof snap !== "object") return
        const raw = (snap as ApprovalSnapshot).approvals
        if (!Array.isArray(raw)) return
        requests.clear()
        for (const e of raw) {
          const clean = cleanSnapshotEntry(e)
          if (clean !== null) requests.set(clean.id, clean)
        }
      } catch (e) {
        // leave whatever survived; never throw
        logger.warn(`approval-state.attr.fromSnapshot: ${errMessage(e)}`)
      }
    },
  }
}
