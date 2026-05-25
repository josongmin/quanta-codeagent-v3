# ADR-0286: Production `DeferredResultRegistry` — registry-managed deferred work

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0064 (legacy `DeferredResultRegistry` typed seam — the
  external-poller pattern this sibling replaces for new code, kept for
  back-compat), ADR-0130 (background subagent tools — sibling
  caller-wire/closed-port pattern), ADR-0287 (`async tool kind` +
  `poll_deferred` — direct consumer of this registry).
- **References**:
  `src/tool/deferred/port.ts` (closed `DeferredResultRegistry` port —
   `register(work) / poll / await / cancel / list`),
  `src/tool/deferred/types.ts` (`DeferredHandle { id, createdAt }`,
   5-arm `Status`, 5-arm `DeferredError` closed unions + literal anchors),
  `src/tool/deferred/default-registry.ts` (`DefaultDeferredResultRegistry`
   — Map-backed in-memory impl with per-handle `AbortController`, microtask
   worker, LRU eviction),
  `src/tool/deferred/legacy.ts` (legacy `DeferredResultRegistry` class
   moved into the slice so both surfaces coexist under
   `@/tool/deferred/*`),
  `src/tool/deferred/index.ts` (barrel — re-exports the legacy class under
   its historical name; the new port is reachable only via the explicit
   subpath to avoid the name collision),
  `tests/unit/tool/deferred-registry-hellgate.test.ts` (18 cases),
  `src/shared/runtime-config.ts`
   (`QUANTA_DEFERRED_CAP`, `QUANTA_ASYNC_TOOLS`).

## Context

The pre-ADR registry shipped under `src/tool/deferred.ts` (kept now in
`src/tool/deferred/legacy.ts`) is a pure parking lot for the
"external-poller" pattern: a tool yields a placeholder + handle; some other
code calls `registry.resolve(handle, result)` later. It has no executor,
no AbortController, no timeout, no LRU. ADR-0064 documented this seam as
"TYPE SURFACE ONLY".

That is a fine seam, but it cannot host an async-tool kind (ADR-0287) where
the registry itself OWNS the worker lifecycle. The async-tool wrapper has
to register an async function, get a handle immediately, schedule the work
on a microtask, expose 5 lifecycle states (`pending` / `running` /
`completed` / `failed` / `cancelled`), drive cooperative cancellation
through a per-handle AbortController, and bound memory via LRU.

These are genuinely different responsibilities. Widening the legacy class
in place would: (a) silently change its semantics for every existing
consumer, (b) couple every caller of the legacy API to AbortController +
microtask scheduling, (c) leak the LRU into a contract that never had it.

## Decision

Ship the production registry as a **sibling** under `@/tool/deferred/*`:

```
src/tool/deferred/
  port.ts             — closed DeferredResultRegistry interface (new)
  types.ts            — DeferredHandle (with createdAt), Status, DeferredError
  default-registry.ts — DefaultDeferredResultRegistry (concrete impl)
  legacy.ts           — moved-from-deferred.ts legacy class (untouched semantics)
  index.ts            — barrel: re-exports legacy under historic name
```

### Closed port

```ts
type DeferredWork = (signal: AbortSignal) => Promise<ToolResult>

interface DeferredResultRegistry {
  register(work: DeferredWork): DeferredHandle
  poll(handle: DeferredHandle): Status
  await(handle: DeferredHandle, timeoutMs?: number): Promise<Status>
  cancel(handle: DeferredHandle): void
  list(): readonly DeferredHandle[]
}
```

### Closed unions

```ts
interface DeferredHandle { readonly id: string; readonly createdAt: number }

type Status =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "completed"; result: ToolResult }
  | { kind: "failed"; error: DeferredError }
  | { kind: "cancelled"; error: DeferredError }

type DeferredError =
  | { kind: "unknown-handle"; id: string }
  | { kind: "worker-threw"; message: string }
  | { kind: "cancelled" }
  | { kind: "await-timeout"; timeoutMs: number }
  | { kind: "handle-evicted"; id: string }
```

Both unions are paired with literal-anchor `as const satisfies` tuples
(`ALL_DEFERRED_STATUS_KINDS`, `ALL_DEFERRED_ERROR_KINDS`) so adding a 6th
kind is a `tsc` error here AND at every exhaustive switch.

