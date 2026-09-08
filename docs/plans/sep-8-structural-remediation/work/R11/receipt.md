# R11 receipt — C-F1 + C-F9

Status: **implemented** (owner-local GREEN). I-stage **applied on W2-I** (`29d7e4ff1`).

Worker: W2-C R11  
Worktree: `/Users/songmin/quanta-codeagent-v3-w2-r11`  
Branch: `sep8-w2-r11`  
HEAD: `16cabfde464e354a4c3e98f3b7ffbc6e57f1086f`  
NO COMMIT / NO PUSH.

Policy: W0.5 freeze in `work/W0.md` (ready modes, same `McpClient` + `McpTransport`, send Error vs DXT NO-THROW, generation-scoped HTTP reauth). Production constructors / catalog / barrels left for I.

## Snapshot

| Field | Value |
|---|---|
| source HEAD | `16cabfde464e354a4c3e98f3b7ffbc6e57f1086f` |
| Bun | 1.3.14 |
| OS | Darwin / macOS |
| `src/mcp/client.ts` | **875 lines** (was 888; reauth extracted — not in 900–999) |
| `src/mcp/client/reauthorize.ts` | 225 lines (new sibling) |
| `src/mcp/transports/http-sse.ts` | 791 (comment only; first-wins stays for a **fresh** instance) |
| `src/plugin-isolation/bun-spawner.ts` | 655 (ready-mode + trySend only) |
| cohort | 900–999 max=24; `client.ts` did **not** enter the band |

## Findings closed (owner-local)

### C-F1 — isolation knob / second protocol core

- Isolated path is the **same** `McpClient` + `McpTransport`. `IsolatedMcpClient` is a delegating facade (`dxt-ready-line`). Factory (`MCP_USE_ISOLATED_SPAWN`) selects `IsolatedMcpTransport` with **`process-ready`**. HTTP/`url` unchanged. Flag off → stdio.
- bun-spawner: `process-ready` does not consume the first stdout line; `dxt-ready-line` still waits for a sentinel. `trySend` returns `Error`; `IsolatedProcess.send` stays NO-THROW. Isolated MCP transport maps drop → Error.
- Production constructors (`mcp-composition`, `mcp-bridge`, `skill-mcp-wire`, plugin launcher): worker left them; **W2-I applied**. See `integration-delta.md`.

### C-F9 — reauth without initialize

- `doReauthorize` start-only swap **removed**. `runReauthTransaction`: create → start → initialize (raw RPC, no 401 recurse) → `notifications/initialized` → publish. Generation-scoped `onMessage`. Single-flight.
- New session id on a **new** HTTP transport instance. Old session not transplanted. Old pending **fail**. Failed/stop candidate closed. Stale generation ignored.
- Replay allow-list: `initialize`, `tools/list`, `resources/list`, `prompts/list`, `resources/templates/list`. **`tools/call` never auto-replayed**. Old close DELETE must not kill the adopted session.

## RED → GREEN

```
bun test tests/unit/sep8-remediation/r11 tests/integration/sep8-remediation/r11 \
  tests/unit/mcp/transport-port-hellgate.test.ts \
  tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts \
  tests/unit/mcp-oauth-coalesce-concurrency-r4-hellgate.test.ts \
  tests/unit/mcp/protocol-version-http-header-hellgate.test.ts
```

**67 pass / 0 fail** (10 files, 154 `expect()`).

| Suite | tests |
|---|---:|
| new `tests/unit/sep8-remediation/r11/` | 20 |
| new `tests/integration/sep8-remediation/r11/` | 4 |
| existing 4 hellgates | 43 |
| **total** | **67** |

Load-bearing GREEN (W0.5):

- Factory: flag on → `IsolatedMcpTransport` `process-ready`; flag off → stdio; HTTP unchanged.
- process-ready stdio MCP with **no** unsolicited ready line starts; DXT ready-line + timeout still work.
- oversize/dead isolated MCP send → `Error` (not silent drop).
- IsolatedMcpClient `listTools` delegates to inner `McpClient` (existing IsolatedMcpClient hellgate still green).
- Stateful HTTP: 401 → new session id + protocol pin + allowed retry; handshake 401; concurrent 401 single-flight; stop-during-refresh; late old response ignored; `tools/call` not auto-replayed; old DELETE does not kill adopted session.

## Mutation

- Restoring start-only swap (`await next.start()` then `old.close`, no `handshakeOnTransport`) fails `c-f9-start-only-swap-mutation.test.ts`.
- Red-on-injection: stripping `handshakeOnTransport(` in a clone fails the rail.

## Compatibility

- Flag off: command servers still `StdioMcpTransport` (transport-port hellgate).
- IsolatedMcpClient public surface (`start` / `listTools` / `callTool` / `stop` / `onExit` / `pinnedProtocolVersion`) kept; plugin hellgate still constructs the facade.
- DXT `IsolatedProcess.send` still NO-THROW (spawner hellgate).
- `isolatedMcpEnabledFromEnv` moved to `src/mcp/client/isolated-flag.ts`, re-exported from `isolated-client.ts` (cycle-free).

## Unverified / out of scope

- I-stage host/agent/catalog/barrel: **applied on W2-I**. Catalog YAML was rewritten to the factory path.
- repository prepush / lint-debt campaign not claimed as W2 closeout.
- skybridge / whole plugin-isolation refactor.
- G-F5.4 is R13, not this package.

## Files changed (this worker)

Source:

- `src/mcp/client.ts`
- `src/mcp/client/reauthorize.ts` (new)
- `src/mcp/client/isolated-flag.ts` (new)
- `src/mcp/client/transport-factory.ts`
- `src/mcp/isolated-client.ts`
- `src/mcp/transports/isolated.ts` (new)
- `src/mcp/transports/http-sse.ts` (comment: first-wins is for a fresh instance)
- `src/plugin-isolation/bun-spawner.ts`
- `src/plugin-isolation/types.ts`

Tests:

- `tests/unit/sep8-remediation/r11/c-f1-factory-seam.test.ts`
- `tests/unit/sep8-remediation/r11/c-f1-isolated-send-failure.test.ts`
- `tests/unit/sep8-remediation/r11/c-f1-facade-delegate.test.ts`
- `tests/unit/sep8-remediation/r11/c-f9-reauth-handshake.test.ts`
- `tests/unit/sep8-remediation/r11/c-f9-start-only-swap-mutation.test.ts`
- `tests/integration/sep8-remediation/r11/c-f1-process-ready-stdio.test.ts`

Artifacts:

- `docs/plans/sep-8-structural-remediation/work/R11/receipt.md`
- `docs/plans/sep-8-structural-remediation/work/R11/integration-delta.md`

Not edited: `index.ts`, `src/host/**`, `src/agent/mcp-bridge.ts`, `src/agent/skill-mcp-wire.ts`, `src/agent/plugin-mcp-launcher/**`, `tools/**`, `docs/10.feature-catalog.md`, README/ACTIONS/WAVES/waves.json.
