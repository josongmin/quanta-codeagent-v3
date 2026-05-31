/**
 * ADR-0288/0289 — Remote runner slice barrel.
 *
 * Public surface for the remote execution plane. Default-OFF: importing
 * this barrel does NOT instantiate any adapter — the registry returns
 * `null` when `QUANTA_REMOTE_RUNNER` is unset / `"none"` (HELL-RR-08).
 *
 * Slice discipline: `@/remote` is a LEAF slice. The composition root in
 * `src/apps/agent/index.ts` and `src/apps/cli/remote-cmd.ts` is the ONLY
 * caller that wires concrete adapters; library slices stay byte-identical
 * regardless of the registry state.
 */

export type { RemoteRunner } from "./port"
export {
  ALL_REMOTE_BACKENDS,
  ALL_REMOTE_ERROR_KINDS,
  ALL_REMOTE_STATUS_KINDS,
  RemoteError,
} from "./types"
export type {
  RemoteBackend,
  RemoteErrorKind,
  RemoteHandle,
  RemoteLogsOpts,
  RemoteMount,
  RemoteSpec,
  RemoteStatus,
  RemoteStatusKind,
} from "./types"
export { validateSpec } from "./validate"
export { createHeadlessRunner } from "./headless-stub"
export type { HeadlessRunnerOpts } from "./headless-stub"
export {
  classifyDockerStderr,
  composeDockerRunArgv,
  createDockerAdapter,
  parseDockerInspectLine,
} from "./docker-adapter"
export type {
  DockerAdapterOpts,
  DockerExecResult,
  DockerLogStream,
  DockerProcess,
} from "./docker-adapter"
export {
  composeLimaCancelArgv,
  composeLimaSpawnArgv,
  composeLimaStatusArgv,
  createLimaAdapter,
  safeLimaId,
} from "./lima-adapter"
export type { LimaAdapterOpts, LimaExecResult, LimaProcess } from "./lima-adapter"
export { createAppleVZAdapter } from "./apple-vz-adapter"
export type { AppleVZAdapterOpts, AppleVZHost } from "./apple-vz-adapter"
export { parseRemoteRunnerEnv, selectRemoteRunner } from "./registry"
export type { RemoteRunnerName, RemoteRunnerSeams } from "./registry"
