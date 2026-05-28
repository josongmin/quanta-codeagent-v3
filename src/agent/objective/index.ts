/**
 * ADR-0394 — Objective slice barrel.
 *
 * The ONLY allowed import path for the objective model + store. This wave is
 * MODEL ONLY: importing this barrel allocates nothing and mutates no process
 * state until a host calls `createObjectiveStore()`. It is NOT yet wired into
 * the agent loop, dispatch, features, prompt, or any tool.
 */

export { createObjectiveStore } from "./store"
export type {
  Blocker,
  Objective,
  ObjectiveBudget,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"
