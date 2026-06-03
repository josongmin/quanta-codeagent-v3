# ADR-0468: NDJSON live-event introspection sink

**Status:** Accepted (2026-06-03)
**Type:** New `@/observability` slice (pure ports, default-OFF). The HTTP/file
ADAPTER is deliberately NOT in this slice — it lands at the composition root.
**Scope:** `src/observability/ndjson/` (`types.ts`, `encoder.ts`,
`ring-buffer.ts`, `sinks.ts`, `index.ts`) +
`tests/unit/observability-ndjson-introspection-hellgate.test.ts`. No shared file
is edited; activation wiring is listed as an integration TODO.

## Context

Cursor ships a per-workspace introspection channel (`cursor-ndjson-ingest`): a
small HTTP server bound to an auto-allocated port (observed range ~7242-7942)
that accepts a stream of **newline-delimited JSON** event records for real-time
tracing, restarts on config change, and also tails the events to
`.cursor/debug.log`. It lets an external monitor watch the agent's live event
firehose (tool start/stop, LLM stream deltas, permission decisions, subagent
forks) without parsing the agent's stdout.

We want the same capability, but `@/observability` is fence-restricted to import
ONLY `@/shared` (biome `noRestrictedImports`, ARCHITECTURE.md §1). A socket /
filesystem adapter therefore CANNOT live in this slice. The faithful design is
to split the mechanism: the **pure** half (encode + bound + buffer) lives here
behind a port; the **IO** half (open a socket, write `.cursor/debug.log`) is an
adapter constructed at the composition root in `@/apps`, satisfying the port.

## Decision

Add a pure, plane-clean `@/observability/ndjson` slice:

### Ports & primitives

```ts
interface NdjsonEvent { readonly type: string; readonly ts?: number; readonly [k: string]: unknown }

interface NdjsonEncoder { encode(e: NdjsonEvent): Result<string, NdjsonSinkError> }   // deterministic, single line, no \n
interface NdjsonSinkPort { emit(e: NdjsonEvent): Result<void, NdjsonSinkError> }       // no-throw

type BackpressurePolicy = "drop-oldest" | "reject-newest"
interface RingBufferConfig { readonly capacity: number; readonly policy: BackpressurePolicy } // capacity REQUIRED
```

- **Deterministic encoder** — keys sorted lexicographically at every nesting
  level so the SAME event encodes to byte-identical bytes across calls and
  processes (diff-based introspection + caching depend on this). Array order is
  preserved (semantic). Every control char — crucially `\n`/`\r` — is
  JSON-escaped, so an embedded newline in a value can NEVER split one logical
  event into two NDJSON records (THE correctness property of NDJSON framing). No
  trailing newline: the writer owns the `\n` framing.

- **No-throw** — `BigInt` / `function` / `symbol` / circular reference /
  non-finite number all return `Err({kind:"encode-failed"})`, never a throw. A
  defensive post-encode guard rejects any line that still contains a raw newline.

- **Bounded ring buffer** — `capacity` is a REQUIRED, strictly-validated config
  field (positive integer), NOT a magic constant; `0` / `-1` / `3.5` / `NaN`
  → `Err({kind:"invalid-config"})`, never a silent clamp (clamping hides
  operator mistakes). `drop-oldest` evicts the oldest line and counts the drop;
  `reject-newest` refuses the newcomer and surfaces `buffer-full`. The spec's
  "block" option is realized as `reject-newest`'s synchronous back-signal — a
  pure structure cannot suspend, so it returns a typed full-signal and lets the
  caller decide (await a drain, sleep, drop).

