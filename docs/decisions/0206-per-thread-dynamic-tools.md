# ADR-0206: Per-thread dynamic tools with `defer_loading`

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0011 (subagent slice — thread parent of dynamic registration),
  ADR-0196 (MCP Tasks — `namespace` field aligns with MCP server tools group),
  ADR-0201 (`fork-session` — sibling helper primitive plane).

## Context

Codex's tool plane is **thread-scoped**: each thread gets its own dynamic
tool registry, MCP servers register tools under a `namespace` (MCP server
name), and each registration can carry `defer_loading` so the heavy
factory only runs on first use. quanta today only has a **global**
`toolRegistry` (`src/tool/index.ts`), so every session sees the same
tool surface and there is no place for thread-local MCP groups or for
lazy factories.

The gap matters for three concrete consumers:

- **MCP server tools** (ADR-0196): a MCP server attached to ONE thread
  should not pollute every other thread's registry.
- **Subagent threads** (`src/agent/subagent-background.ts`): a child
  thread may want a NARROWER or BROADER toolset than its parent.
- **Lazy expensive tools**: e.g. a tool whose factory parses a 500KB
  schema; it should not run until the LLM actually calls the tool.

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** No call site that omits a
  `ThreadToolRegistry` sees any change — the global `src/tool/index.ts`
  remains the authority and is `unchanged` in this ADR.
- **Plane-clean.** This is a HELPER PRIMITIVE: the slice sits next to
  `fork-session` / `conversation-checkpoint` / `plan-queue` and the
  loop (`@/agent/loop`, `@/agent/dispatch`) does NOT import it.
- **Closed-port DIP.** `ThreadToolRegistry` is the port;
  `inMemoryThreadToolStore` + `defaultLazyResolver` are the
  default-impls. Future test-doubles satisfy the port.
- **`exactOptionalPropertyTypes: true`.** Every `DynamicToolSpec` field
  is REQUIRED; only `namespace` is conditional and uses `omitUndef`
  (no `undefined` literal slot).
- **No mutation of registered spec.** Lazy resolution caches the
  factory result inside the resolver, not on the spec — so the spec
  object stays referentially stable and `Object.freeze`-able.

## Decision

Stand up a new helper slice `src/agent/thread-tools/` (6 files +
barrel):

```
src/agent/thread-tools/
  port.ts            — `ThreadToolRegistry` interface (4 methods + 1 namespace-op)
  types.ts           — `DynamicToolSpec` / `RegError` / `ResError` (closed unions)
  in-memory-store.ts — `Map<threadId, Map<toolName, DynamicToolSpec>>` default impl
  lazy-resolver.ts   — single-flight `factory()` cache for `deferLoading=true`
  composer.ts        — merge `global + perThread` (per-thread overrides by name)
  index.ts           — barrel
```

Public shapes:

```ts
interface DynamicToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: object
  readonly namespace?: string
  readonly deferLoading: boolean
  readonly factory: () => Tool
}

type RegError =
  | { code: "duplicate-tool"; existing: DynamicToolSpec; message: string }
  | { code: "factory-failed"; cause: unknown; message: string }

type ResError =
  | { code: "not-found"; message: string }
  | { code: "factory-failed"; cause: unknown; message: string }

interface ThreadToolRegistry {
  register(threadId: string, spec: DynamicToolSpec): Result<void, RegError>
  list(threadId: string, opts?: { includeDeferred?: boolean }): readonly DynamicToolSpec[]
  resolve(threadId: string, toolName: string): Result<Tool, ResError>
  evict(threadId: string): void
  evictNamespace(threadId: string, namespace: string): void
}
```

Semantic mapping:

| op                            | effect                                                                   |
|-------------------------------|--------------------------------------------------------------------------|
| `register(tid, spec)`         | per-thread Map insert; duplicate `name` → `Err("duplicate-tool")`        |
| `register(spec.deferLoading=false)` | factory() runs eagerly inside register; throw → `Err("factory-failed")` |
| `list(tid)`                   | default excludes `deferLoading=true` specs whose factory has not run     |
| `list(tid, {includeDeferred:true})` | returns ALL specs                                                  |
| `resolve(tid, name)`          | unknown name → `Err("not-found")`. For deferred, runs factory once + caches |
| `evict(tid)`                  | drops the whole per-thread Map + the resolver's cache for it             |
| `evictNamespace(tid, ns)`     | drops every spec whose `namespace === ns` in that thread + its caches    |

