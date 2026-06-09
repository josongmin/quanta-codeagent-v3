# ADR-0520: Reverse-MCP (TICKET-19) — expose quanta AS an MCP server over stdio with a read-only-by-default RCE fence

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - ADR-0391 (MCP client transport port + stdio/HTTP-SSE) — the OUTBOUND direction (`McpClient` SPEAKS to a server). This ADR is the INVERSE: `McpServer` LISTENS. The two share the `@/mcp/jsonrpc.ts` newline-delimited codec (`encodeMessage` / `LineReader`) but NOT the `Stdio`/`HttpSse` transports — those are client-shaped (spawn/connect outward) and are not reusable as a server listener.
  - ADR-0471 (untrusted-source result envelope) — the dispatch-seam defang the folded `dispatchTool` path inherits; reverse-MCP adds no bespoke security wiring on the result path, it reuses the locked pipeline.
  - ADR-0303 (thin-surface) — `assembleAgentConfig` + the headless arg-builders live in `@/host/runtime`; the reverse-MCP composition root reaches them there, and `dispatchTool` via the deep `@/agent/dispatch` specifier.
- **참조**:
  - `src/mcp/server.ts` — `McpServer`: the inbound JSON-RPC dispatcher. Owns its own stdin/stdout pump (`feed` → `LineReader` → `handle` → `route`), the `tools/list` projection (server-minted + validated cursor, `parseCursor` loop-guard), the `tools/call` whitelist re-check + folded dispatch, the `drain()` of in-flight async dispatches, and the `MAX_RESULT_CHARS = 1_000_000` wire-frame cap. NO-THROW pump (`handle` catch ⇒ `-32603`; `send` swallows a broken stdout).
  - `src/mcp/server-builder.ts` — `buildMcpServer`: the PURE security boundary. Computes the whitelist ONCE as `{ tools where readOnly(name) } ∪ explicitOptIn`, intersected with the registry's actual `specs()` so an unknown opt-in name is silently dropped (can never widen). Duck-typed `ToolListSource` / `ToolCallPort` ports — the `@/mcp` slice imports neither `@/agent` nor `@/tool`.
  - `src/apps/cli/mcp-server-setup.ts` — `runMcpServerCmd`: the composition root (the ONLY place `@/agent` + `@/mcp` meet). Owns the strict gate, `--help`, the `QUANTA_MCP_SERVER_EXPOSE` validation, the fail-closed `{ mode: "default" }` permission posture, the folded `dispatchTool` adapter, the stdin pump + SIGINT/SIGTERM abort + post-EOF `drain()`.
  - `src/apps/cli/index.ts` (`process.argv[2] === "mcp-server"` route) — the live entry: dynamic-import + `process.exit(await runMcpServerCmd(...))`.
  - `src/apps/cli/cli-knobs.ts` — `QUANTA_MCP_SERVER` (bool, strict, default false) + `QUANTA_MCP_SERVER_EXPOSE` (string, default "") registered in the `mcp` knob group.
  - Tests: `src/mcp/__tests__/server.test.ts`, `src/mcp/__tests__/server-builder.test.ts`, `src/apps/cli/__tests__/mcp-server-setup.hellgate.test.ts`.

## 맥락

quanta already SPEAKS MCP outward (ADR-0391: `McpClient` connects to external servers and calls their tools). The inverse — letting an EXTERNAL MCP host (Claude Desktop, Cursor, any MCP client) call quanta's OWN tools — was unbuilt. TICKET-19 fills it: `quanta mcp-server` makes quanta an MCP server over newline-delimited JSON-RPC on stdin/stdout.

The defining constraint is that this is an **RCE surface**. The moment an external client can drive `tools/call`, an unguarded `bash`/`write` exposed on the wire is remote code execution against the operator's machine. So the design is fail-closed at every layer, and the security fence must be small enough to unit-test in isolation.

A second constraint is the `@/mcp` slice fence: `@/mcp` may import neither `@/agent` nor `@/tool`. The server + builder therefore take duck-typed ports; the real `dispatchTool` + `ToolRegistry` are bound only at the apps-layer composition root.

## 결정

**Three-layer split with the security fence as a TINY PURE function.**

1. **`buildMcpServer` (pure, `server-builder.ts`) is the whitelist.** It computes `exposed = { specs() names where readOnly(name) } ∪ explicitOptIn`, but ONLY over names that actually exist in `specs()` — an opt-in name absent from the registry is dropped by construction (the `.filter` only ever sees real tools). No IO, no env, no clock: the frozen set is the single SSOT both `tools/list` projection and the `tools/call` admit-check consult, so there is no second code path that could disagree. Default-OFF for danger: with no `explicitOptIn`, only read-only tools are reachable.

