/**
 * `apps/bench/corpus` — corpus loaders, dataset adapters, cache-pathspec SSOT,
 * failure classifier, and persistent bench paths.
 *
 * This is the slice the eval/ driver + the CLI entry consume. Public names +
 * exports are byte-identical to the pre-decompose modules; only their import
 * locations moved.
 */
export {
  CACHE_PATH_RE,
  CACHE_PATHSPECS,
  DEFAULT_CACHE_DIR_NAMES,
  getCachePathRe,
  getCachePathspecs,
} from "./cache-pathspecs"
export {
  defaultExec,
  type Exec,
  type ExecResult,
  type Prediction,
  parseSwebenchJsonl,
  prepareTaskRepo,
  type SwebenchTask,
  toInstance,
  writePredictions,
} from "./dataset"
export {
  aggregate,
  classify,
  type FailureBreakdown,
  type FailureClassification,
  type FailureSignal,
  type TerminationType,
} from "./failure-classifier"
export { loadCorpus, writeSyntheticCorpus, writeSyntheticRealCorpus } from "./loader"
export { benchHome, benchRunDir, benchRunId, benchRunsRoot, benchWorkRoot } from "./paths"
