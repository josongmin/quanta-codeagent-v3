# RFC — N3: MCP resource/prompt as agent-callable tools

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-04
- Axis: tool-surface (LLM tool-access) over the MCP capability axis
- Prereq: **H19 — typed `resources/*` + `prompts/*` client methods (LANDED, grep-verified §3)**
- Model: mirror `src/tool/mcp_tasks/` (ADR-0196/0431) one-for-one

---

## 1. 요약 (Summary)

H19 already gave `McpClient` typed, no-throw `listResources` / `readResource` /
`listPrompts` / `getPrompt` methods (`src/mcp/client.ts:414-466`). Those are
INTERNAL client methods — the agent loop cannot call them. N3 is the
tool-surface that sits on top: four caller-wired, default-OFF tools —
`mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`,
`mcp_get_prompt` — that let the MODEL enumerate and read a connected MCP
server's resources and prompt templates.

The template is exact and already in-tree: `mcp_tasks_*` (`src/tool/mcp_tasks/`)
is "typed tools over an MCP capability, caller-wired, default-OFF". N3 adds a
sibling directory `src/tool/mcp_resources/` with the same shape: a duck-typed
`ResourcesHandle` mirror in `@/tool` (slice fence forbids `@/tool`→`@/mcp`), an
`@/mcp` adapter that lifts a live `McpClient` into that handle, and the
`src/agent/mcp-bridge.ts` assembler that wires it — gated exactly like tasks:
present IFF the server advertised `resources` / `prompts`.

Untrusted resource/prompt content is auto-protected: tools registered through
the `mcpTools` array are tagged `mcp` origin (`src/runner/assemble/tooling.ts:211`)
⇒ `deriveProvenance` returns `mcp` (`src/tool/origin.ts:97`) ⇒ the H2/ADR-0471
`<untrusted-source>` envelope wraps the output at the dispatch seam
(`src/agent/dispatch.ts:991`). No new security wiring is required; N3 inherits it
by registering through the same array.

---

## 2. 경쟁사 레퍼런스 (verified)

### Cursor — `cursor-agent-exec` exec-args (verified)

`.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js` (minified)
carries a closed exec-arg/result type set around offsets 130034-130090:

- `ListMcpResourcesExecArgs` → `ListMcpResourcesExecResult` | `ListMcpResourcesError`
  | `ListMcpResourcesRejected`
- `ReadMcpResourceExecArgs` → `ReadMcpResourceSuccess` | `ReadMcpResourceError`
  | `ReadMcpResourceRejected` | `ReadMcpResourceNotFound`

The user-facing exec verbs are `listMcpResources` / `readMcpResource` (offsets
144041-144250, 208030-208050). The arg envelope keys include `serverName`
(127100, 135698, 207795+) — i.e. Cursor scopes each call to ONE named server.
**Takeaways for N3:** (a) two distinct tools (list vs read), (b) per-server
scoping via a `serverName` arg, (c) a closed result union that distinguishes
`NotFound` / `Error` / `Rejected` (permission) from success — we map these to
the typed `McpResult` failure reasons we already have. Cursor does NOT expose
prompts as agent exec-args; N3 goes one wider (prompts too), matching Codex.

### Codex — `rmcp-client` method set (verified)

`.extracted_source/codex/_codex-rs-0.135-symbols.txt`:

- outbound params: `resources/list -> params:` (7264), `resources/read -> params:`
  (7263), `resources/subscribe -> params:` (7259), `prompts/list -> params:`
  (7262), `prompts/get -> params:` (7260)
- result structs: `GetPromptResult with 2 elements`, list results carry
  `nextCursor`, `PromptReference with 2 elements`, completion refs
  `ref/resource` / `ref/prompt` (47756)
- error strings: `resources/read failed for ...` (3260), `resources/list failed
  for ...` (6458)

**Takeaways for N3:** Codex confirms the full five-method family
(`resources/{list,read,subscribe}` + `prompts/{list,get}`) and that list results
are cursor-paginated (`nextCursor`). H19 already implements every one of these on
`McpClient`. N3 surfaces `list`/`read` + `list`/`get`; `subscribe` stays a client
method (notification-driven, not a request/response agent tool — out of scope §8).

### Shape extracted (synthesis)

