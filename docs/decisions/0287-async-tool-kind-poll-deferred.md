# ADR-0287: Async tool kind + `poll_deferred` — `defineToolAsync` + LLM probe

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0286 (production `DeferredResultRegistry` —
  REQUIRED dependency), ADR-0064 (legacy deferred seam — not used by this
  ADR; new tools opt into the registry-managed pattern), ADR-0130
  (background subagent tools — sibling caller-wire pattern).
- **References**:
  `src/tool/async-helper.ts` (`defineToolAsync` wrapper +
   `DefineToolAsyncSpec` + `DEFAULT_PENDING_MESSAGE`),
  `src/tool/poll_deferred.ts` (`pollDeferredTool` factory +
   `pollDeferredInputSchema`),
  `src/agent/dispatch.ts` (1-3 line wire — prepends
   `<deferred handle="..."/>` envelope when `result.deferred` is present),
  `src/shared/runtime-config.ts` (`QUANTA_ASYNC_TOOLS`),
  `tests/unit/tool/async-tool-dispatch-hellgate.test.ts` (15 cases).

## Context

ADR-0286 ships a production `DeferredResultRegistry` that owns the
lifecycle of registered async work (microtask scheduling, AbortController,
LRU, 5-state `Status`). What is still missing is the *tool kind* that uses
the registry — a wrapper that lets a tool author write `async (input,
ctx, signal) => ToolResult` and have the framework register the work,
yield a placeholder + handle, and surface the handle to the LLM in a
recognizable format so the LLM can call back to retrieve the final result.

Three concrete needs:

1. **A `defineToolAsync` factory** that builds a `Tool` whose terminal
   result is provisional (`output` = placeholder text; `deferred` =
   handle id). The factory accepts the registry as a closed-port DI
   parameter — default-OFF degradation to synchronous execution when the
   registry is `undefined`.
2. **A `poll_deferred` tool** the LLM can call to ask "what is the status
   of handle X?". Round-trips the 5-state `Status`; when `completed` it
   unwraps the inner `ToolResult` into the tool's terminal output.
3. **A dispatch wire** that prepends a stable `<deferred handle="..."/>`
   envelope to any tool result whose `deferred` field is set, so the LLM
   can branch on the format without parsing the placeholder text.

## Decision

### `defineToolAsync` wrapper (`src/tool/async-helper.ts`)

```ts
interface DefineToolAsyncSpec<I, O> {
  name: string; description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  isConcurrencySafe(input: I): boolean
  work(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>
  pendingMessage?: string
  registry?: DeferredResultRegistry        // FACTORY-time DI
  hitlTier?:        DefineToolSpec<I, O>["hitlTier"]
  extractShellCommand?: DefineToolSpec<I, O>["extractShellCommand"]
  classifySource?:  DefineToolSpec<I, O>["classifySource"]
}

defineToolAsync<I, O>(spec): Tool<I, O>
```

Behavior:

- `registry === undefined` ⇒ wrapper RUNS `work` synchronously and yields
  the result. **Default-OFF** — byte-identical to a plain `defineTool` for
  the existing pipeline. Safety floor: a host that forgets to wire the
  registry still gets a working (just synchronous) tool.
- Otherwise ⇒ `registry.register((signal) => work(input, ctx, signal))`,
  get the handle, yield a placeholder result with `deferred: {id,
  hint: pendingMessage}` (legacy-shape marker on `ToolResult.deferred`,
  not the new `DeferredHandle` from ADR-0286 — they have different
  shapes; the dispatch wire keys on the legacy `{id}` field).

### Why FACTORY-time injection (not `ToolContext`)

The registry is passed via the spec, not via `ctx.deferredRegistry`. Two
reasons:

1. **`ToolContext` is slice-fence-locked.** Adding a new field would
   ripple into the duck-typed mirror discipline documented in `types.ts`
   and the dispatch-side `buildToolContext`. The `@/tool` slice's
   `types.ts` is part of the constraint-protected surface.
