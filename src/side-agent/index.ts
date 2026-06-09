/**
 * `@/side-agent` — N1 background side-agent daemon (RFC
 * `docs/plans/jun-4-background-side-agent.md`). Phase-1 pure leaf: the
 * supervise-loop registry over injected ports. Default-OFF by construction —
 * nothing imports this unless the host opts in behind `QUANTA_SIDE_AGENT`.
 */

export {
  backoffForAttempt,
  type ChildProcessHandle,
  createSupervisedProcessDaemon,
  type DelayScheduler,
  type ProcessForkPort,
  type ProcessForkSpec,
  type SideAgentIpcMessage,
  type SupervisedDaemonStatus,
  type SupervisedProcessDaemon,
  type SupervisedProcessDaemonOpts,
} from "./process"
export {
  createProcessSideAgentDaemonRegistry,
  type ProcessSideAgentRegistryOpts,
} from "./process-registry"
export { createSideAgentDaemonRegistry } from "./registry"
export {
  type SideAgentDaemonOpts,
  type SideAgentDaemonRegistry,
  SideAgentError,
  type SideAgentErrorCode,
  type SideAgentEventSourcePort,
  type SideAgentFinding,
  type SideAgentMailboxPort,
  type SideAgentRunnerPort,
  type SideAgentSinkPort,
  type SideAgentSnapshot,
  type SideAgentSpec,
  type SideAgentStatus,
  type SideAgentTrigger,
} from "./types"
