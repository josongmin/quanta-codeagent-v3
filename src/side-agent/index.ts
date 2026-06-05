/**
 * `@/side-agent` — N1 background side-agent daemon (RFC
 * `docs/plans/jun-4-background-side-agent.md`). Phase-1 pure leaf: the
 * supervise-loop registry over injected ports. Default-OFF by construction —
 * nothing imports this unless the host opts in behind `QUANTA_SIDE_AGENT`.
 */

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