2. **`McpServer` (`server.ts`) is the no-throw inbound pump.** It services `initialize` / `notifications/initialized` / `tools/list` / `tools/call`; `tools/list` projects ONLY whitelisted tools with a SERVER-MINTED, validated pagination cursor (`parseCursor` rejects any non-minted or out-of-range cursor as `-32602`, so a client can never drive an infinite re-page); `tools/call` RE-CHECKS the whitelist before dispatch — a non-whitelisted name is `-32602` and the `ToolCallPort` is NEVER invoked. The pump never throws: a routing fault is caught and answered `-32603` (if there was an id), a write fault is swallowed, and async dispatches are TRACKED in `inflight` so `drain()` can await them on shutdown (an FS effect must settle before the command returns). Results are capped at `MAX_RESULT_CHARS` with a visible truncation marker (local cap — the slice fence forbids reaching into `@/tool`'s spill constants).

3. **`runMcpServerCmd` (`mcp-server-setup.ts`) is the composition root + the live permission posture.** Order is security-deliberate: `--help` returns BEFORE any gate/assembly; the **strict** `gateOnStrict(env, 'QUANTA_MCP_SERVER')` (exact `=== '1'`; a loose `on`/`true` is REFUSED) is checked BEFORE any agent assembly so gate-off does ZERO work and stdout stays empty; only then is `@/host/runtime` + `@/agent/dispatch` dynamic-imported and a headless config assembled. The folded `ToolCallPort` runs the REAL `dispatchTool` under an EXPLICIT `{ mode: "default" }` permission context — NOT the headless `acceptEdits` the assembler resolves, which would auto-allow mutating tools and re-open the RCE. Under `"default"`, read-only tools are allowed, HARD_DENY shell is denied, and every mutating tool is `ask` → with no reviewer port wired, `ask` collapses to a hard DENY. So a force-opted-in `write` still APPEARS in `tools/list` but every call returns `isError` and never touches disk. stdout is PURE JSON-RPC; the start banner + every diagnostic go to STDERR only. NO-THROW boundary: a missing API key (assembly fault) ⇒ exit 64 with a logged reason, never a reject.

**Knobs.** `QUANTA_MCP_SERVER` (strict `=1` gate; default-OFF) and `QUANTA_MCP_SERVER_EXPOSE` (comma list of extra tools to expose, each validated against the registry — an unknown name warns to stderr and is dropped). Both registered in the `mcp` knob group.

## 결과

- An external MCP host can drive quanta's read-only tools over stdio, the inverse of ADR-0391's outbound client, with the wire codec shared but the transports not.
- The RCE surface is fail-closed at three independent layers — pure whitelist intersection, `tools/call` re-check, and the `{ mode: "default" }` dispatch posture — so a mutating tool exposed by mistake or by `QUANTA_MCP_SERVER_EXPOSE` STILL hits the permission gate and surfaces as `isError`, never a raw breakout.
- Default-OFF byte-identity: with the gate unset the subcommand exits 64 and assembles nothing (no LLM, FS, or config touched), pinned by the composition-root hellgate.
- The `@/mcp` slice fence stays clean: server + builder are duck-typed leaves; the only `@/agent`/`@/tool` coupling is the type-checked adapter at the apps-layer root.

## Trade-offs / Negative invariants (alternatives considered)

- **Reuse the outbound `Stdio` transport as the listener (rejected).** The `Stdio`/`HttpSse` transports are client-shaped (spawn/connect outward); a server must LISTEN on its own stdin. `McpServer` owns its own pump instead. Only the line codec is shared.
- **Reuse the headless `acceptEdits` permission (rejected — this WAS the RCE).** A headless `assembleAgentConfig` resolves `permission.mode === "acceptEdits"`, which auto-allows mutating tools. Reusing it for the reverse server would let a force-opted-in `write` execute against the FS — the exact RCE this command exists to prevent. The explicit `{ mode: "default" }` override is load-bearing, not cosmetic.
- **Loose gate vocabulary (rejected).** `QUANTA_MCP_SERVER` uses `gateOnStrict` (`=== '1'`), not the loose `gateOn` (`on`/`true`/`1`), because a stray `QUANTA_MCP_SERVER=on` left in an env file must NOT silently expose an RCE surface. The hellgate pins the strict refusal.
- **`drain()` is required, not optional.** Each `tools/call` dispatches async (a slow tool must not block decoding the next frame), so without the post-EOF `drain()` an in-flight FS effect could outlive the pump and a denied `write` could be observed as "not yet written" — a race the drain closes.
- **`explicitOptIn` can never WIDEN the surface.** The whitelist is intersected with the registry's actual `specs()`, so an unknown name in `QUANTA_MCP_SERVER_EXPOSE` is dropped at build time (and warned at the composition root). The only thing that counts is the intersection — a typo or a stale name is a no-op, not a hole.