A resource tool-call is `{ serverName?, uri }` (read) / `{ serverName? }`
(list); a prompt tool-call is `{ serverName?, name, arguments? }` (get) /
`{ serverName? }` (list). Result content is a block list (text|blob) for
resources, a message list for prompts.

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 H19 prerequisite — **LANDED** (NOT the jun-04 overload casualty)

The jun-04 H19 attempt is reported in memory as having died to overload. **It did
NOT — H19 is fully present.** Grep-verified:

- `src/mcp/client.ts:414` `async listResources(): Promise<McpResult<McpResource[]>>`
  → `typedRequest("resources/list", {}, parseResourceList)` (`:418`)
- `src/mcp/client.ts:423` `async readResource(uri): Promise<McpResult<McpResourceContent[]>>`
  → `typedRequest("resources/read", { uri }, parseResourceRead)` (`:427`)
- `src/mcp/client.ts:449` `async listPrompts(): Promise<McpResult<McpPrompt[]>>`
  → `typedRequest("prompts/list", {}, parsePromptList)` (`:453`)
- `src/mcp/client.ts:458` `async getPrompt(name, args?): Promise<McpResult<McpPromptResult>>`
  → `typedRequest("prompts/get", params, parsePromptGet)` (`:466`)
- bonus: `subscribeResource` / `unsubscribeResource` (`:433`, `:443`)

Supporting slice `src/mcp/resources/` is complete: `port.ts` (typed shapes +
`McpResult<T>` no-throw union, `:104-111`), `codec.ts` (the four parsers),
`notifications.ts`, `inbound-router.ts` (roots), `index.ts` (barrel). The barrel
re-exports all types through `src/mcp/index.ts:41-57`. Each method is
**capability-gated locally** (`serverSupportsResources()` /
`serverSupportsPrompts()`) and returns a typed `{ ok:false, reason }`
(`unsupported` | `malformed` | `transport`) rather than throwing — identical
no-throw contract to the tasks port.

**Conclusion: Phase 0 (the client methods) is DONE.** N3 is unblocked and starts
at Phase 1. There is ONE H19 gap N3 must add (§7): unlike tasks, there is no
`ResourcesPort`-over-client adapter yet (no `clientResourcesPort` analogue to
`clientTasksPort`). H19 stopped at the raw `McpClient` methods. N3 supplies the
thin handle adapter — that is N3's only "client-layer" work.

### 3.2 The `mcp_tasks_*` template (the exact model to mirror)

`src/tool/mcp_tasks/` is the proven pattern. Five files:

- `port.ts` — `TasksHandle` interface (`:41-46`): a DUCK-TYPED mirror of
  `@/mcp/tasks/port.ts`'s `McpTasksPort`, defined in `@/tool` because the slice
  fence forbids `@/tool`→`@/mcp` (header `:1-10`). Drift = a TYPE error at the
  adapter site.
- `get_task.ts` / `list_tasks.ts` / `cancel_task.ts` — one `Tool` factory each,
  `(port: TasksHandle) => Tool` (`get_task.ts:14`). Read-only ones set
  `isReadOnly:()=>true` + `isConcurrencySafe:()=>true` (`:20-21`). Each `execute`
  re-parses the input with the zod schema, checks `ctx.signal.aborted`, calls the
  handle, and yields a single `{ type:"result" }`. A `null` handle response →
  `{ ok:false, output:"not-found", failure:{ mode:"not_found" } }` (`:37-46`).
- `index.ts` — `mcpTasksTools(port): Tool[]` (`:37-41`) returns all three in a
  stable order (read-only first), and re-exports schemas/types.

Wiring (the bridge): `src/agent/mcp-bridge.ts`:

- `tasksToolsFor(client)` (`:114-120`): `if (!client.serverSupportsTasks()) return []`,
  else `mcpTasksTools(clientTasksPort(client))`. Default-OFF: a server that
  doesn't advertise `tasks` adds NO tools.
- `supervisedTasksToolsFor(sup)` (`:134-141`): the auto-restart sibling, handle
  built over the SUPERVISOR (`tasksPortOver(sup)`) so it survives client swap.
- Both paths push into the bridged `tools` array (`loadSingle` `:352`,
  `loadSupervised` `:314`).

`@/mcp/tasks/client-port.ts`: `tasksPortOver(rpc)` (`:107`) and
`clientTasksPort(client) = tasksPortOver(client)` (`:148`) are the client→handle
adapters N3 mirrors with `resourcesPortOver` / `clientResourcesPort`.

