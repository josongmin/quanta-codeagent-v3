# ADR-0391 — MCP client transport port + stdio extraction + Streamable-HTTP/SSE carrier

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0196 (capability negotiator), ADR-0162 Phase E
(`IsolatedMcpClient` spawner DI — sibling DI pattern)
**Slice:** `src/mcp/` (`transports/{port,stdio,http-sse}.ts` new; `client.ts`,
`types.ts`, `index.ts` touched).
**Default-OFF / byte-identical:** Yes — a config without `url` and without an
explicit `transport` opt selects the stdio carrier, which is a verbatim
extraction of the prior inline `Bun.spawn` + `stdin.write` + stdout-pump +
`proc.exited` logic. Every existing command-based server keeps byte-identical
wire behavior.

## Context

`src/mcp/client.ts` hard-coded stdio in four places:

- `start()` — `Bun.spawn` with stdin/stdout/stderr pipes.
- `send()` — `this.proc.stdin.write(encodeMessage(...))`.
- `pumpStdout()` — `for await (chunk of stdout)` → `LineReader.push`.
- `stop()` / `watchExit()` — `proc.exited` for teardown + fail-all-pending.

The JSON-RPC core (request/response correlation by incrementing id, per-request
timeout, `dispatch`, `pending` map, fail-all-pending on exit) is already
carrier-agnostic — but it was structurally welded to a subprocess. There was no
way to talk to a remote MCP server over HTTP (the MCP "Streamable HTTP"
transport, spec rev 2025-03-26), which is the standard carrier for hosted MCP
servers.

`src/mcp/jsonrpc.ts` (`encodeMessage` + `LineReader`) was already
transport-agnostic and is unchanged.

## Decision

Introduce a transport port and move all carrier coupling behind it; keep the
client core untouched.

### 1. `transports/port.ts` — `McpTransport`

```typescript
interface McpTransport {
  start(): Promise<void>
  onMessage(handler: (m: JsonRpcMessage) => void): () => void
  onExit(handler: (reason?: string) => void): () => void
  send(payload: unknown): Error | null   // never throws; returns enqueue error or null
  close(): Promise<void>
}
```

`send` returns an `Error | null` (never throws) so the client's existing
immediate-failure path (reject the pending slot, clear the timer) is preserved
verbatim. The transport owns *framing* — it receives a structured payload and
hands back already-decoded `JsonRpcMessage` values, so `encodeMessage` /
`LineReader` coupling moves *into* the transport instead of leaking into the
client.

### 2. `transports/stdio.ts` — `StdioMcpTransport`

Verbatim extraction of the four stdio sites. `buildEnv` (PATH-only inheritance,
no parent-env leak) moved here unchanged. A `spawn` seam (default `Bun.spawn`)
lets tests drive the pump/exit without a real subprocess. `onExit` fires
exactly once. Error message strings (`"transport unavailable: stdin closed"`,
`"transport write failed: ..."`) are preserved so existing assertions hold.

### 3. `transports/http-sse.ts` — `HttpSseMcpTransport`

MCP Streamable-HTTP carrier:

- Outbound: each message `POST`ed to the single endpoint URL with
  `Accept: application/json, text/event-stream`. Server may answer with a
  single JSON body, an SSE stream, or `202 Accepted` (notifications).
- Inbound (server-initiated): optional standalone `GET` SSE channel
  (`openServerStream`, default on; `405` ⇒ POST-only, spec-legal).
- Session: a server-assigned `Mcp-Session-Id` response header is captured and
  echoed on every subsequent request; `close()` best-effort `DELETE`s it.
