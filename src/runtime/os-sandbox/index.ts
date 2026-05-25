export { compileBubblewrapArgs } from "./bubblewrap"
export { defaultOsSandbox } from "./default"
export {
  isBubblewrapAvailable,
  isLandlockAvailable,
  spawnViaBubblewrap,
  spawnViaLandlock,
} from "./landlock"
export { compileLandlockCliArgs, LANDLOCK_CLI_NETWORK_DEFERRED_MARKER } from "./landlock-cli"
export {
  detectNativeLandlock,
  mapPolicyToNapi,
  type NapiSandboxedSpawnSpec,
  type NapiSandboxPolicy,
  type NapiSpawnResult,
  type NativeLandlockBinding,
  type NativeLandlockConfig,
  nativeLandlockOsSandbox,
} from "./landlock-native"
export {
  compileLinuxSandboxArgv,
  detectLinuxSandboxBackend,
  type LinuxSandboxBackend,
  linuxOsSandbox,
} from "./linux"
// ADR-0237 — layer-owned arm `sandbox_error` (default-OFF bridge).
export type { SandboxLlmErrorKnobs, SandboxResultWithLlmError } from "./llm-error-bridge"
export {
  isSandboxDegradedFailure,
  sandboxResultToLlmError,
  withSandboxLlmErrorEmit,
} from "./llm-error-bridge"
export {
  defaultPerCallSandbox,
  type PerCallSandboxAvailability,
  type PerCallSandboxConfig,
  type PerCallSandboxPort,
} from "./per-call"
export { compileSeatbeltProfile } from "./seatbelt"
export {
  diffProfiles,
  formatDiff,
  type ProfileDiffEntry,
  type ProfileDiffResult,
} from "./seatbelt/profile-diff"
export { applyStrictKnobs, isDefaultStrict, type StrictKnobs } from "./seatbelt/strict-policy"
export { renderVerbatim, type VerbatimArm } from "./seatbelt/verbatim-profile"
export type {
  OsSandbox,
  OsSandboxConfig,
  SandboxAvailability,
  SandboxBackend,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  SandboxProfile,
  Spawner,
} from "./types"
export { OsSandboxError } from "./types"
export {
  DEFAULT_SANDBOX_EXEC_PATH,
  type WrappedShellArgv,
  type WrapShellArgvConfig,
  wrapShellArgv,
} from "./wrap-argv"