### 3.3 Origin/provenance substrate (load-bearing for N3 security)

- `src/runner/assemble/tooling.ts:210-215` `buildOriginMap([[input.mcpTools, "mcp"], …])`
  tags EVERY tool in the `mcpTools` array with `mcp` origin. The `mcp_tasks_*`
  tools already flow through `input.mcpTools` (they come back inside
  `loadMcpTools`'s returned tools). So do the new N3 tools — for free.
- `src/tool/origin.ts:95-99` `deriveProvenance(name, "mcp") => "mcp"`. Origin
  wins over name (`:91-93`): a hostile server can't launder output to `internal`.
- `src/agent/dispatch.ts:991-995` wraps the result via
  `wrapToolResult(redacted, deriveProvenance(name, registry.originOf(name)), { enabled: untrustedEnvelope })`.

### 3.4 Manifest (tool-surface SSOT)

`src/tool/surface/manifest.ts:454-464` carries the `mcp_tasks` row
(`list_mcp_tasks` + `group:["get_mcp_task","cancel_mcp_task"]`,
`gate:{ kind:"config-slot", slot:"TasksHandle (apps MCP wire)" }`,
`default:{ cli:"opt-in" }`, `risk:"meta"`, `adr:"0196"`). The two-way drift
guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`) FAILS CI on any
registered tool missing a row, or any stale row. N3 must add a row (§5).

---

## 4. 설계 (Design)

### 4.1 New slice `src/tool/mcp_resources/`

Mirror `mcp_tasks/` file-for-file. NO import of `@/mcp` (leaf slice).

**`port.ts` — `ResourcesHandle` (duck-typed mirror of `@/mcp/resources/port`):**

```ts
// String-IDENTICAL members to @/mcp/resources/port's McpResult/McpResource/etc.
// so the apps-layer adapter assigns with the identity (drift ⇒ TYPE error there).
export type ResourcesFailureReason = "unsupported" | "malformed" | "transport"

export interface ResourceEntry { uri: string; name?: string; mimeType?: string; description?: string }
export interface ResourceBlock { uri: string; mimeType?: string; text?: string; blob?: string }
export interface PromptEntry { name: string; description?: string; arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }> }
export interface PromptMessage { role: "user" | "assistant"; content: unknown }
export interface PromptResult { messages: ReadonlyArray<PromptMessage>; description?: string }

export type HandleResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ResourcesFailureReason; message: string }

export interface ResourcesHandle {
  listResources(): Promise<HandleResult<ResourceEntry[]>>
  readResource(uri: string): Promise<HandleResult<ResourceBlock[]>>
  listPrompts(): Promise<HandleResult<PromptEntry[]>>
  getPrompt(name: string, args?: Record<string, unknown>): Promise<HandleResult<PromptResult>>
}
```

This mirror is byte-identical to `McpResult<T>` + the `Mcp*` shapes in
`@/mcp/resources/port.ts:27-111`. Keeping it local preserves the `@/tool` leaf
property (exactly as `TasksHandle` mirrors `McpTasksPort`).

**Four tool factories** `(port: ResourcesHandle) => Tool<…>`:

| tool | input zod | read-only | failure mapping |
|---|---|---|---|
| `mcp_list_resources` | `{}` | yes | `unsupported`→`ok:false output:"server has no resources capability"`; `transport`/`malformed`→`ok:false` with reason |
| `mcp_read_resource` | `{ uri: string.min(1) }` | yes | as above; empty content list → `ok:true` empty render |
| `mcp_list_prompts` | `{}` | yes | gated on `prompts` capability |
| `mcp_get_prompt` | `{ name: string.min(1), arguments?: record(unknown) }` | yes (no side-effect; a `prompts/get` only renders a template) | as above |

All four set `isReadOnly:()=>true` + `isConcurrencySafe:()=>true` (mirroring the
read-only tasks tools). Each `execute` re-parses with its schema, checks
`ctx.signal.aborted`, calls the handle once, and yields ONE `{ type:"result" }`.
This matches `get_task.ts:22-63` exactly.

**`index.ts`** `mcpResourcesTools(port): Tool[]` returns all four in stable
order (list_resources → read_resource → list_prompts → get_prompt), re-exporting
schemas + the `ResourcesHandle` type — mirror of `mcp_tasks/index.ts:37-41`.

### 4.2 resource-content → ToolResult mapping

`readResource` returns `ResourceBlock[]` (each block is text XOR blob). Render to
a single string `output`:

- text blocks: concatenate `text`, prefixed once with the `uri` (+ `mimeType` if
  present) so the model knows the source — e.g. `# <uri> (<mimeType>)\n<text>`.