- **Three sinks**:
  - `NullNdjsonSink` — the DEFAULT-OFF sink; `emit()` is a no-op returning
    `ok()` for ANY event (it never even encodes, so an un-encodable event is
    harmless). Byte-identical to "no NDJSON introspection".
  - `createCapturingNdjsonSink(config)` — in-memory test sink; encodes + buffers
    through the REAL ring buffer so tests pin exact line bytes + overflow.
  - `createBufferedNdjsonSink(config, flush)` — production-shaped pure core;
    encode → ring-buffer → hand drained lines to an injected `flush(lines)`
    callback. The composition-root HTTP/file adapter supplies `flush`; a
    throwing `flush` is contained (best-effort drain — introspection is not an
    audit log).

### Default-OFF gate

`QUANTA_NDJSON_INGEST_PORT=<port>` (a port number, Cursor-style) OR a configured
file path enables the channel at the composition root. When neither is set, the
root wires `NullNdjsonSink` and the agent is byte-identical to today. NO `@/apps`
file imports this barrel yet (the slice fence forbids editing shared files here);
activation is the integration TODO below.

### Why "capacity is required" and not a default

A buffered observability channel that silently picks its own bound hides the
memory/loss trade-off from the operator. Requiring `capacity` at the wire site
makes the cap auditable and forces a conscious loss-model choice
(`drop-oldest` vs `reject-newest`). This follows the "no arbitrary thresholds"
discipline — there is no defensible universal default for "how many live events
to hold", so we refuse to invent one.

## Consequences

- A complete, deterministic, no-throw NDJSON introspection core, fully tested in
  isolation, with the IO concern cleanly deferred to the composition root.
- Zero behavioural change until an operator sets the gate (default-OFF).
- The encoder doubles as a stable serializer any future observability surface
  can reuse (it is pure and dependency-free).

## Negative invariants

- **Encoder is pure** — no clock, no IO, no randomness, no `toJSON` honoring
  (would be non-deterministic). `ts` is supplied by the producer, never
  synthesized.
- **`@/observability/ndjson` never imports net/fs/`@/agent`/`@/tool`/`@/llm`** —
  the socket/`.cursor/debug.log` adapter lives ONLY at the composition root.
- **No silent capacity clamp** — invalid capacity is a loud `Err`.
- **The line separator never appears raw inside a line** — escaped or rejected.
- **`NullNdjsonSink` allocates/encodes nothing** — the OFF path is a literal
  no-op, not a "discard after encode".
- **A throwing injected `flush` never propagates to the producer.**

## Integration TODO (human applies at activation; do NOT do in this slice)

1. **Composition-root adapter** (`src/apps/agent/**` or `src/apps/cli/**`):
   implement an `NdjsonSinkPort` adapter that opens an HTTP server on
   `QUANTA_NDJSON_INGEST_PORT` (or appends to the configured path) and supplies
   the `NdjsonFlush` callback to `createBufferedNdjsonSink({capacity, policy},
   flush)`. Faithful Cursor shape: bind a localhost HTTP listener, write each
   line + `"\n"` to connected clients AND to `.cursor/debug.log`; restart on
   config change. The adapter reads `process.env` via the existing `EnvLike`
   convention — this slice never touches `process.env`.
2. **Producer wiring** (`src/agent/loop.ts` and/or dispatch instrument): call
   `sink.emit({type, ts: Date.now(), …})` at each event boundary. Default-wire
   `NullNdjsonSink` when the gate is unset so the loop is byte-identical.
3. **Feature-catalog `knobs`** already declares `QUANTA_NDJSON_INGEST_PORT`;
   confirm the env name matches the adapter at integration.

## Alternatives considered

- **Put the HTTP server in `@/observability`** — rejected: violates the slice
  fence (`@/observability` may import only `@/shared`). Port inversion is the
  prescribed pattern (ARCHITECTURE.md §1).
- **Unbounded queue** — rejected: a slow monitor would leak memory unbounded.
- **Synchronous blocking write on backpressure** — rejected: would stall the
  agent loop; `reject-newest` back-signalling gives the caller the choice
  without blocking the hot path.
- **Default capacity constant** — rejected per "no arbitrary thresholds"; the
  cap is a required, auditable wire-site field.
