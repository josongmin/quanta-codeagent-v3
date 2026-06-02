# ADR-0435 — MCP crash-detection + auto-restart (exponential backoff)

**Status:** Accepted (2026-06-02)
**Type:** New capability slice — `src/mcp/reconnect/` (closed-port supervisor) + a public `onExit` on the two MCP clients + an opt-in `loadMcpTools` branch + a 1-line CLI wire. RFC: `docs/plans/jun-2-misc/01-mcp-auto-restart.md`.
**Scope:** new `src/mcp/reconnect/{policy,port,supervisor,index}.ts`; edits to `src/mcp/client.ts`, `src/mcp/isolated-client.ts`, `src/mcp/index.ts`, `src/agent/mcp-bridge.ts`, `src/agent/index.ts`, `src/apps/cli/internal.ts`. No existing behavior mutated unless `QUANTA_MCP_AUTORESTART` is set.

## Context

Today an MCP server crash is a permanent, session-wide failure. `McpClient.onTransportExit` (`client.ts`) sets `exited = true` and there is no code path that unsets it; `ensureReady` then blocks every subsequent call with `mcp server "…" is not running`. There is no re-spawn, no re-`initialize`, no re-`tools/list`. The agent bridge (`mcp-bridge.ts`) makes this worse: each bridged tool closes over a single `McpClient` instance, so once that instance dies the tool is dead for the rest of the session.

Cursor (`.extracted_source/cursor/.../mcpProcessMain.js`) solves this with a reconnect lifecycle: a two-phase capped-exponential + full-jitter backoff, a stability threshold that resets the attempt counter after a clean run, a storm cap that eventually gives up, and a connection-generation token that discards stale async reconnects. We absorb the *policy* (not Cursor's Electron UtilityProcess process isolation — quanta already isolates via its own spawn / `@/plugin-isolation`).

## Decision

Add a closed-port `McpReconnectSupervisor` that sits between the bridge and the concrete client. Bridged tools capture the **supervisor** (not a client instance) and call through `sup.callTool`, which always delegates to the *current live* client. On a transport/process exit the supervisor schedules a backoff, builds a fresh client via an injected `factory`, re-runs `start()` (`initialize` + `notifications/initialized`) and `tools/list`, then swaps the live client behind the stable `mcp__<server>__<tool>` name.

### Indirection (the core idea)

The bridge problem is the closure-captured client. The fix is one level of indirection: `mcpToolToToolSupervised(sup, def, server)` routes through the supervisor, which owns the swappable client reference. Tool names are a pure function of `(server, def.name)` (`mcpToolName`), so the same server re-advertising the same tool yields a byte-identical name across restarts.

### Closed-port / no heuristics

- `SupervisorDeps` injects `factory`, `policy`, `now`, `setTimer` (returns a cancel fn), and `random`. The supervisor core contains **no** real timers, **no** `Date.now`, **no** `Math.random` — all of which are banned in `src/` and would break the fake-clock tests. Real wiring lives only at the CLI composition root.
- Every timing constant lives in a typed `BackoffPolicy` (`DEFAULT_BACKOFF_POLICY`) where each field has a documented Cursor-traced rationale (`Dv/Nv/Fv/Uv`, `getFastRetryMaxAttempts`, `getMaxPeriodicCycles`, `getStabilityThresholdMs`). There are no magic numbers buried in the state machine.
- `backoffDelay` is byte-equivalent to Cursor `Fd`: `attempt=0` returns exactly `base` (no jitter); otherwise uniform over `[base, min(base·2^attempt, max)]`. A clamp guard keeps a pathological config (`max < base`, negative base) inside `[base, max]`.

### State machine

`healthy → (onExit) crashed → backing-off → restarting → healthy`. A failed restart increments the phase counters and re-schedules (fast phase up to `maxFastAttempts`, then periodic phase up to `maxPeriodicCycles`); exhausting both → permanent `degraded` (give-up, no more timers). The **stability reset** is lazy: on the next crash, if the server stayed up `>= stabilityThresholdMs` since its last (re)start, the counters reset so the next crash starts fresh fast-retries — no extra timer needed. `restartEpoch` (Cursor `connectionGeneration`) bumps on every restart attempt and on `stop()`; a late async `start()` whose epoch no longer matches is discarded and its orphan client stopped.

### Pending-call policy

Default **fail-fast**: when not HEALTHY, `callTool` throws the same `mcp server "…" is not running` error today's callers already see — so the model's recovery path is unchanged whether or not auto-restart is on. Opt-in **queue** mode (`pendingPolicy:"queue"` + `queueWaitMaxMs>0`) parks the caller up to `queueWaitMaxMs` for HEALTHY recovery before issuing the call (at-most-once: it waits *before* anything goes on the wire, never re-sends a fired call — tool/call is non-idempotent). DEGRADED fails immediately, no wait.

### Default-OFF / byte-identical

- `loadMcpTools(servers)` with no `supervisorDepsFor` runs the original single-client branch verbatim.
- `McpClient.onExit` / `IsolatedMcpClient.onExit` fan out to a `Set` of subscribers; with zero subscribers (no supervisor wired) the loop is a no-op and `onTransportExit`'s side effects (`exited = true`, `failAllPending`) are byte-identical to before.
- The CLI gates on `QUANTA_MCP_AUTORESTART` (`parseEnvFlag`, default `false`). Unset ⇒ `supervisorDepsFor === undefined` ⇒ original path.

## Consequences

- A crashed MCP server now self-heals within the backoff window instead of being dead for the session — directly improves long-session reliability for flaky servers.
- The `Features.mcpClients` array widens from `McpClient[]` to `McpStoppable[]` (`{ stop }`); every downstream consumer already used the structural `{ stop }` shape, so this is type-compatible.
- Non-goals (deliberate, RFC §3): no Electron-style process isolation, no remote dynamic config, no active health-probe polling, no dynamic tool re-registration. The first-load tool set is fixed at session start; a restart that drops a tool fails that call (server `-32601`) rather than mutating the registry.

### Known limitation — ADR-0431 `tasks/*` on the supervised path (follow-up)

The supervised load path (`QUANTA_MCP_AUTORESTART=1`) does NOT bridge the ADR-0431
`tasks/*` surface. `tasksToolsFor` binds a tasks handle to a concrete `McpClient`;
under auto-restart the live client is swapped behind the supervisor, so a once-bound
handle would go stale. A supervisor-aware tasks handle (re-bound on each restart,
mirroring `mcpToolToToolSupervised`) is the documented follow-up. Until then:
supervised + a tasks-advertising server ⇒ `mcp_task_*` tools are absent; plain
(non-supervised) servers keep full tasks support on the default path. Both
`tasks/*` and auto-restart are independently default-OFF, so no current default
configuration is affected.

## Evidence

- Code: `src/mcp/reconnect/{policy,port,supervisor,index}.ts`, `src/mcp/{client,isolated-client,index}.ts`, `src/agent/mcp-bridge.ts`, `src/apps/cli/internal.ts`.
- Tests (hellgate, fake clock — zero real timers): `src/mcp/reconnect/__tests__/policy.hellgate.test.ts`, `src/mcp/reconnect/__tests__/supervisor.hellgate.test.ts`, `src/agent/__tests__/mcp-autorestart-default-off.hellgate.test.ts`. Cover RFC §9 cases 1–9 including the DEFAULT-OFF byte-identical regression anchor.
- Knob: `QUANTA_MCP_AUTORESTART` (1/true/yes ⇒ on; unset ⇒ byte-identical).
- Catalog: `tools/feature-catalog/features/09-integration/0435-mcp-auto-restart.yaml`.
