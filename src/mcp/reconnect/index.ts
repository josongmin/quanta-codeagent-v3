/** MCP auto-restart supervisor (ADR-0435) — leaf barrel.
 *
 *  Selective re-export. Default-OFF: nothing here runs unless the composition
 *  root injects `SupervisorDeps` (gated by `QUANTA_MCP_AUTORESTART`). */

export {
  type BackoffPolicy,
  backoffDelay,
  DEFAULT_BACKOFF_POLICY,
} from "./policy"
export type { McpClientFactory, SupervisableMcpClient } from "./port"
export {
  McpReconnectSupervisor,
  type PendingPolicy,
  type SupervisorDeps,
  type SupervisorSnapshot,
  type SupervisorState,
} from "./supervisor"
