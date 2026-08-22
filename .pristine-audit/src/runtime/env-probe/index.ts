/**
 * Startup environment-probe slice barrel (ADR-0466).
 *
 * Faithful absorption of Cursor's CloudAgentStartupWarning / CloudSetupBlocker:
 * a read-only toolchain probe that surfaces graceful-degradation warnings at
 * session start so the agent ADAPTS instead of blindly invoking missing tools.
 *
 * Slice: @/runtime (may import @/storage, @/shared). This barrel re-exports
 * pure types + the pure runner + the closed check list. The real exec adapter
 * (shelling out for `--version`) and the gate read (`QUANTA_ENABLE_ENV_PROBE`)
 * are wired at the composition root — NOT here.
 *
 * Default-OFF: nothing in @/apps or @/agent imports this barrel today. When a
 * surface DOES wire it, `runEnvProbe(exec, { enabled })` with `enabled !== true`
 * returns `[]` without touching the exec port — byte-identical to no probe.
 */

export {
  CORE_CHECKS,
  degradationHint,
  deriveManifest,
  type RawProjectSignals,
  testRunnerChecks,
} from "./checks"
export { type ProbeOpts, runEnvProbe } from "./probe"
export {
  ALL_WARNING_KINDS,
  type ProbeCheck,
  type ProbeExecError,
  type ProbeExecPort,
  type ProbeExecResult,
  type ProjectManifest,
  type StartupWarning,
  type WarningKind,
  type WarningSeverity,
} from "./types"
