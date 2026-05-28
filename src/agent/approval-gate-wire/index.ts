/**
 * ADR-0407 — Approval-gate wire slice barrel.
 *
 * The ONLY allowed import path for the approval-gate adapter. Importing this
 * barrel allocates nothing and mutates no process state until a host calls
 * `createApprovalGate({...})`. Default-OFF: with `approvalSM` absent the
 * adapter is a byte-identical legacy resolver pass-through.
 */

export type {
  ApprovalDecision,
  ApprovalGateDeps,
  ApprovalGatePort,
  ApprovalGateRequest,
  ApprovalGateResolution,
  ApprovalGateResolver,
  ApprovalGateResolverReturn,
  ApprovalKind,
} from "./types"
export { createApprovalGate } from "./wire"