Composer (`composer.ts`):

```ts
composeTools(
  global: readonly Tool[],
  perThread: readonly Tool[],
): readonly Tool[]
```

Per-thread tools override global tools by `name` (Codex MCP-server
override semantic). The composer is PURE — it does not call the
registry directly; callers do `registry.list(tid).map(spec =>
resolve(tid, spec.name))` then hand the merged array to
`composeTools(global, perThread)`.

Single-flight on lazy resolve: `resolve(tid, name)` for a
`deferLoading=true` spec MUST call `factory()` exactly once even
under N concurrent callers. The resolver stores a synchronous
result (factory is sync — `() => Tool`), so the single-flight
guard is a simple Map check before / after the call.

Default-OFF wiring posture (mirrors `fork-session`):

- Caller never instantiates the registry ⇒ the global toolRegistry
  is the ONLY source of tools (today's behavior, byte-identical).
- Caller instantiates a `ThreadToolRegistry` at thread start +
  `register(tid, …)` per MCP server / per subagent tool ⇒
  thread-local tools surface alongside global tools through
  `composeTools`.

## Hellgate (15 cases, all default-OFF)

`tests/unit/agent/thread-tools-hellgate.test.ts`:

| id          | seal                                                                       |
|-------------|----------------------------------------------------------------------------|
| HELL-TT-01  | `register` + `list` round-trip                                             |
| HELL-TT-02  | duplicate `name` → `Err("duplicate-tool", { existing })`                   |
| HELL-TT-03  | `list` on unknown threadId → `[]` (no throw)                               |
| HELL-TT-04  | `resolve` unknown tool → `Err("not-found")`                                |
| HELL-TT-05  | `deferLoading=false` → factory runs at register time                       |
| HELL-TT-06  | `deferLoading=true` → first resolve runs factory; 2nd uses cached          |
| HELL-TT-07  | cross-thread isolation: register on TID-A invisible to TID-B               |
| HELL-TT-08  | `evictNamespace(tid, ns)` drops only specs in that namespace               |
| HELL-TT-09  | `evict(tid)` drops every spec in that thread                               |
| HELL-TT-10  | composer: per-thread name wins over global name                            |
| HELL-TT-11  | factory throws → `Err("factory-failed", { cause })`                        |
| HELL-TT-12  | concurrent `resolve` × 2 on deferred → factory runs exactly once           |
| HELL-TT-13  | `list` default excludes deferred-not-yet-resolved entries                  |
| HELL-TT-14  | returned spec is frozen (mutation throws / no-op in strict)                |
| HELL-TT-15  | 1000 registrations → `list` returns 1000 in O(n) without throwing          |

## Consequences

- **+ Codex parity** on thread-scoped tools + namespace + lazy
  factories without touching the global registry.
- **+ MCP-ready:** MCP servers can register their tools under
  `namespace: serverName` and `evictNamespace` is the natural
  shutdown hook.
- **+ Subagent-friendly:** a background thread can carry a different
  toolset by mixing global + its own `perThread` array.
- **−** New in-memory map (per-thread → toolName → spec) keyed by
  `threadId`. Caller MUST `evict(threadId)` on thread close — same
  posture as `ConversationCheckpointStore`'s `pruneId`.
- **−** Lazy resolver cache is process-local (no persistence). A
  process restart re-runs every `deferLoading=true` factory on first
  call; this is the design intent (factories are pure constructors).

## Follow-up

- A future `ThreadToolRegistry` adapter wired from the dispatch seam
  so the loop can `composeTools(global, registry.list(tid).map(...))`
  with one call. Today the composer is exposed and any consumer wires
  it itself.
- A `MAX_PER_THREAD` cap + LRU eviction across threads if memory
  pressure becomes a concern in production sessions with hundreds of
  thread ids — currently the caller is responsible for `evict(tid)`.
