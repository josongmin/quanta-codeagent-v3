# ADR-0251: Streaming boomerang (parent ↔ child progressive consumption)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0218 (mode-typed delegation — result-only sibling;
  this slice ADDS the progressive consumption surface ADR-0218
  deliberately left out), ADR-0130 (background subagent scheduler), ADR-0145
  (subagent + plan queue), ADR-0166 (conversation seed replay)
- **References**:
  `src/agent/streaming-boomerang/{port,types,default-streamer,index}.ts`,
  `tests/unit/agent/streaming-boomerang-hellgate.test.ts`

## Research grounding

Roo's "Boomerang / Orchestrator" mode does not just return a result — the
parent consumes the child's progress INCREMENTALLY. The user sees text
flowing from the child via the parent's surface as it is produced, not
after the child terminates. This is materially different from the
result-only sibling pattern (ADR-0218, Devin sub-task, Codex
`spawn_agent`) where the boundary is "fire and await a single typed
result".

Empirically observed in `.extracted_source/roo-cline/**` ("orchestrator"
mode flow): the parent subscribes to a chunk stream and chooses, per
chunk, whether to render / persist / discard / abort. The child
terminates with a final result chunk that mirrors the ADR-0218
`BoomerangResult` shape.

The shapes the four vendors agree on (per
`docs/analysis/경쟁사리뷰/`):

- **Roo orchestrator** — chunked output with `progress` events + final
  `result` event; consumer-driven backpressure (no fire-and-forget).
- **Codex `spawn_agent` + JSON-RPC events** — emits
  `agent_message_delta` events the parent UI streams to the user.
- **Cursor `subagent_await`** — handle-based polling; same progressive
  surface in spirit, different API shape.
- **Anthropic SDK streaming** — `MessageStream` async iterator that emits
  `delta` events + a final `message` event.

ADR-0218 shipped the typed result half. This ADR closes the streaming
half — as a default-OFF sibling slice, NOT a replacement.

## Context

A pure result-only boomerang (ADR-0218) has two operational gaps:

1. **No mid-flight feedback** — a 5-minute child appears frozen to the
   parent. The parent has nothing to render in the meantime; the
   surface (CLI/TUI/Web) cannot show "the child is still working".
2. **No early-cancel signal** — without progress chunks, the parent
   has no signal to ABORT mid-flight on (e.g. the user types ctrl-c
   after the first 50 tokens because the child went off-task).

Both are addressable via a progressive consumption surface:

- The parent gets an `AsyncIterable<BoomerangChunk>`; each `progress`
  chunk is renderable as-is.
- The parent `break`-ing the iterator (or aborting the supplied signal)
  triggers child cleanup (no leaked promise, no zombie subagent).

The closed-port + default-OFF posture is preserved — the loop never
constructs a `StreamingBoomerang`; callers (apps / tier1 builders / a
future CLI command) opt in via `AgentConfig`.

## Decision

Add a closed-port slice `src/agent/streaming-boomerang/` that closes
both gaps without modifying ADR-0218:

- **`StreamingBoomerang`** (`port.ts`) — single method
  `spawn(spec): AsyncIterable<BoomerangChunk>`. The returned iterable
  is single-pass; multiple consumers must each call `spawn` for an
  independent stream.
- **`BoomerangChunk`** (`types.ts`) — closed 3-arm union:
  - `{ kind: "progress", text }` — incremental text payload.
  - `{ kind: "result", value }` — terminal success carrier
    (mirrors ADR-0218 `BoomerangResult`).
  - `{ kind: "error", errorKind }` — closed 6-arm errorKind union
    (`cancelled | budget-overflow | mode-missing | runner-error |
    timeout | invalid-spec`). Iterator finishes after this chunk; no
    more chunks emitted.
- **`StreamingBoomerangError`** (`types.ts`) — programmer-bug surface
  for invalid-by-construction spec (empty prompt, invalid mode passed
  via type assertion). Operational invalid-spec is an `error` chunk.
- **`defaultStreamer`** (`default-streamer.ts`) — wraps a producer
  function (host's bridge to the actual agent loop) into a chunked
  `AsyncIterable` with:
  - AbortSignal observation (mid-stream abort → finalize cleanly).
  - Backpressure-safe queue (consumer pauses ⇒ producer waits,
    bounded buffer, no unbounded memory).
  - `break` / `return()` honors child cleanup (calls the producer's
    `abort()` hook).
  - No zombie promise after iterator `done` (the producer's
    settle-promise is awaited in the cleanup path).

## Contracts (HARD)

1. **NO-THROW past spawn** — `spawn()` itself never throws for
   operational failure (invalid spec → first chunk is an `error` chunk
   with `errorKind:"invalid-spec"`, then iterator done). THROWS only for
   programmer-bug surface (mode bypass via type assertion).
2. **AsyncIterable cleanup** — `for await` `break` / `return` /
   throw, OR `AbortSignal.abort`, MUST result in:
   - the iterator finishes (`done: true`);
   - the producer's `abort()` hook fires exactly once;
   - no leaked promise (Promise.race / pending listeners cleaned).
3. **Single-pass** — calling `Symbol.asyncIterator` on a returned
   iterable yields ONE iterator; consumers wanting independent streams
   call `spawn` per consumer.
4. **Backpressure** — when the consumer is slow, the producer
   `enqueue` resolves only after the consumer advances. The producer
   never accumulates an unbounded internal buffer.
5. **Default-OFF byte-identical** — when the host does NOT inject a
   `StreamingBoomerang`, the ADR-0218 result-only path is byte-identical
   to before this slice landed. NO loop touches.

## Hellgate (15 cases)

`tests/unit/agent/streaming-boomerang-hellgate.test.ts` — see the
exhaustive list at the top of that file. Each test seals exactly one
invariant; the file uses pure fakes only (no live LLM, no IO).

## Non-goals

- **Multi-consumer fan-out** — out of scope. If two consumers need to
  observe the same stream, the host builds its own tee in the surface
  layer (Observer pattern). This slice intentionally does not ship a
  built-in tee to avoid the back-pressure ambiguity (slowest consumer
  gates? fastest? drop?).
- **Persistence / resume** — this slice does not persist chunks. ADR-0166
  (conversation seed replay) is the place for resume.
- **Auto-construction in the loop** — same default-OFF discipline as
  ADR-0218. The loop never builds a streamer; callers wire one through
  AgentConfig if they want progressive consumption.

## Consequences

- Closed-port slice; zero touch in `src/agent/loop.ts` or the
  ADR-0218 router. Existing tests remain green by construction.
- The streaming surface is opt-in — when injected, the host's surface
  layer renders chunks; when absent, ADR-0218 still works.
- Cancellation determinism: a single AbortSignal threads through the
  iterator's `return()` AND the producer's `abort()` hook. The cleanup
  ordering is exhaustively tested in HELL-SB-04, HELL-SB-05, HELL-SB-12.
