# ADR-0431 — MCP tasks live binding (outbound `tasks/*` dispatch + composition-root wiring)

Status: accepted (2026-06-02)

## Context

ADR-0196 shipped the full MCP `tasks/*` surface as a closed-port slice but left it **inert**:
- `src/mcp/tasks/{port,types,default-store,poller}.ts` — the `McpTasksPort` contract + an in-memory `defaultTasksPort` + a poller.
- `src/tool/mcp_tasks/{list_tasks,get_task,cancel_task}.ts` + `mcpTasksTools(handle)` — the three model-facing tools over a duck-typed `TasksHandle`.

But nothing connected them to a live server:
- `src/mcp/client.ts` had **zero** `tasks/*` JSON-RPC dispatch — only the inbound `elicitation/create` router (`routeElicitation`, the wired sibling).
- `mcpTasksTools()` was never called at any composition root — `loadMcpTools` (`src/agent/mcp-bridge.ts`) wired only `tools/*`.
- The `initialize` response was discarded, so the client could not tell whether a server even advertised the `tasks` capability.

## Decision

Bring the surface live, mirroring the elicitation pattern but for OUTBOUND requests.

1. **`McpClient` (`src/mcp/client.ts`)**
   - Capture the server's advertised `capabilities` from the `initialize` result; expose `serverSupportsTasks(): boolean` (true iff `capabilities.tasks` is an object). `false` before `start()` / when absent.
   - Add a generic public `requestRaw(method, params?): Promise<unknown>` — the outbound mirror of the inbound elicitation router. It goes through the same correlated `request`/timeout/pending core as `tools/call`, so transport errors (exit, timeout) reject with `McpError`. The per-method response codec lives in the tasks adapter, not the transport core.

2. **`clientTasksPort` (`src/mcp/tasks/client-port.ts`)** — the wired sibling of `defaultTasksPort`. Dispatches `tasks/list` / `tasks/getInfo` / `tasks/getResult` / `tasks/cancel` via `client.requestRaw` and parses the raw results into the typed `McpTasksPort` outcomes. Accepts both `state` and `status` field names. **Contract:** a transport error PROPAGATES; a malformed-but-successful response maps to the conservative typed outcome (`list`→`cursor-stale`, `getInfo`→`null`, `getResult`→`not-ready`, `cancel`→`not-found`) so a buggy/hostile server can never crash the model loop.

3. **Composition-root wiring (`loadMcpTools`)** — after `tools/list`, when `client.serverSupportsTasks()` is true, adapt `clientTasksPort(client)` into the duck-typed `TasksHandle` (the two shapes are structurally identical; the assignment proves it at compile time — the slice fence forbids `@/tool` importing `@/mcp`) and push `mcpTasksTools(handle)`.
   - **Default-OFF**: a server that does not advertise `tasks` adds NO tools — byte-identical to before this binding. Added an optional `opts.transportFor` test seam (mirrors `McpClient`'s `transport` option).

## Consequences

- The model can list / inspect / cancel long-running MCP tasks against any server that advertises the capability; the poller (`pollTask`) drives terminal-state waits over the live port.
- Orthogonal to elicitation (ADR-0197) and the in-memory store (`defaultTasksPort`, kept for test harnesses).
- 12-case hellgate (`tests/unit/mcp/tasks-live-binding-hellgate.test.ts`) with a scripted in-memory JSON-RPC transport: list/getInfo/getResult/cancel round-trips, malformed→typed-`ok:false`, RPC timeout→reject, capability-gated registration (absent⇒byte-identical), poller integration.

> ADR number: `0431` is next-free after `0429`/`0430`. No collision with the ADR-0196 sibling (that one stays).
