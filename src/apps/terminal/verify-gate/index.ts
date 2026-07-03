/**
 * `@/apps/terminal/verify-gate` — the terminal "verify-before-finalize" evidence inspector
 * (Lever #2, RFC `jul-2-terminal-bench-levers/02`). BARREL: the module was split from a single
 * 1000+-line god-module into a layered set so each classifier is small and the no-leak SSOT
 * (`oracle-taint`) is shared by construction — a classifier physically cannot ship its own weaker
 * oracle check (the jul-3 hell-audit F2 root cause). Consumers import from `./verify-gate` unchanged.
 *
 * Layers (dependency order): tokenize → exercise → oracle-taint → compare / output-contract /
 * self-test → stamp.
 *
 * PURE / LEAF throughout. No model calls, no IO, no `process.*`. Input is the captured `AgentEvent[]`;
 * output is a small typed verdict. The dominant Terminal-Bench failure (~70%) is "fake green": the
 * agent claims done but never checked its deliverable against spec — this gate answers, fail-closed,
 * whether the trajectory actually RAN (L0) and COMPARED (L1) the deliverable against a fair reference.
 */

export type { CompareVerdict } from "./compare"
export { comparedToReference } from "./compare"
export type { ExerciseVerdict } from "./exercise"
export { inspectExerciseEvidence, isExerciseCommand, resultObservedOutput } from "./exercise"
export { buildTaintedRefs, isUnfair } from "./oracle-taint"
export type { OutputContractVerdict } from "./output-contract"
export { outputContractVerdict } from "./output-contract"
export type { SelfTestReceipt } from "./self-test"
export { inspectSelfTest, isSelfTestCommand } from "./self-test"
export type { VerificationStamp, VerificationState } from "./stamp"
export { deriveVerificationState } from "./stamp"
