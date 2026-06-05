# RFC — MCP resources/prompts on the SUPERVISED (auto-restart) path

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: tool-surface / MCP capability over the auto-restart (ADR-0435) lifecycle
- Pair: **N3 — MCP resource/prompt tools (LANDED jun-06, grep-verified §3.1)**
  and **ADR-0435 — MCP reconnect supervisor (LANDED, grep-verified §3.2)**.
  This RFC closes the seam between them: N3's aggregate resource handle
  EXCLUDES supervised clients by construction; this RFC includes them.
- Default-OFF, byte-identical when no server is both supervised AND
  resources/prompts-capable.

---

## 1. 요약 (Summary)

N3 landed: `aggregateResourcesHandle` / `resourcesHandleFor`
(`src/agent/mcp-bridge.ts:233`, `:290`) fold every resources/prompts-capable
**live `McpClient`** behind a single duck-typed `ResourcesHandle` that backs the
four N3 tools (`mcp_list_resources` / `mcp_read_resource` / `mcp_list_prompts` /
`mcp_get_prompt`). But that aggregate is built ONLY over the **single-client**
path. The **supervised** (auto-restart, ADR-0435) path is excluded **by
construction**, and the exclusion is documented in-code:

> "SUPERVISED clients (the auto-restart path) are EXCLUDED:
> `McpReconnectSupervisor` does not expose the resources/prompts methods, so the
> bridge does not fake them — those servers are honestly absent from the
> resources surface (documented limitation, NOT a silent drop)."
> — `src/agent/mcp-bridge.ts:285-289`

So a server launched with `QUANTA_MCP_AUTORESTART=1` contributes its **tools**
(`supervisedTasksToolsFor`, `:140`; `mcpSupervisedToolToTool`, `:159`) but
NONE of its **resources or prompts** — even when it advertises them. The gap is
real and is the price N3 paid to ship: it never grew a supervisor-aware
resources adapter (unlike tasks, which DID — `tasksPortOver(sup)` exists).

This RFC supplies that adapter. The `McpReconnectSupervisor` already proxies
control-plane RPC through the live client with the correct reconnect semantics
(`requestRaw`, `:167`; `callTool`, `:145` — both re-resolve `this.client` on
every call so a restart-swap never goes stale, and both apply the pending-call
policy during the not-HEALTHY window). The design adds FOUR resources methods to
the supervisor that mirror that exact indirection — a NO-THROW proxy onto the
current live `McpClient`, returning a typed `unsupported`/`transport` failure
(never a throw) during the reconnect/degraded window — then teaches
`resourcesHandleFor` to admit supervised clients.

The single load-bearing decision is the **reconnect-gap contract**: while the
supervisor is `backing-off` / `restarting` / `degraded`, there is no usable
client, and a resource read MUST return a typed failure, NOT throw and NOT block
forever. We reuse the supervisor's own `awaitHealthyOrFail` policy (fail-fast
default; bounded queue-wait when configured) and map its `McpError("is not
running")` onto the `transport` failure reason the N3 handle already speaks.

---

## 2. 경쟁사 레퍼런스 (verified)

### Cursor — reconnect lifecycle is the source of ADR-0435 (verified)

