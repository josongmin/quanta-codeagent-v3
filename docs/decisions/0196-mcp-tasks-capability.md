# ADR-0196: MCP Tasks Capability — typed long-running-task port + 3 model tools

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0049 (MCP stdio client foundation), ADR-0197 (MCP Elicitation
  7-schema sibling)
- Cross-vendor signal: Cursor 3.2.16 / Claude Desktop 1.7196.3 / Codex
  0.131.0-alpha.9 all ship a Tasks-style capability for MCP long-running
  work; absent here, models cannot poll/cancel out-of-band MCP work, only
  block on synchronous `tools/call`.

## Context

The MCP spec (rmcp 0.15, protocol 2025-06-18) defines a `tasks/*` capability
for long-running work: the server registers a task id and the client polls
`tasks/getInfo`, fetches the final payload with `tasks/getResult`, or aborts
in flight with `tasks/cancel`. Without it the only contract is the blocking
`tools/call`, which forces a server to either inline 30s+ work into a single
RPC (timing out our client at `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`) or
return a fire-and-forget acknowledgement the agent cannot reason about.

Today `src/mcp/client.ts:126` emits `capabilities: {}` on `initialize` —
the bare minimum that advertises NO optional capabilities. Servers that
support tasks therefore route every long call through `tools/call` and we
get the timeout. Adding capability negotiation without a port would also
force every test that constructs `McpClient` to thread the same literal,
so the capability set is a closed-port behind a `CapabilityNegotiator`
seam (default-impl = `{}` for byte-identical legacy behavior, full-impl
= `{ tools, sampling, elicitation, tasks }` swapped at the composition
root by env knob).

The TaskState union is the 5-arm rmcp enum
(`pending | in_progress | completed | failed | cancelled`); a 6th arm would
be an MCP spec change, not a quanta change.

External SDK reason-for-rejecting: installs are blocked in this
environment; the rmcp TypeScript bindings would add a 2 MB transitive
graph for the seven methods this slice actually wires
(`tasks/{list,getInfo,getResult,cancel}` + the four capability flags).
The self-impl is one file per port + one file per method.

## Decision

Ship three closed-ports + one capability negotiator:

1. **`@/mcp/capabilities`** — `CapabilityNegotiator` with two impls:
   - `defaultNegotiator` → `compile() === {}` (byte-identical with today)
   - `fullNegotiator()` → `{ tools: {}, sampling: {}, elicitation: {},
     tasks: { listChanged: false } }` for servers that advertise the
     features. Serialization is JSON-canonical (sorted keys) so the on-wire
     bytes are deterministic per impl.

2. **`@/mcp/tasks`** — `McpTasksPort` typed with the 4 rmcp methods
   (`list` with cursor pagination, `getInfo`, `getResult`, `cancel`) +
   in-memory `DefaultTaskStore` (FIFO eviction at `MAX_TASKS = 256`) +
   `pollTask(taskId, signal)` helper that loops `getInfo` until terminal
   state, surrendering on `signal.aborted` without leaking the
   subscription.

3. **`@/tool/mcp_tasks`** — three model tools (`list_mcp_tasks`,
   `get_mcp_task`, `cancel_mcp_task`) backed by a duck-typed
   `TasksHandle` (mirror of `McpTasksPort` declared in the tool slice to
   honor the `@/tool` may-not-import `@/mcp` fence). Each tool is
   read-only EXCEPT `cancel_mcp_task` which is concurrency-unsafe and
   tier-`always-confirm`.

4. Wire: `src/mcp/client.ts:126` replaces the literal `{}` with
   `negotiator.compile()`. `src/apps/agent/index.ts` picks
   `defaultNegotiator` when `QUANTA_MCP_CAPS` is absent / not `"full"`,
   `fullNegotiator()` when it equals `"full"`. The tasks tools register
   only when the apps layer wires the port (mirroring
   `shadow*`/`branch_search` caller-wired pattern).

## Consequences

- **Default-OFF + byte-identical**: every existing call site that does
  not opt into `QUANTA_MCP_CAPS=full` and does not register tasks tools
  sees the original `{}` capabilities and zero new dispatch surface.
- **`exactOptionalPropertyTypes`**: optional fields on capability + task
  result shapes are OMITTED (never `field: undefined`).
- **Slice fence**: `@/tool/mcp_tasks` ducks the port via a local mirror;
  the wire bridge in `src/apps/agent/` adapts the concrete `McpTasksPort`
  to the mirror. `@/mcp` depends only on `@/shared`.
- **Future swap**: if rmcp TS bindings become installable, the seam is
  a single-file swap (`@/mcp/tasks` adopts the rmcp types) — every other
  slice keeps the duck-typed mirror unchanged. Sibling ADR future scope.
