/**
 * PR-5 / ADR-0081 — Typed event stream for long-running shell execution.
 *
 * `ShellExecEvent` is a CLOSED discriminated union — switches must default to
 * `never` so a new variant is a compile error at every consumer. Producers
 * (currently `src/runtime/shell.ts`) emit:
 *
 *  1. `start` exactly once, FIRST.
 *  2. `stdout` and `stderr` events interleaved arbitrarily as the child writes
 *     to its pipes. `offset` is the BYTE offset within that single stream's
 *     total output before this chunk (i.e. the chunk covers
 *     `[offset, offset + chunk.byteLength)` of the per-stream buffer).
 *  3. EITHER `exit` OR `aborted` as the terminal event, AFTER the underlying
 *     stdout/stderr streams' `end`. Exactly one of the two is emitted per run.
 *
 * Chunks are `Uint8Array` — no premature text decoding. The consumer chooses
 * encoding. Concatenating every `stdout` chunk yields the same bytes as the
 * buffered `ShellResult.stdout` (UTF-8 decoded by the legacy accumulator),
 * and the same property holds for stderr. Producers MUST preserve this
 * invariant — see the buffered-vs-streamed byte-identical test.
 *
 * BACK-COMPAT: the observer is opt-in. Absent observer ⇒ no events emitted ⇒
 * the legacy `runShell` accumulator path runs byte-identically.
 */

export type ShellExecEvent =
  | {
      readonly kind: "start"
      readonly pid: number
      readonly command: string
      readonly cwd: string
      readonly startedAt: number
    }
  | {
      readonly kind: "stdout"
      readonly chunk: Uint8Array
      /** Byte offset of this chunk within total stdout (pre-chunk position). */
      readonly offset: number
    }
  | {
      readonly kind: "stderr"
      readonly chunk: Uint8Array
      /** Byte offset of this chunk within total stderr (pre-chunk position). */
      readonly offset: number
    }
  | {
      readonly kind: "exit"
      readonly code: number | null
      readonly signal: NodeJS.Signals | null
      readonly exitedAt: number
    }
  | {
      readonly kind: "aborted"
      readonly reason: "user_abort" | "timeout"
      readonly abortedAt: number
    }

export type ShellExecObserver = (event: ShellExecEvent) => void
