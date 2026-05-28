/**
 * ADR-0399 — Approval state machine slice barrel.
 *
 * The ONLY allowed import path for the approval state machine model + store.
 *
 * Default-OFF & self-contained: importing this barrel allocates nothing and
 * mutates no process state until a host calls `createApprovalStateMachine()`.
 * This wave is the PORT + STORE layer — NOT yet wired into the agent loop,
 * `admissibility-gate.ts`, or `request_user_input`. Existing HITL code is
 * UNCHANGED.
 */

export { createApprovalStateMachine } from "./store"
export type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalSnapshot,
  ApprovalStateMachinePort,
  ApprovalStatus,
} from "./types"