- blob blocks: do NOT inline base64 into the transcript (token blowout + the
  model can't use it). Emit a placeholder line:
  `[binary block <uri> (<mimeType>), <N> base64 chars — not inlined]`.
- `mcp_list_resources` / `mcp_list_prompts`: render a compact bullet list (`uri`
  + `name`/`description`; for prompts, declared `arguments` with `required` flag).
- `mcp_get_prompt`: render each message as `role: <content-as-text-if-text>`;
  non-text content blocks (image/resource union — `PromptMessage.content` is
  `unknown` by spec, `@/mcp/resources/port.ts:60-66`) get a typed placeholder,
  NOT a parse attempt (the codec owner is the consumer, per H19's note).

This rendering is PURE and lives in the tool slice (no `@/mcp`). It is the
analogue of `get_task.ts:56-62`'s result-string assembly.

### 4.3 Size caps (resource-read DoS guard)

A hostile/large resource can return megabytes. Cap rendered output the same way
the existing tool surface caps results — reuse the shared output cap
(`capResultText` already used by `client.callTool`, `src/mcp/client.ts:402`) at
the RENDER step in the tool (not in `@/mcp` — the tool owns presentation). Default
cap configurable via the manifest gate slot (no new magic number invented here;
adopt the existing tool-output cap value — see §8 risk).

### 4.4 default-OFF, caller-wired

Identical contract to tasks: the four tools exist ONLY when the apps layer wires
a `ResourcesHandle`, and the bridge only wires one when the connected server
advertised `resources` and/or `prompts`. A server with neither ⇒ zero new tools ⇒
byte-identical load. If a server advertises `resources` but not `prompts` (or
vice-versa), the bridge can still wire all four tools — the missing-capability
ones return the typed `unsupported` result at call time (cheap + honest), OR the
bridge can split into two tool subsets keyed on capability (cleaner; recommended,
mirrors how H19 gates each method independently). **Recommendation: split** —
`mcp_*_resource*` wired iff `serverSupportsResources()`, `mcp_*_prompt*` wired iff
`serverSupportsPrompts()`.

---

## 5. 통합 (Integration)

### 5.1 Client→handle adapter (`@/mcp`)

Add `src/mcp/resources/client-port.ts` mirroring `tasks/client-port.ts`:

```ts
export const resourcesPortOver = (rpc: ResourcesRpc): McpResourcesPort => ({ … })
export const clientResourcesPort = (client: McpClient): McpResourcesPort =>
  resourcesPortOver(client)
```

Each method delegates to the already-landed `client.listResources()` etc.
(`McpClient` already exposes them — this adapter is a thin pass-through that maps
`McpResult<T>` straight onto the port shape). Export both through
`src/mcp/resources/index.ts` + `src/mcp/index.ts` (mirror tasks barrel).
A supervisor-aware `resourcesPortOver(sup)` (over `McpReconnectSupervisor`)
mirrors `tasksPortOver(sup)` for the auto-restart path.

### 5.2 Bridge (`src/agent/mcp-bridge.ts`)

Add, mirroring `tasksToolsFor` / `supervisedTasksToolsFor`:

```ts
const resourcesToolsFor = (client: McpClient): Tool[] => {
  const out: Tool[] = []
  const handle: ResourcesHandle = clientResourcesPort(client)
  if (client.serverSupportsResources()) out.push(/* list_resources, read_resource */)
  if (client.serverSupportsPrompts())   out.push(/* list_prompts, get_prompt */)
  return out
}
```

Push into the `tools` array in `loadSingle` (after `:352`) and the supervised
equivalent in `loadSupervised` (after `:314`). Because these come back inside
`loadMcpTools`'s returned `tools`, they land in `input.mcpTools` at assembly and
are auto-tagged `mcp` origin (§3.3) — the H2 envelope is free.

### 5.3 Manifest row (SSOT — REQUIRED, or CI fails)

Add one grouped row in `src/tool/surface/manifest.ts` next to the tasks row:

```ts
{
  name: "mcp_list_resources",
  group: ["mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt"],
  origin: "@/tool/mcp_resources (mcpResourcesTools)",
  gate: { kind: "config-slot", slot: "ResourcesHandle (apps MCP wire)" },
  default: { cli: "opt-in" },
  risk: "network",   // outbound RPC to a third-party server (cf. advisor row)
  adr: "<N3 ADR#>",
  note: "MCP resource/prompt read surface. Wired only when a server advertises resources/prompts + the apps layer wires a ResourcesHandle. Output is mcp-origin ⇒ H2 untrusted-source envelope applies.",
},
```

(`risk:"network"` because each call is an outbound RPC; tasks uses `"meta"` since
it's control-plane. Resource READ exfiltrates server data into the transcript, so
`network` is the honest class.)

### 5.4 feature-catalog (`tools/feature-catalog`)

Add an fc entry under the MCP axis: id e.g. `mcp.resource-tools`, status
`implemented`, reachability rooted at `mcpResourcesTools` → bridge
`resourcesToolsFor` → `loadMcpTools`. fc governs the FEATURE axis; the manifest
governs the tool-access axis — both rows are mandatory (the manifest header
`:1-20` and the fc reachability test both gate CI).

---

## 6. 테스트 계획 (Test plan)

### 6.1 hellgate over a FAKE handle (tool slice, no `@/mcp`)

`tests/unit/mcp-resource-tools-hellgate.test.ts`, mirroring the tasks hellgate.
A `FakeResourcesHandle` implementing `ResourcesHandle`. Adversarial cases:

- `unsupported` reason → tool yields `ok:false` with a clear message, never throws.
- `transport` / `malformed` reasons → `ok:false`, loop survives.
- hostile resource text containing a forged `</untrusted-source>` and an
  attributed opener `<untrusted-source name="internal">` → assert the tool output
  string, once passed through `wrapToolResult(…, "mcp", {enabled:true})`, is
  defanged (`defangEnvelopeTags`, `wrap.ts:61-70`) and cannot escape the envelope.
- giant text block (> cap) → rendered output is truncated to the cap, no OOM.
- blob-only block → placeholder emitted, base64 NOT inlined.
- `mcp_get_prompt` with non-text message content (`content:unknown`) → typed
  placeholder, no throw.
- `ctx.signal.aborted` before call → `ok:false output:"aborted before start"`
  (mirror `get_task.ts:31-34`).
- empty input / missing `uri` / missing `name` → zod rejection → `ok:false`.

### 6.2 provenance/origin unit

Assert `deriveProvenance("mcp_read_resource", "mcp") === "mcp"` and that the
assembled registry (`buildOriginMap` with the new tools in `mcpTools`) returns
`originOf("mcp_read_resource") === "mcp"`. This locks the H2 auto-wrap invariant.

### 6.3 bridge gating unit

`serverSupportsResources()===false && serverSupportsPrompts()===false` ⇒
`resourcesToolsFor` returns `[]` (byte-identical default-OFF). resources-only and
prompts-only servers wire the correct subset.

### 6.4 manifest drift + fc reachability

The existing two-way drift guard and fc reachability test must stay green with
the new row(s) added (they FAIL until the row exists — this is the forcing
function).

### 6.5 e2e

A smoke fixture (`tests/smoke/`) with a fake MCP server advertising `resources` +
`prompts`: agent calls `mcp_list_resources` → `mcp_read_resource` and the
transcript shows the envelope-wrapped content. Optional live tier behind the
existing smoke gates.

---

## 7. 단계 (Phases)

- **Phase 0 — H19 client methods: DONE (grep-verified §3.1).** The only residual
  H19-layer work N3 owns is the thin `clientResourcesPort` / `resourcesPortOver`
  adapter (§5.1) — H19 landed the raw `McpClient` methods but no port-over-client
  adapter (unlike tasks). Small, mechanical, mirrors `tasks/client-port.ts`.
- **Phase 1 — tools + handle:** `src/tool/mcp_resources/` (port mirror + 4 tool
  factories + index), the `@/mcp` adapter (§5.1), the bridge wiring (§5.2),
  manifest row (§5.3), fc entry (§5.4). hellgate + units (§6).
- **Phase 2 (optional, deferred):** prompt-template materialization (let
  `mcp_get_prompt` feed rendered messages directly into context rather than as a
  tool result), and `resources/subscribe` surfaced as a notification stream
  (NOT a request/response tool — see §8).

---

## 8. 리스크 / 대안 (Risks / Alternatives)

- **H19 dependency:** NOT a blocker — H19's client methods are landed (§3.1). The
  ONE genuine ordering constraint is the `clientResourcesPort` adapter (Phase 0
  residual), which N3 supplies. If a concurrent track lands it first, N3 consumes
  it; no double-build risk (the adapter is a pure pass-through over existing
  methods).
- **Untrusted resource/prompt content → H2 envelope:** resource bodies and prompt
  templates are third-party, adversary-controllable DATA. They are auto-wrapped
  because N3 tools register through `mcpTools` (origin `mcp` →
  `deriveProvenance`→`mcp` → `wrapToolResult`, §3.3). RISK: if a future refactor
  registers these tools OUTSIDE the `mcpTools` array (e.g. directly into
  `extraTools`), they'd be tagged `builtin`→`internal` and the envelope would be
  SKIPPED. Mitigation: the §6.2 origin unit test pins `originOf` to `mcp`; it
  fails the moment the wiring drifts. This is the single most important invariant
  in N3.
- **Resource-read size / DoS:** a server can return huge text or a base64 blob.
  Mitigation §4.3: blobs are never inlined; text is capped at the existing
  tool-output cap (`capResultText`). NO new magic threshold is introduced — reuse
  the value already governing `client.callTool`. If a dedicated cap is wanted,
  surface it as a manifest gate slot, not a hard-coded constant.
- **prompts/get is "read-only" but renders server-side:** `prompts/get` can, per
  spec, trigger server-side template expansion. We classify it read-only
  (no local mutation) but `risk:"network"` in the manifest — honest about the
  outbound effect. It still passes the normal permission path.
- **Alternative — fold into the generic `mcp__server__tool` bridge:** rejected.
  Resources/prompts are NOT `tools/call`; they're distinct method families with
  typed results. The generic bridge (`mcpToolToTool`, `mcp-bridge.ts:73`) only
  speaks `tools/call`. Typed sibling tools (the tasks precedent) give the model a
  clean, named surface and let us map the typed `McpResult` failures precisely.
- **Alternative — expose `resources/subscribe` as a tool:** rejected for Phase 1.
  Subscribe is fire-and-forget; value arrives via async
  `notifications/resources/updated` (`src/mcp/resources/notifications.ts`), which
  is a stream, not a tool result. Surfacing it as a request/response tool would
  mislead the model. Deferred to Phase 2 as a notification-channel feature.

---

## 9. 코드 위치 요약 (Code-location summary)

NEW (Phase 1):
- `src/tool/mcp_resources/port.ts` — `ResourcesHandle` mirror (leaf, no `@/mcp`)
- `src/tool/mcp_resources/{list_resources,read_resource,list_prompts,get_prompt}.ts`
- `src/tool/mcp_resources/index.ts` — `mcpResourcesTools(port)`
- `src/mcp/resources/client-port.ts` — `clientResourcesPort` / `resourcesPortOver`
  (Phase 0 residual)
- `tests/unit/mcp-resource-tools-hellgate.test.ts`

EDIT:
- `src/agent/mcp-bridge.ts` — `resourcesToolsFor` + push in `loadSingle`/`loadSupervised`
- `src/mcp/resources/index.ts`, `src/mcp/index.ts` — export the adapter
- `src/tool/index.ts` — re-export `mcpResourcesTools` + types
- `src/tool/surface/manifest.ts` — add the grouped row (§5.3)
- `tools/feature-catalog/*` (data) — add fc entry

REFERENCE (unchanged, relied upon):
- `src/mcp/client.ts:414-466` — H19 typed methods (the prerequisite)
- `src/mcp/resources/{port,codec}.ts` — H19 typed shapes + parsers
- `src/tool/mcp_tasks/*` — the template
- `src/mcp/tasks/client-port.ts:107,148` — the adapter template
- `src/runner/assemble/tooling.ts:210-230` — origin map (auto `mcp` tagging)
- `src/tool/origin.ts:95-110` — `deriveProvenance`
- `src/agent/dispatch.ts:991-995` + `src/agent/untrusted-envelope/*` — H2 envelope
