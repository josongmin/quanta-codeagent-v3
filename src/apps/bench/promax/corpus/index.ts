/**
 * PMX-02 — the ONE ProMax corpus surface.
 *
 * Import discipline (this is the boundary, so state it where it is enforced):
 *  - AGENT-side code imports `readProMaxCorpusRows` / `readProMaxPublicTasks`
 *    and the {@link PromaxAgentTaskView} type. Nothing else.
 *  - The HARNESS adapter imports `openProMaxGraderBundle` and
 *    {@link PromaxGraderTaskView}. Nothing else.
 *  - Trusted PREPARATION (the operator tool) is the only caller of
 *    `decodeProMaxOfficialCorpus` / `buildProMaxArtifacts`, because it is the
 *    only place a row with its gold still attached legitimately exists.
 */
export {
  type BuildProMaxArtifactsInput,
  buildProMaxArtifacts,
  canonicalJson,
  ProMaxArtifactError,
  type ProMaxArtifacts,
  parseProMaxGraderBundleArtifact,
  parseProMaxPublicTasksArtifact,
  proMaxContentDigest,
  serializeProMaxGraderBundle,
  serializeProMaxPublicTasks,
} from "./artifacts"
export {
  decodeProMaxOfficialCorpus,
  type ProMaxCorpusBytes,
  type ProMaxCorpusDecode,
  type ProMaxDecodedCorpus,
  type ProMaxRejectedCorpus,
} from "./decode"
export { openProMaxGraderBundle, type ProMaxGraderBundle } from "./grader-bundle"
export {
  assertGraderBundleOutsideAgentRoot,
  openProMaxGraderBundleDir,
  type ProMaxArtifactPaths,
  readProMaxPublicTasksFile,
  type WriteProMaxArtifactsInput,
  writeProMaxArtifacts,
} from "./layout"
export {
  type ProMaxPublicRow,
  readProMaxCorpusRows,
  readProMaxPublicTasks,
} from "./public-reader"
export {
  PROMAX_SAMPLE_ENV,
  type ProMaxSampleSelectionInput,
  parseProMaxSampleManifest,
  selectProMaxSampleIds,
} from "./sample-select"
export {
  type BuildProMaxSampleFamilyInput,
  buildProMaxSampleFamily,
  buildProMaxSampleManifest,
  PROMAX_DEFAULT_SAMPLE_SEED,
  PROMAX_SAMPLE_ALGORITHM_VERSION,
  PROMAX_SAMPLE_SPECS,
  type ProMaxSampleCandidate,
  ProMaxSampleError,
  type ProMaxSampleManifest,
  type ProMaxSampleSpec,
  proMaxSampleManifestDigest,
} from "./samples"
export {
  PROMAX_GRADER_BUNDLE_DIR,
  PROMAX_GRADER_TASKS_FILE,
  PROMAX_PUBLIC_TASKS_FILE,
  type PromaxAgentTaskView,
  type PromaxArtifactSource,
  type PromaxGraderBundleArtifact,
  type PromaxGraderTaskView,
  type PromaxPublicTasksArtifact,
} from "./types"
