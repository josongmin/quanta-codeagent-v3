export { compileBubblewrapArgs } from "./bubblewrap"
export { type DefaultOsSandboxConfig, defaultOsSandbox } from "./default"
export { resolveSandboxProfileFromEnv, SANDBOX_DEFAULT_FLIP_PROFILE } from "./env"
// RFC jun-6 — sandbox-block discriminant classifier (pure, default-OFF).
export { classifySandboxDenial } from "./denial-classify"
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
// RFC jun-6 — sibling `sandbox_blocked` converter (block vs degrade).
export type { SandboxLlmErrorKnobs, SandboxResultWithLlmError } from "./llm-error-bridge"
export {
  isSandboxBlockedFailure,
  isSandboxDegradedFailure,
  sandboxBlockToLlmError,
  sandboxResultToLlmError,
  withSandboxLlmErrorEmit,
} from "./llm-error-bridge"
export {
  defaultPerCallSandbox,
  type PerCallSandboxAvailability,
  type PerCallSandboxConfig,
  type PerCallSandboxPort,
} from "./per-call"
// DOF-40 — fail-closed refusal for a requested-but-unavailable sandbox.
export { SANDBOX_UNAVAILABLE_EXIT_CODE, sandboxUnavailableRefusal } from "./refusal"
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
  SandboxDenial,
  SandboxDenialSignal,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  SandboxProfile,
  Spawner,
} from "./types"
export { OsSandboxError } from "./types"
// ADR-0441 — Windows broker-helper backend (pure compiler + native boundary).
export {
  compileWindowsSandboxSpec,
  serializeWindowsSpec,
  type WindowsSandboxSpec,
} from "./windows"
export {
  detectNativeWindows,
  type NativeWindowsConfig,
  type NativeWinResult,
  type NativeWinSpec,
  nativeWindowsOsSandbox,
  type WindowsSandboxBinding,
} from "./windows-native"
export {
  DEFAULT_SANDBOX_EXEC_PATH,
  type WrappedShellArgv,
  type WrapShellArgvConfig,
  wrapShellArgv,
} from "./wrap-argv"