2. **Lifecycle ownership.** An async tool's handles belong to ONE
   registry for ITS lifetime. Moving handles between registries mid-
   session would break the LRU + AbortController invariants. Factory-
   time injection makes the relationship structural.

### `poll_deferred` tool (`src/tool/poll_deferred.ts`)

```ts
pollDeferredTool(registry: DeferredResultRegistry): Tool<PollDeferredInput>

// input: { handle: string; awaitMs?: number ∈ [0, 60_000] }
```

Behavior:

- `awaitMs` absent or `0` ⇒ `registry.poll({id: input.handle, createdAt: 0})`.
- `awaitMs > 0` ⇒ `registry.await(...)` with the timeout.
- Renders the closed 5-arm `Status` literally:
  - `[pending] not started`
  - `[running] worker in progress`
  - `[completed]` (then unwraps the inner result into `output` with a
    `<completed via=deferred handle=X>` prefix for traceability)
  - `[failed] <reason>` (closed 5-arm `DeferredError` renderer)
  - `[cancelled] <reason>` (same renderer)
- Caller-wire (default-OFF). Composition root passes the same registry
  it wired to every `defineToolAsync` instance.

### Dispatch wire (1-3 line edit in `src/agent/dispatch.ts`)

```ts
const { output: redacted, hits } = applyRedaction(result.output, call, config)
const output =
  result.deferred !== undefined
    ? `<deferred handle="${result.deferred.id}"/>\n${redacted}`
    : redacted
```

Absent `result.deferred` ⇒ `output` is unchanged (byte-identical
default-OFF). Present ⇒ the LLM sees a stable envelope it can recognize.

### Env knob

- `QUANTA_ASYNC_TOOLS` — activate the async-tool composition. When false
  (default) the composition root does NOT construct a
  `DefaultDeferredResultRegistry` and does NOT register `poll_deferred`;
  every `defineToolAsync(...)` instance has `registry: undefined` and
  degrades to synchronous execution.

## Consequences

**Positive**

- 15-case hellgate locks the contract end to end: registration, polling,
  unknown-handle, throw-mid-work, dispatch envelope, multi-tool
  isolation, parent-abort drain, sync-tool byte-identity, AbortSignal
  threading, 1000-cycle leak ceiling, cancel-via-tool, registry-empty
  uniformity, active-registry pickup.
- The 3-line dispatch wire is the smallest possible surface: detect
  `result.deferred`, prepend an envelope. Absent the marker, dispatch is
  byte-identical to the pre-ADR path.
- Factory-time DI keeps the seam structural — you cannot accidentally
  swap registries per-call.
- Default-OFF degradation means a forgotten wire never breaks the tool.

**Negative / deliberate hold**

- **No streaming intermediate results.** The placeholder is a single
  text; progress (`tool_progress` event) is not threaded through the
  registry. A future ADR can extend the work signature with a `progress`
  callback if the need arises.
- **No batch poll.** `poll_deferred` takes one handle at a time. A
  future variant `poll_deferred_batch` is straightforward but unjustified
  without a real consumer.
- The dispatch wire reads `result.deferred` (legacy `{id, hint?}` shape),
  not the production `DeferredHandle` (`{id, createdAt}`). Bridging the
  two would mean changing `ToolResult.deferred`'s type — which is
  load-bearing for the legacy seam (ADR-0064). Keeping the bridge in
  the wrapper (which knows both) is the right place.

## Alternatives considered

- **Add `ctx.deferredRegistry?` to `ToolContext`.** Rejected — see
  "Why FACTORY-time injection" above.
- **Auto-register `poll_deferred` whenever ANY async tool is built.**
  Rejected — would mean global mutable state. Caller-wire is structural.
- **Have `defineToolAsync` lazy-poll the registry itself and yield the
  final result.** Rejected — collapses the round-trip the LLM uses to
  notice that the work is async (the LLM cannot interleave other tools
  during the yield), defeats the whole point.
- **Inline a `<status>...<status>` JSON envelope.** Rejected — the LLM
  is better at recognizing stable XML-ish tags than at parsing JSON
  inside a tool_result. The `<deferred handle="..."/>` form is a single
  recognizable token.
