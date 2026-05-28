/**
 * ADR-0407 — Approval-gate wire (types).
 *
 * Wraps `ApprovalStateMachinePort` (ADR-0403) around an existing HITL resolver
 * (admissibility-gate's `reviewAction` + `onConfirm` etc.) so every HITL prompt
 * is ATTRIBUTED to the per-thread Objective (ADR-0394) + the Run Ledger
 * (ADR-0395) at request-time, then cleared on settle.
 *
 * Slice fence: imports allowed = `@/agent/approval-state-machine` (TYPES ONLY)
 * + `@/shared` (none used). NO `@/agent/admissibility-gate`, NO `@/agent/loop`,
 * NO `@/agent/dispatch`, NO `@/agent/types`. The admissibility-gate IMPORTS
 * this slice; the relationship is one-way.
 *
 * Default-OFF: a host that does not supply `approvalSM` to
 * `createApprovalGate({...})` gets a byte-identical legacy resolver pass-through
 * — `open()` simply invokes the resolver and returns the decision with
 * `approvalId: ""`. No allocation, no SM calls.
 */

import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalStateMachinePort,
} from "@/agent/approval-state-machine"

/** Re-export the kind enum so wire callers don't have to dual-import. */
export type { ApprovalDecision, ApprovalKind } from "@/agent/approval-state-machine"

/** The request payload the gate adapter receives — shape mirrors
 *  `ApprovalStateMachinePort.request`'s param but is owned by THIS slice so
 *  the admissibility-gate need not import the SM directly. */
export interface ApprovalGateRequest {
  readonly threadId: string
  readonly kind: ApprovalKind
  /** "Why agent is pausing" — a short human-readable one-liner. */
  readonly reason: string
  /** Exact action awaiting approval. */
  readonly proposedAction: string
  /** Step label the agent will resume from on approve. */
  readonly resumeStep: string
  readonly options?: readonly string[]
}

/** The terminal result of an `open()` call. `approvalId === ""` ⇒ legacy
 *  (no SM was wired or SM.request threw); caller MAY fall through to the
 *  pre-attribution path. */
export interface ApprovalGateResolution {
  readonly approvalId: string
  readonly decision: ApprovalDecision
  readonly modifiedAction?: string
}

/** The resolver shape — either return a bare decision string, or an object
 *  carrying an optional `modifiedAction` for the `modify` arm. */
export type ApprovalGateResolverReturn =
  | ApprovalDecision
  | { readonly decision: ApprovalDecision; readonly modifiedAction?: string }

/** The resolver the gate adapter calls — typically the existing reviewer /
 *  onConfirm wrapper. The resolver MAY throw; the gate settles "deny" and
 *  re-throws (the resolver's exception is the contract, not the gate's). */
export type ApprovalGateResolver = (req: ApprovalGateRequest) => Promise<ApprovalGateResolverReturn>

/**
 * Closed port over the approval-gate adapter.
 *
 * Every method is NO-THROW at the SM boundary — resolver throws DO propagate
 * (existing dispatch contract). When `approvalSM === undefined`:
 *   - `open(req, resolver)` invokes `resolver(req)` and returns the decision
 *     with `approvalId: ""`. Byte-identical to the pre-wire path.
 *   - `cancel(approvalId)` is a no-op.
 */
export interface ApprovalGatePort {
  /**
   * Opens an approval, records into approval-SM (which attributes to
   * Objective+Ledger), then awaits the resolver to settle it. Returns the
   * resolution.
   *
   * NO-THROW for SM operations: SM failure (request / settle threw) ⇒ default
   * `approve`-shaped legacy resolution with `approvalId:""`; caller decides
   * whether to honor the attribution loss — gate falls through to the legacy
   * path. The resolver's return value is still surfaced verbatim.
   *
   * If the resolver throws, the gate calls `settle(approvalId, "deny")` (best-
   * effort, NO-THROW) and re-throws the original error.
   */
  open(req: ApprovalGateRequest, resolver: ApprovalGateResolver): Promise<ApprovalGateResolution>

  /**
   * Force-settle a pending approval (cancel path on parent abort). NO-THROW.
   * Empty / non-string `approvalId` ⇒ no-op (legacy/unattributed marker).
   * Repeated calls pass through to SM each time; the SM is responsible for
   * terminal-state idempotency.
   */
  cancel(approvalId: string): void
}

/** Dependency bag for the adapter factory. Both fields optional —
 *  default-OFF when `approvalSM` is absent (legacy mode). */
export interface ApprovalGateDeps {
  approvalSM?: ApprovalStateMachinePort
  /** Clock seam (default `Date.now`). Currently unused by the gate body
   *  itself — kept for parity + future telemetry attribution. */
  now?: () => number
}
