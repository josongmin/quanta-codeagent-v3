/**
 * `@/agent/converge` — the SURFACE-NEUTRAL "run → observe → verify → bounded converge-to-green" SSOT.
 *
 * Hoisted out of `src/apps/terminal/` (jul-3 architecture audit) so BOTH the terminal brain AND a
 * future bench adapter reuse ONE implementation. Two halves:
 *   • the PURE verdict inspectors (this file's re-exports): did the trajectory RUN (L0), COMPARE (L1),
 *     exit clean (OC1), and (S1b) run an agent-authored self-test — plus the no-leak taint SSOT that
 *     every classifier shares by construction (a classifier physically cannot ship a weaker oracle
 *     check; the jul-3 hell-audit F2 root cause);
 *   • the bounded convergence loop ({@link runConvergeLoop}, `./loop`): drive a fair fail signal to
 *     green under two independent over-persist bounds. The convergence SIGNAL is a pluggable port
 *     ({@link FairFailSource}) so each surface supplies its own (terminal = agent self-test).
 *
 * Layers (dependency order): tokenize → exercise → oracle-taint → compare / output-contract /
 * self-test → stamp → loop.
 *
 * The verdict inspectors are PURE / LEAF (no model calls, no IO, no `process.*`; input is the captured
 * `AgentEvent[]`). The loop is pure over its injected ports. The dominant Terminal-Bench failure (~70%)
 * is "fake green": the agent claims done but never checked its deliverable against spec — this core
 * answers, fail-closed, whether the trajectory actually RAN and COMPARED against a fair reference, and
 * (with the loop) drives it to converge.
 */

export type { CompareVerdict } from "./compare"
export { comparedToReference } from "./compare"
export type { ExerciseVerdict } from "./exercise"
export { inspectExerciseEvidence, isExerciseCommand, resultObservedOutput } from "./exercise"
export type {
  ConvergeBounds,
  ConvergePorts,
  ConvergeReason,
  ConvergeResult,
  FairFailSource,
} from "./loop"
export { runConvergeLoop } from "./loop"
export { buildTaintedRefs, isUnfair } from "./oracle-taint"
export type { OutputContractVerdict } from "./output-contract"
export { outputContractVerdict } from "./output-contract"
export type { SelfTestReceipt } from "./self-test"
export { inspectSelfTest, isSelfTestCommand, lastSelfTestFailure } from "./self-test"
export type { VerificationStamp, VerificationState } from "./stamp"
export { deriveVerificationState } from "./stamp"