- A `fetch` seam (default global `fetch`) makes the carrier fully testable
  without a network. SSE `data:` framing + a fail-closed JSON-RPC envelope
  check (mirroring `LineReader`'s `isValidEnvelope`) drop hostile/malformed
  payloads.

`send` keeps the sync `Error | null` contract: the POST is launched in the
background, replies surface via `onMessage`, and the client's per-request
timeout is the backstop for a POST that never answers.

### 4. `client.ts` — inject transport, core unchanged

The constructor gains an optional `transport` in `opts` (sibling to the
existing optional `negotiator`):

```typescript
type McpClientTransport = McpTransport | ((config: McpServerConfig) => McpTransport)
constructor(config, opts?: { negotiator?; transport?: McpClientTransport })
```

Selection: explicit instance > factory > default. The default is stdio, or
HTTP-SSE when `config.url` is set. The `proc` field is gone; `start()` wires
`transport.onMessage(dispatch)` + `transport.onExit(onTransportExit)` and
`request`/`notify` call `transport.send`. **`request` / `dispatch` / `pending` /
timeout / `takePending` / `failAllPending` are byte-identical to pre-ADR.**

### 5. `types.ts` — opt-in HTTP fields

`McpServerConfig` gains optional `url` + `headers` (HTTP carrier only).
Absent ⇒ stdio default.

## Why the stdio default keeps byte-identity

The stdio path is a code *move*, not a rewrite: same `Bun.spawn` options, same
`buildEnv`, same `encodeMessage` bytes (proven byte-for-byte in the hellgate),
same `LineReader`, same `proc.exited` teardown, same error strings. The client
core never changed. The pre-existing integration suite
(`tests/integration/mcp-client.test.ts`, real subprocess) passes unchanged.

## Slice fence

`src/mcp/transports/port.ts` mirrors the *shape* of `@/ipc`
`SessionTransport` (send/onMessage/close) but MUST NOT import it — IPC and MCP
stay decoupled (RFC §3.1). The mirror is deliberate convergence, not a
dependency. `transports/stdio.ts` is added to the `mcp` slice
`envAllowFiles` (it reads `process.env.PATH` in `buildEnv`, exactly as
`client.ts` previously did).

## Files

- `src/mcp/transports/port.ts` — `McpTransport` + handler types (new).
- `src/mcp/transports/stdio.ts` — `StdioMcpTransport`, verbatim extraction
  with a `spawn` seam (new).
- `src/mcp/transports/http-sse.ts` — `HttpSseMcpTransport`, Streamable-HTTP +
  SSE with a `fetch` seam (new).
- `src/mcp/client.ts` — `proc` removed, transport injected, core unchanged.
- `src/mcp/types.ts` — `McpServerConfig` gains `url` + `headers`.
- `src/mcp/index.ts` — export the transport surface + `McpClientTransport`.
- `tests/unit/_arch/slice-boundary-configs.ts` — `stdio.ts` added to mcp
  `envAllowFiles`.
- `tests/unit/mcp-client-errors.test.ts` — probe re-pointed from the old
  `proc` internal to the `StdioMcpTransport` seam (same observable contracts).
- `tests/unit/mcp/transport-port-hellgate.test.ts` — new hellgate.

## Hellgate

`bun test tests/unit/mcp/transport-port-hellgate.test.ts` ⇒ default-stdio
selection, `url`-selects-HTTP, factory/instance injection, core unchanged
(handshake routing / id correlation / exit-fails-pending / send-error rejects),
stdio byte-identity (encodeMessage bytes, stdin-closed, write-throw, coalesced
chunks, single exit), and HTTP-SSE roundtrip (POST+JSON, POST+SSE,
session-id echo, post-close error, DELETE-on-close, malformed-data drop,
non-jsonrpc reject, full client start+listTools).

Full mcp suite (`tests/unit/mcp*`, `tests/unit/mcp/`,
`tests/integration/mcp-client.test.ts`, plugin-isolation + composition wire)
⇒ 169 pass / 0 fail.

## Non-goals

- Wiring HTTP-SSE config into the composition root / CLI surface. The carrier
  exists and is unit-proven; surface wiring is a follow-up (default stays
  stdio, so this ADR ships zero behavior change for current deployments).
- OAuth / auth-header acquisition for HTTP servers. `headers` is a static
  pass-through; token refresh is out of scope.
- Reconnect / resumable SSE (`Last-Event-ID`). The spec allows it; not needed
  for the first cut.

## References

- ADR-0196 — capability negotiator (sibling optional-opt pattern).
- ADR-0162 Phase E — `IsolatedMcpClient` spawner DI (sibling carrier-DI).
- MCP spec "Streamable HTTP" transport, rev 2025-03-26.