### Invariants (each sealed by a hellgate case)

1. **Per-handle `AbortController`.** `cancel()` aborts it; the worker
   receives the signal and is expected to cooperate.
2. **Microtask scheduling.** `register()` returns BEFORE the worker runs;
   `poll()` between `register` and the next tick sees `pending`. The worker
   moves the handle to `running` BEFORE awaiting any I/O so an intermediate
   `poll()` sees the correct transitional state.
3. **LRU eviction.** When live-count > cap, the OLDEST non-pending/non-
   running entry is dropped; pending/running entries are NEVER evicted
   (would orphan a worker's result with no recovery channel). When every
   live entry is pending/running we accept the over-cap state silently.
4. **`poll()` is total.** Unknown handle ⇒
   `{kind:"failed", error:{kind:"unknown-handle", id}}`; evicted handle ⇒
   `{kind:"failed", error:{kind:"handle-evicted", id}}`.
5. **`await()` is total.** Same posture. `timeoutMs` returns
   `{kind:"failed", error:{kind:"await-timeout", timeoutMs}}` WITHOUT
   cancelling the worker (caller may re-await for the real outcome).
6. **No zombie Promise.** Awaiters detach on terminal transition AND on
   timeout. A failed/cancelled/completed handle has zero waiters left.
7. **Default-OFF.** The registry is a leaf module; nothing imports it
   from a composition root by default. The agent only constructs one
   when `runtimeConfig().asyncTools === true` (ADR-0287).

### Coexistence with the legacy class

The legacy `DeferredResultRegistry` is moved verbatim into
`src/tool/deferred/legacy.ts` and re-exported from
`src/tool/deferred/index.ts` under its historic name. The new port (also
named `DeferredResultRegistry`) is reachable ONLY via the explicit subpath
`@/tool/deferred/port`. Together: every existing importer
(`@/tool/index.ts` → `DeferredResultRegistry`, `UnknownDeferredHandleError`)
is byte-identical; new code addresses the production registry via
`@/tool/deferred/default-registry` (the concrete) or
`@/tool/deferred/port` (the interface).

### Env knobs

- `QUANTA_DEFERRED_CAP` — max live handles in the production registry.
  Defaults to 1000 (`DEFAULT_DEFERRED_CAP`). Invalid values warn once
  on stderr and fall back to the default.

## Consequences

**Positive**

- Hellgate (18 cases) locks the surface. The closed-union literal anchors
  fail-compile on drift.
- Sibling layout means the legacy class (and every caller of it) is
  byte-identical. Zero regression risk for the old seam.
- The production registry can host arbitrary async tools without each
  tool re-implementing AbortController + microtask + LRU.
- The 5-state lifecycle is a closed union; consumers branch exhaustively.

**Negative / deliberate hold**

- **Sqlite persistence** for cross-restart deferred work is a follow-up.
  The current registry loses every pending/running handle on process
  exit. A future sibling (`SqliteDeferredResultRegistry`) under the same
  port can adopt the production registry's API surface verbatim.
- **No cross-process registry.** A subagent or worker that crosses a
  process boundary cannot share handles with the parent. Same reason —
  it's a separate adapter behind the same port.
- The legacy class's `register(hint?: string)` shape is incompatible with
  the new `register(work)` shape — they cannot be merged without breaking
  every existing caller. The two will coexist indefinitely.

## Alternatives considered

- **Widen the legacy class.** Rejected — would change its semantics
  (introducing AbortController + microtask scheduling silently breaks
  every external poller that expected pure parking-lot behavior).
- **Use `Promise<ToolResult>` directly instead of a handle.** Rejected —
  loses the LLM-visible identity. The LLM has to call `poll_deferred`
  with a string id that survives JSON serialization.
- **Single mixed union for `Status | DeferredError`.** Rejected — they
  are genuinely different surfaces (one is a lifecycle, the other is an
  error reason). Mixing them forces every consumer to handle arms it
  never sees.
- **Throw on unknown / evicted handle.** Rejected — `poll()` and
  `await()` are the LLM-visible probes; throwing forces every caller
  into try/catch and breaks the closed-union exhaustiveness story.
