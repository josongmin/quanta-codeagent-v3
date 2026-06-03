/**
 * ADR-0408 — Observability UI pane WS protocol.
 *
 * Two closed messages over the existing WS wire so a separate-from-chat
 * observability pane can render Running / Waiting / Completed runs + the
 * per-thread Objective + Pending Approvals:
 *
 *   - `observability.snapshot` — full state push (initial / reconnect)
 *   - `observability.delta`    — incremental updates (additions, mutations,
 *                                removals)
 *
 * Slice fence (load-bearing): this module imports TYPES ONLY from the three
 * existing closed ports (`@/agent/run-ledger`, `@/agent/objective`,
 * `@/agent/approval-state-machine`). No runtime cross-slice — the types are
 * structural mirrors and the emitter / decoder produce / consume them via
 * the wire envelope. Importing this module touches no process state.
 */

import type { ApprovalRequest } from "@/agent/approval-state-machine"
import type { Objective } from "@/agent/objective"
import type { RunEntry } from "@/agent/run-ledger"

/** Full state push. Sent on first wiring + on reconnect / re-attach so a
 *  fresh client can render Running / Waiting / Completed and the current
 *  Objective + Pending Approvals without replaying any deltas. */
export interface ObservabilitySnapshotMessage {
  readonly kind: "observability.snapshot"
  /** Every RunLedger entry the host wants the UI to render. The emitter MAY
   *  pre-filter to the active set; the protocol does not constrain. */
  readonly runs: readonly RunEntry[]
  /** Current thread's objective, or null when no Objective is active /
   *  injected. */
  readonly objective: Objective | null
  /** Pending approvals only (status==="pending"). Settled approvals leave
   *  the pane via a delta entry that sets `approval: null`. */
  readonly approvals: readonly ApprovalRequest[]
  /** Epoch-ms stamp when the emitter assembled the snapshot. */
  readonly emittedAt: number
}

/** A single run-entry delta. `entry === null` ⇒ the run id is EVICTED from
 *  the pane (LRU drop or settle-then-evict). Anything else ⇒ add or
 *  overwrite. The wire uses the explicit `null` arm so a client can
 *  distinguish "no change" (no entry in `runChanges`) from "remove". */
export interface RunChange {
  readonly id: string
  readonly entry: RunEntry | null
}

/** A single approval delta. Same null-arm semantics as RunChange. */
export interface ApprovalChange {
  readonly id: string
  readonly approval: ApprovalRequest | null
}

/** Incremental update. Every field is optional — the emitter MAY include any
 *  combination per tick (e.g. only `objectiveChanged`, or only a single
 *  `runChanges` entry). All-omitted deltas SHOULD NOT be sent (the emitter
 *  guards against that), but a client receiving one is expected to no-op. */
export interface ObservabilityDeltaMessage {
  readonly kind: "observability.delta"
  /** Closed-port "additions and removals" applied verbatim. */
  readonly runChanges?: readonly RunChange[]
  /** `null` ⇒ the active objective went away. Present-and-not-null ⇒
   *  replace. Absent (the field itself) ⇒ no change. */
  readonly objectiveChanged?: Objective | null
  /** Pending-approval mutations. `approval === null` ⇒ approval id LEAVES the
   *  pane (settled / expired / cancelled / id-not-known). */
  readonly approvalChanges?: readonly ApprovalChange[]
  readonly emittedAt: number
}

/** Closed discriminated union — every observability message the wire carries. */
export type ObservabilityMessage = ObservabilitySnapshotMessage | ObservabilityDeltaMessage

/** Closed enum of observability message tags — keep in lock-step with the
 *  union above. Useful for runtime tag guards and tests. */
export const OBSERVABILITY_MESSAGE_KINDS = [
  "observability.snapshot",
  "observability.delta",
] as const

export type ObservabilityMessageKind = (typeof OBSERVABILITY_MESSAGE_KINDS)[number]

/** Type guard — narrows arbitrary input to a tagged observability message
 *  WITHOUT validating every nested field (deep validation is the consumer's
 *  job; this guard exists for wire-routing on the receive path). */
export const isObservabilityMessageKind = (value: unknown): value is ObservabilityMessageKind =>
  typeof value === "string" && (OBSERVABILITY_MESSAGE_KINDS as readonly string[]).includes(value)

/** Plain-object check (excludes arrays + nulls) used by every shape guard. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** Nullable-object shape (`null` OR plain object) — used for the `objective`
 *  / `objectiveChanged` fields where `null` is a meaningful arm. */
const isNullableObject = (v: unknown): boolean => v === null || isPlainObject(v)

const isSnapshotShape = (rec: Record<string, unknown>): boolean =>
  Array.isArray(rec.runs) && Array.isArray(rec.approvals) && isNullableObject(rec.objective)

const isDeltaShape = (rec: Record<string, unknown>): boolean => {
  if (rec.runChanges !== undefined && !Array.isArray(rec.runChanges)) return false
  if (rec.approvalChanges !== undefined && !Array.isArray(rec.approvalChanges)) {
    return false
  }
  if (rec.objectiveChanged !== undefined && !isNullableObject(rec.objectiveChanged)) {
    return false
  }
  return true
}

/** Best-effort structural guard. Returns true iff `value` has a recognised
 *  `kind` tag. Each kind's per-field shape is enforced by the encoder on the
 *  emit path; the consumer treats unrecognised fields as forward-compatible. */
export const isObservabilityMessage = (value: unknown): value is ObservabilityMessage => {
  if (!isPlainObject(value)) return false
  if (!isObservabilityMessageKind(value.kind)) return false
  if (typeof value.emittedAt !== "number" || !Number.isFinite(value.emittedAt)) {
    return false
  }
  return value.kind === "observability.snapshot" ? isSnapshotShape(value) : isDeltaShape(value)
}

/* ------------------------------------------------------------------ */
/* Wire envelope helpers                                               */
/* ------------------------------------------------------------------ */

/** Wire envelope shape mirrors `src/protocol/session/codec.ts` — one JSON
 *  object per frame, `{ version, kind, payload }`. The observability messages
 *  ride the same envelope shape so any transport that handles session frames
 *  can route observability frames without a separate decoder. */
export interface ObservabilityWireEnvelope {
  readonly version: string
  readonly kind: "observability"
  readonly payload: ObservabilityMessage
}

/** Pinned version tag for the observability protocol — bumped on a
 *  backward-incompatible change. Decoupled from the session protocol version
 *  on purpose: snapshot/delta cadence iterates faster than session events. */
export const OBSERVABILITY_PROTOCOL_VERSION = "observability.v1" as const

/** Encode a typed observability message into a JSON wire frame. */
export const encodeObservabilityFrame = (msg: ObservabilityMessage): string =>
  JSON.stringify({
    version: OBSERVABILITY_PROTOCOL_VERSION,
    kind: "observability",
    payload: msg,
  } satisfies ObservabilityWireEnvelope)

/** Decode a wire frame into an observability message, or return null on any
 *  shape mismatch. NO-THROW: callers log + drop on null. */
export const decodeObservabilityFrame = (raw: unknown): ObservabilityMessage | null => {
  if (typeof raw !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const rec = parsed as Record<string, unknown>
  if (rec.kind !== "observability") return null
  if (typeof rec.version !== "string" || rec.version.length === 0) return null
  // Gate the protocol version we claim to carry: a v2 emitter to a v1 consumer
  // would otherwise be read with the wrong schema and silently mis-rendered.
  if (rec.version !== OBSERVABILITY_PROTOCOL_VERSION) return null
  if (!isObservabilityMessage(rec.payload)) return null
  return rec.payload
}
