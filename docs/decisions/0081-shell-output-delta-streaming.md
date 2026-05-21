# ADR-0081 — Shell output delta streaming

- **Status**: Accepted (default-OFF seam; byte-identical when observer absent)
- **Date**: 2026-05-21
- **Related**: ADR-0006 (env scrubbing for shell exec), ADR-0011 (subagent
  depth on ToolContext), ADR-0069 (typed tool failure), RFC §1.2 (default-OFF
  byte-identical), [[codex-subagent-tools]] (exec_command 75% / write_stdin
  24% — long-running shell is the dominant tool surface)

## Context

`src/runtime/shell.ts`'s `runShell` is the single funnel through which every
LLM-driven shell tool (`bash`, `grep`, `localize`, `test_runner`, …) executes
a child process. Today it buffers stdout/stderr into UTF-8 strings via
`new Response(proc.stdout).text()` and returns a flat `ShellResult` —
`{stdout, stderr, exitCode, timedOut}`.

This is fine for short commands but has two pain points for long-running
ones (test suites, builds, `tail -F`-style logs):

1. **No incremental progress** — the LLM/operator cannot see output until
   the process exits. A 5-minute `bun test` produces zero observable signal
   for 5 minutes.
2. **Memory growth** — buffered text scales linearly with output. A
   misbehaving command emitting megabytes/sec can exhaust memory before
   `proc.exited` resolves.

Codex's session corpus calibration ([[codex-session-corpus-calibration]])
shows shell tools dominate P99 turns; the equivalent surface in Cursor/Codex
streams output via a typed event channel so the model loop, UI, and OTel
exporter can all attach without re-buffering. v3 has nothing comparable —
PR-5 introduces the seam.

## Decision

1. **Closed discriminated union** (`src/tool/shell-exec-types.ts`, new):

   ```ts
   export type ShellExecEvent =
     | { kind: "start";   pid; command; cwd; startedAt }
     | { kind: "stdout";  chunk: Uint8Array; offset }   // per-stream byte offset
     | { kind: "stderr";  chunk: Uint8Array; offset }
     | { kind: "exit";    code; signal; exitedAt }
     | { kind: "aborted"; reason: "user_abort"|"timeout"; abortedAt }
   ```

   Exhaustive switch with `never` default ⇒ a new variant becomes a compile
   error at every consumer. `chunk` is `Uint8Array` — no premature decode;
   the caller chooses encoding.

2. **Opt-in observer**, added to `ShellOptions` (`src/runtime/types.ts`) as
   `onShellEvent?: (e) => void` and to `ToolContext` (`src/tool/types.ts`)
   as `onShellEvent?: ShellExecObserver`. The `bash` tool conditionally
   forwards `ctx.onShellEvent` into `runShell`.

3. **Ordering invariants** enforced by the producer in
   `src/runtime/shell.ts`:
   - exactly one `start` first, BEFORE any pipe drain,
   - `stdout` / `stderr` events interleaved arbitrarily — each carries the
     per-stream byte offset (pre-chunk position),
   - exactly one terminal — `aborted` takes precedence over `exit` when
     either the caller's `AbortSignal` fired (`reason: "user_abort"`) or
     the internal `timeoutMs` timer fired (`reason: "timeout"`),
   - terminal emitted AFTER both pipes drain (`await Promise.all([…])`).

4. **Byte-identical default-OFF**: when `onShellEvent` is absent, `runShell`
   takes the legacy `new Response(proc.stdout).text()` path verbatim —
   same Bun.spawn invocation, same kill/timeout/abort plumbing, zero event
   allocation. The streamed path additionally drains via `getReader()`,
   pushes `Uint8Array` chunks into the same accumulator, and decodes ONCE
   at the end with `TextDecoder("utf-8")` — the same decoder
   `new Response(...).text()` uses. The result of the two paths is
   byte-identical for the `ShellResult` (verified by
   `tests/unit/tool/shell-exec-events-byte-identical.test.ts`).

5. **No heuristic / no fallback**: PR-5 does NOT add a byte cap on the
   accumulator, does NOT auto-redact, does NOT degrade gracefully on
   observer throw. A future PR may introduce a structural ring-buffer
   with explicit `maxBufferedBytes` config — PR-5 keeps the legacy
   buffering behavior unchanged so callers can opt in without changing
   memory semantics.

## Consequences

- **Forward**: a UI consumer (CLI streaming TUI, web pane) can subscribe
  via `ToolContext.onShellEvent` and render output as it arrives; an OTel
  span layer can attach a chunk-counter / bytes-attribute to the
  `handle_tool_call{name=bash}` span; the model loop can interleave its
  own "still working" pings between observed stdout deltas.
- **Memory**: long commands STILL exhaust memory at the legacy rate
  because the accumulator is unchanged. The streaming feature does not
  resolve the memory pain point on its own — but it IS the structural
  prerequisite (a ring-buffer / spill-to-disk implementation lives in a
  follow-up PR and can drop chunks from the accumulator while still
  emitting them on the event stream).
- **Slice boundaries**: `@/runtime` stays leaf-level. The event union is
  declared in `@/tool/shell-exec-types` (the consumer slice) and
  structurally mirrored in `@/runtime/types` as `RunShellEvent` — the two
  unions are byte-for-byte identical, and TypeScript's structural typing
  ensures `ShellExecObserver` is assignable to
  `ShellOptions.onShellEvent`. No new module import from `@/runtime` into
  `@/tool`.
- **Compile-time exhaustiveness**: every consumer that switches on
  `event.kind` must handle all five variants or `tsc` errors on the
  `never` default. A future variant (e.g. `{kind:"pause"}` for long-paused
  output) becomes a compile error at every consumer.

## Negative invariants

- `runShell` MUST NOT emit any event when `onShellEvent` is absent.
- The terminal event is NEVER both `exit` AND `aborted` — exactly one.
- `stdout` chunks NEVER include stderr bytes (and vice versa). Per-stream
  offsets are per-stream.
- The streamed path MUST produce the same `ShellResult.stdout/stderr` as
  the buffered path — the byte-identical test guards this.