ADR-0435's own header credits Cursor's reconnect lifecycle
(`src/mcp/reconnect/supervisor.ts:3`: *"Absorbs Cursor's reconnect lifecycle
(`mcpProcessMain.js`) as a policy layer"*). Cursor's MCP client surface treats
`listMcpResources` / `readMcpResource` (verified in N3's RFC §2,
`.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js` offsets
144041-144250) as ordinary per-server calls routed through the **same** live
connection that serves `tools/call`. Cursor does NOT split "tools survive
restart but resources do not" — its restart wrapper is transparent to the whole
JSON-RPC method set. **Takeaway:** the supervisor indirection should be method-
family-agnostic — if `callTool` survives a restart, so should `readResource`.
ADR-0435 already did this for `tasks/*`; resources/prompts is the missing
symmetric case.

### Codex — `resources/*` + `prompts/*` are plain outbound RPC (verified)

`.extracted_source/codex/_codex-rs-0.135-symbols.txt` (cited in N3 §2):
`resources/list` (7264), `resources/read` (7263), `prompts/list` (7262),
`prompts/get` (7260) are outbound params on the same `rmcp-client` that carries
`tools/call`. They are not a separate transport. **Takeaway:** there is no
protocol reason a supervised client cannot serve them — the only gap is the
quanta supervisor not exposing the methods. This RFC adds them.

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 N3 aggregate — landed, but single-client-only (the gap)

- `src/agent/mcp-bridge.ts:233` `aggregateResourcesHandle(clients: McpResourcesClient[])`
  — folds N live clients behind ONE `ResourcesHandle`: `listResources`/
  `listPrompts` CONCAT across clients (skip `unsupported`/errored, `:238-244`);
  `readResource`/`getPrompt` ROUTE — first non-`unsupported` result wins,
  `unsupported` everywhere ⇒ typed `unsupported` failure, never a throw
  (`:246-269`).
- `src/agent/mcp-bridge.ts:290` `resourcesHandleFor(clients: ReadonlyArray<ResourcesCapableClient>)`
  — filters to `serverSupportsResources() || serverSupportsPrompts()`; returns
  `undefined` when none qualify (so `DefaultToolPorts.mcpResources` stays unset
  ⇒ the four tools absent + byte-identical, `:293-295`).
- The input type `ResourcesCapableClient` (`:303-306`) is
  `McpResourcesClient & { serverSupportsResources(); serverSupportsPrompts() }`.
  Its docstring is explicit: *"The concrete `McpClient` satisfies it;
  `McpReconnectSupervisor` does NOT (no resources methods) and is excluded
  upstream."* (`:301-302`).
- `loadAll` (`:493`) collects the resources-capable clients into a
  `resourcesClients` array on **the single-client path only** — the comment at
  `:496-498` states *"supervised clients are excluded — see `resourcesHandleFor`"*
  — and builds the surface handle at `:514` (`resourcesHandleFor(resourcesClients)`).

**The supervised load path is `loadSupervised` (`:427`), which returns
`{ tools, client: McpStoppable, resources?: ResourcesCapableClient }`
(`:428`).** Today a supervised server's `resources` field is left unset because
the supervisor cannot satisfy `ResourcesCapableClient`. That is the gap this RFC
fills.

### 3.2 The supervisor ALREADY proxies control-plane RPC correctly (the template)

`McpReconnectSupervisor` (`src/mcp/reconnect/supervisor.ts:65`) is the exact
indirection to mirror. Verified:

- `current()` (`:123`) — *"Always the current live client"* (a
  `SupervisableMcpClient`). The live client is swapped on a successful restart
  (`this.client = fresh`, `:263`) behind this stable accessor.
- `callTool(name, args)` (`:145`) — applies the pending-call policy
  (`awaitHealthyOrFail`, `:147`) when not HEALTHY, then delegates to
  `this.client.callTool` (`:149`). **Re-reads `this.client` per call** ⇒ never
  stale across a restart.
- `requestRaw(method, params)` (`:167`) — the SAME pattern for outbound
  `tasks/*`: policy check (`:168-170`), then `this.client.requestRaw` (`:171-175`).
  Its docstring (`:161-166`) states the invariant verbatim: *"Because it
  re-resolves `this.client` on every call, a `supervisedTasksToolsFor` handle
  bound to this supervisor never goes stale across a restart."*
- `serverSupportsTasks()` (`:157`) — *"Read per call (never captured) so a
  restart that swaps the live client re-evaluates against the new one"*; a client
  lacking the method ⇒ `false` (byte-identical default-OFF).
- `awaitHealthyOrFail()` (`:313`) — fail-fast (default) throws the byte-identical
  `McpError("is not running")` (`:314-317`); `queue` mode parks up to
  `queueWaitMaxMs` for HEALTHY (`:319-339`); `degraded` fails immediately
  (`:316`).

So the supervisor has EVERY mechanism the resources proxy needs — it simply has
no `listResources`/`readResource`/`listPrompts`/`getPrompt` methods yet.

### 3.3 The tasks precedent proves the shape (and proves the asymmetry)

`supervisedTasksToolsFor(sup: McpReconnectSupervisor)` (`src/agent/mcp-bridge.ts:140`)
already wires the tasks surface over the SUPERVISOR — guarded by
`sup.serverSupportsTasks()` and built over `tasksPortOver(sup)` (the
supervisor-aware variant of the tasks client adapter,
`src/mcp/tasks/client-port.ts`). The resources surface has NO such sibling — N3
shipped `aggregateResourcesHandle` for live clients but never a
`supervisedResourcesToolsFor` / supervisor-aware handle. **This RFC adds exactly
the missing symmetric piece**, modeled one-for-one on the tasks path.

### 3.4 Slice fence (placement constraint)

The resources methods must be added to `McpReconnectSupervisor` inside
`src/mcp/reconnect/` (the `@/mcp` slice — `@/mcp` depends on `@/shared` only,
which the supervisor already honors: its imports are `@/shared`, `../client`,
`../types`, `./policy`, `./port` — `supervisor.ts:18-22`). The handle-building
(`resourcesHandleFor` admitting supervisors) stays in `@/agent/mcp-bridge`, the
bridge layer that already imports both `@/mcp` and the `@/tool`-side
`ResourcesHandle` mirror (`mcp-bridge.ts:9`, and the `HandleResult` mirror used
at `:201-204`). No new cross-slice edge is introduced.

---

## 4. 설계 (Design)

### 4.1 Add the four resources methods to `McpReconnectSupervisor`

Mirror `requestRaw` exactly — a NO-THROW proxy onto the current live client,
each method re-resolving `this.client` so a restart-swap is transparent. The
supervisor's live client is a `SupervisableMcpClient`; the concrete `McpClient`
that backs it already implements the four resources methods (the N3 prerequisite
H19, `src/mcp/client.ts:414-466`). The methods are OPTIONAL on
`SupervisableMcpClient` (an isolated/test client may not have them), so the proxy
degrades to a typed `unsupported` when absent — mirroring how `serverSupportsTasks`
defaults to `false`.

```ts
// src/mcp/reconnect/supervisor.ts — new methods on McpReconnectSupervisor

/** Does the CURRENT live client's server advertise `resources/*`? Read per call
 *  (never captured) so a restart swap re-evaluates. Mirrors
 *  {@link serverSupportsTasks}. */
serverSupportsResources(): boolean {
  return this.client.serverSupportsResources?.() ?? false
}
serverSupportsPrompts(): boolean {
  return this.client.serverSupportsPrompts?.() ?? false
}

/** Proxy `resources/list` through the current live client. NO-THROW: during the
 *  reconnect gap (`backing-off`/`restarting`/`degraded`) the pending-call policy
 *  yields a typed `transport` failure instead of the bare McpError, so the N3
 *  aggregate keeps its no-throw contract. Mirrors {@link callTool}/{@link requestRaw}. */
async listResources(): Promise<HandleResult<ResourceEntry[]>> {
  return this.proxyResources((c) => c.listResources())
}
async readResource(uri: string): Promise<HandleResult<ResourceBlock[]>> {
  return this.proxyResources((c) => c.readResource(uri))
}
async listPrompts(): Promise<HandleResult<PromptEntry[]>> {
  return this.proxyResources((c) => c.listPrompts())
}
async getPrompt(name: string, args?: Record<string, unknown>): Promise<HandleResult<PromptResult>> {
  return this.proxyResources((c) => c.getPrompt(name, args))
}
```

### 4.2 The reconnect-gap contract (`proxyResources` — the load-bearing piece)

```ts
private async proxyResources<T>(
  call: (c: SupervisableMcpClient) => Promise<HandleResult<T>>,
): Promise<HandleResult<T>> {
  // 1. NOT HEALTHY ⇒ apply the existing pending policy. fail-fast (default)
  //    throws McpError("is not running"); queue mode parks up to queueWaitMaxMs.
  //    Either way we CATCH the throw and convert to a typed `transport` failure
  //    so the aggregate never sees an exception (N3's no-throw invariant).
  if (this.state !== "healthy") {
    try {
      await this.awaitHealthyOrFail()
    } catch (e) {
      return { ok: false, reason: "transport", message: errMessage(e) }
    }
  }
  // 2. The live client may not implement resources (isolated/test client).
  const fn = this.client.listResources // (etc., resolved by the `call` closure)
  if (this.client.serverSupportsResources === undefined /* method-set absent */) {
    return { ok: false, reason: "unsupported", message: "server has no resources capability" }
  }
  // 3. Delegate to the CURRENT live client. The underlying McpClient method is
  //    itself total (returns HandleResult, never throws) — but we still guard so
  //    a non-conforming client can never throw into the aggregate.
  try {
    return await call(this.client)
  } catch (e) {
    return { ok: false, reason: "transport", message: errMessage(e) }
  }
}
```

Three windows, all typed-failure, never-throw:

| supervisor state | behavior |
|---|---|
| `healthy` | delegate to live client; its own `HandleResult` returned verbatim |
| `backing-off` / `restarting` | `awaitHealthyOrFail` → fail-fast `transport` (or bounded queue-wait, then delegate or `transport`) |
| `degraded` (give-up) | immediate `transport` failure (`awaitHealthyOrFail` throws on `degraded`, `:316`) |
| live client lacks methods | `unsupported` (mirrors `serverSupportsTasks` → false) |

This is the EXACT semantics N3's `aggregateResourcesHandle` already tolerates: a
`transport` failure on a list is SKIPPED (other servers still aggregate,
`:241-242`); on a route it is remembered as `firstRealFailure` but a hit
elsewhere still wins (`:256-261`). So a supervised server mid-reconnect simply
"drops out" of the aggregate for that call and rejoins on recovery — no caller
change, no throw.

### 4.3 Admit the supervisor into `resourcesHandleFor`

`ResourcesCapableClient` (`mcp-bridge.ts:303`) is structural —
`McpResourcesClient & { serverSupportsResources(); serverSupportsPrompts() }`.
Once the supervisor implements all six methods (§4.1) it satisfies the interface
WITHOUT a wrapper (structural typing — same trick N3 uses for `McpClient`,
`:194-198`). The only edits:

- `loadSupervised` (`:427`): when
  `sup.serverSupportsResources() || sup.serverSupportsPrompts()`, set the
  returned `resources: sup` (today it stays unset). Read per-call inside the
  supervisor so a restart that changes capability re-evaluates.
- `loadAll` (`:493`): the supervised branch pushes `sup` into the same
  `resourcesClients` array the single-client branch uses (`:496`). Then the
  EXISTING `resourcesHandleFor(resourcesClients)` (`:514`) folds supervised and
  single clients into ONE aggregate transparently — no second handle, no special
  case downstream.

Update the two docstrings that assert the exclusion (`:285-289`, `:301-302`) to
record that supervised clients are now INCLUDED via the proxy.

### 4.4 Capability re-evaluation across a restart (subtle correctness)

A restart can change a server's advertised capability (the fresh client re-runs
`initialize`, `supervisor.ts:241-244`). Because `serverSupportsResources()` is
read PER CALL off `this.client` (§4.1, mirroring `serverSupportsTasks` `:157`),
the aggregate naturally re-evaluates: a server that lost the capability after a
restart returns `unsupported` (skipped); one that gained it starts contributing.
The HANDLE itself is built once at load (`resourcesHandleFor`), but since it
holds the supervisor (not a captured client), every call resolves live state.
**Decision:** do NOT rebuild the handle on restart — the per-call indirection
already handles capability drift, exactly as the tasks path does.

---

## 5. 통합 (Integration)

- **Knob — reuse N3's, no new flag.** This is a completeness fix to N3, gated by
  the SAME `QUANTA_MCP_RESOURCES` knob (`src/shared/runtime-config.ts:318`,
  `mcpResources`). It is ALSO implicitly gated by `QUANTA_MCP_AUTORESTART`
  (`supervisor.ts:11`) — a server is only supervised when auto-restart is ON. So
  the new path is reachable ONLY when BOTH knobs are on AND a supervised server
  advertises resources/prompts. With either off, or no such server, the load is
  byte-identical (the supervised `resources` field stays unset ⇒ no new tools).
- **No manifest change.** The four N3 tools already have their grouped manifest
  row (N3 §5.3). This RFC changes only WHICH clients feed the handle, not the
  tool set — `src/tool/surface/manifest.ts` is untouched.
- **No fc change beyond a note.** The N3 fc entry (`mcp.resource-tools`) already
  roots reachability at `mcpResourcesTools` → bridge. Optionally annotate it that
  the supervised path is now covered; no new fc node.
- **Fence-clean placement** (§3.4): methods added inside `src/mcp/reconnect/`
  (`@/mcp` → `@/shared` only — already honored); handle admission stays in
  `@/agent/mcp-bridge`. The `HandleResult`/`ResourceEntry`/`ResourceBlock`/
  `PromptEntry`/`PromptResult` types the supervisor method SIGNATURES reference
  are the `@/mcp`-side `McpResult<T>` shapes (NOT the `@/tool` mirror) — the
  supervisor lives in `@/mcp`, so it speaks `@/mcp` types, and structural
  identity with the `@/tool` mirror is asserted (as today) at the bridge
  (`mcp-bridge.ts:200-205`).

---

## 6. 테스트 계획 (Tests)

Hellgate (`tests/.../supervised-resources-hellgate.test.ts`), over a FAKE
`SupervisableMcpClient` + the supervisor's injected fake clock/timer (the
supervisor already runs entirely on a fake clock — `supervisor.ts:8-9`). Every
arm an explicit case:

1. **healthy proxy** — supervisor in `healthy`; `listResources`/`readResource`/
   `listPrompts`/`getPrompt` each return the live client's `HandleResult`
   verbatim (ok and failure shapes).
2. **reconnect-gap fail-fast** — force `crashed`→`backing-off`; a `readResource`
   returns `{ ok:false, reason:"transport" }` (NOT a throw), and the aggregate
   ROUTE remembers it but a hit from a sibling client still wins.
3. **reconnect-gap queue mode** — `pendingPolicy:"queue"`, `queueWaitMaxMs>0`;
   advance the fake clock to HEALTHY before the cap → the call delegates and
   succeeds; exceed the cap → `transport` failure.
4. **degraded** — drive past `maxFastAttempts`+`maxPeriodicCycles` to `degraded`;
   every resources method returns `transport` immediately, never throws, never
   hangs.
5. **restart-swap transparency** — bind the handle, crash, restart with a fresh
   client whose `readResource` returns DIFFERENT content; the SAME handle now
   returns the new content (proves per-call `this.client` re-resolution).
6. **capability drift across restart** — pre-restart client supports resources;
   post-restart client does NOT → `serverSupportsResources()` flips to `false`,
   aggregate stops including it (returns `unsupported`, skipped in lists).
7. **method-set absent** — a `SupervisableMcpClient` with no resources methods ⇒
   `serverSupportsResources()===false` ⇒ `resourcesHandleFor` drops it; if forced
   in, every call returns `unsupported`, never a null-deref.
8. **mixed aggregate** — one single-client + one supervised client, both
   resources-capable; `listResources` CONCATs across both; `readResource` routes;
   the supervised one mid-reconnect drops out for that call and rejoins after.
9. **default-OFF byte-identical** — supervised server advertises NEITHER
   resources nor prompts ⇒ `resources` field stays unset ⇒ zero new tools; the
   supervised load output equals the pre-RFC load.

E2e (`tests/smoke/`): a fake MCP server behind a supervisor that advertises
`resources`; agent calls `mcp_list_resources` → `mcp_read_resource`; then force a
crash+restart mid-conversation and assert the second `mcp_read_resource` still
succeeds (transcript shows the H2 envelope-wrapped content — the `mcp` origin
tagging from N3 §3.3 applies unchanged because the tools still register through
`mcpTools`).

---

## 7. 단계 (Phases)

- **Phase 1 — supervisor methods + admission** (smallest shippable): add the six
  methods to `McpReconnectSupervisor` (§4.1) with the `proxyResources` gap
  contract (§4.2); admit the supervisor in `loadSupervised`/`loadAll` and update
  the two exclusion docstrings (§4.3). hellgate cases 1-9 (§6). This fully closes
  the gap.
- **Phase 2 (optional polish)** — surface the supervisor's resources state in the
  `/mcp` status pill (a server that is `degraded` shows its resources as
  temporarily unavailable rather than absent), reusing the existing
  `SupervisorSnapshot` (`supervisor.ts:51`). Pure presentation; no contract
  change.

---

## 8. 리스크 / 대안 (Risks / Alternatives)

- **Reconnect-gap throw leaking into the aggregate (the dominant risk).** The N3
  aggregate is NO-THROW by contract; a supervised method that threw
  `McpError("is not running")` during backoff would break it. Mitigation: the
  `proxyResources` guard (§4.2) CATCHES `awaitHealthyOrFail`'s throw and the
  delegate's throw, converting both to a typed `transport` failure. Hellgate
  cases 2/4 pin this. This is the single most important invariant.
- **Stale handle across restart.** A handle that captured a client reference
  would serve a dead connection after a swap. Mitigation: the supervisor methods
  re-resolve `this.client` per call (§4.1, §4.4) — identical to the proven
  `callTool`/`requestRaw`/`serverSupportsTasks` pattern. The handle holds the
  SUPERVISOR, never a client.
- **Queue-mode unbounded wait.** `queue` mode could park a resource read. It is
  bounded by `queueWaitMaxMs` (`:329-334`) exactly as `callTool` is — no new
  unbounded await. Default `fail-fast` never waits at all.
- **Alternative — a separate supervised aggregate handle.** Rejected: it would
  duplicate `aggregateResourcesHandle` and force a second `DefaultToolPorts`
  slot. Folding supervised clients into the SAME `resourcesClients` array (§4.3)
  reuses the landed aggregate verbatim — the ROUTE/CONCAT logic already tolerates
  a per-call dropout, which is exactly the reconnect-gap behavior.
- **Alternative — a `resourcesPortOver(sup)` adapter (mirroring
  `tasksPortOver(sup)`) instead of methods ON the supervisor.** Viable, but the
  supervisor already exposes its control-plane RPC AS methods (`callTool`,
  `requestRaw`) rather than via a separate port object; adding resources methods
  keeps the supervisor's surface consistent and lets it satisfy
  `ResourcesCapableClient` structurally with no wrapper allocation. The
  port-adapter is the fallback if adding methods to the class is contested.
- **Capability flips silently on restart.** Documented as intended (§4.4): a
  restart that drops the resources capability is honestly reflected as the server
  dropping out of the aggregate, not as a stale tool surface. Hellgate case 6.

---

## 9. 코드 위치 요약 (Files)

**Edit** (the whole change is two files + tests):
- `src/mcp/reconnect/supervisor.ts` — add `serverSupportsResources()` /
  `serverSupportsPrompts()` + `listResources` / `readResource` / `listPrompts` /
  `getPrompt` + the private `proxyResources` gap-contract helper (§4.1, §4.2).
  Import `errMessage` (already imported, `:18`) for the failure messages; the
  `HandleResult`/`Resource*`/`Prompt*` types come from the `@/mcp` resources port
  (`src/mcp/resources/port.ts`, the `McpResult<T>` shapes). May need to widen
  `SupervisableMcpClient` (`src/mcp/reconnect/port.ts`) with the four OPTIONAL
  resources methods so the proxy can call them off the live client.
- `src/agent/mcp-bridge.ts` — in `loadSupervised` (`:427`) set
  `resources: sup` when capable; in `loadAll` (`:493`) push the supervisor into
  `resourcesClients`; update the exclusion docstrings (`:285-289`, `:301-302`).

**Touch** (data/doc only):
- `tools/feature-catalog/*` — optional note on `mcp.resource-tools` that the
  supervised path is now covered.

**Read-only (referenced, never modified):**
- `src/mcp/reconnect/supervisor.ts:123,145,157,167,313` — the proxy template
  (`current`/`callTool`/`serverSupportsTasks`/`requestRaw`/`awaitHealthyOrFail`).
- `src/agent/mcp-bridge.ts:140,159` — `supervisedTasksToolsFor` /
  `mcpSupervisedToolToTool` (the tasks precedent).
- `src/agent/mcp-bridge.ts:233,290,303` — `aggregateResourcesHandle` /
  `resourcesHandleFor` / `ResourcesCapableClient` (the N3 aggregate this RFC
  feeds).
- `src/mcp/client.ts:414-466` — H19 typed resources methods on `McpClient` (the
  live-client impl the supervisor proxies to).
