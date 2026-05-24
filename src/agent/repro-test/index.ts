/**
 * Repro-test slice — Agentless paper §3.3.1 absorption.
 *
 * Pipeline: `generateReproTests` (LLM × K) → `executeReproTests`
 * (Python on original repo) → `selectReproTest` (majority vote among
 * "reproduced" outcomes). The bench driver wires this behind a default-OFF
 * env gate (`QUANTA_BENCH_REPRO_TEST=K`) — byte-identical measurement when
 * the flag is unset.
 */

export {
  classifyStdout,
  DEFAULT_EXEC_TIMEOUT_MS,
  type ExecuteReproTestsArgs,
  executeReproTests,
  type ReproExecPort,
  type ReproWriteFilePort,
} from "./execute"
export {
  buildReproTestPrompt,
  DEFAULT_SAMPLES,
  DEFAULT_TIMEOUT_MS,
  generateReproTests,
  MAX_SAMPLES,
  stripMarkdownFences,
} from "./generate"
export {
  normaliseReproSource,
  selectReproTest,
  stripPythonComments,
} from "./select"
export type {
  ReproTestConfig,
  ReproTestOutcome,
  ReproTestSample,
  ReproTestSelection,
} from "./types"
