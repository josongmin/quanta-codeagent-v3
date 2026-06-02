/** ADR-0431 / ADR-0435 — the minimal outbound-RPC surface the `tasks/*` adapter
 *  needs. Both `McpClient` (default path) and `McpReconnectSupervisor` (the
 *  auto-restart path, which re-resolves its live client per call) satisfy it.
 *
 *  Decoupling the parse-codec (`tasksPortOver`) from the concrete transport is
 *  what lets the SAME parsing logic back both a mortal single client and a
 *  supervisor that swaps its underlying client across restarts — the supervisor
 *  variant never captures a client, it dispatches each request through this
 *  surface, which always reaches the CURRENT live client. */
export interface TasksRpc {
  /** Dispatch a single outbound JSON-RPC request and return the raw `result`.
   *  Transport errors (process exit, RPC timeout) reject — same contract as
   *  `tools/call`. */
  requestRaw(method: string, params?: unknown): Promise<unknown>
}
