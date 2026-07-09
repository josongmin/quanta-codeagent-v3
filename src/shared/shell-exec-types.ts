/**
 * PR-5 / ADR-0081 — Typed event stream for long-running shell execution.
 *
 * Cross-cutting telemetry contract. Canonically defined in `@/shared` so every
 * slice (tool, observability, runtime, agent) can import it without crossing
 * slice boundaries (RFC 3.1 slice isolation — `@/observability` may only depend
 * on `@/shared`). `@/tool/shell-exec-types` re-exports these for back-compat so
 * `@/tool`'s public API is unchanged.
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
 *  3. EXACTLY ONE terminal event: `exit` (clean completion), `aborted` (a REAL
 *     kill — user abort, timeout kill, or declined-consent kill), or `detached`
 *     (WS-H / UUX-6-05 — the deadline moved the still-running child into the
 *     background registry; the command is ALIVE, not aborted). `exit`/`aborted`
 *     follow the underlying streams' `end`; `detached` ends the FOREGROUND
 *     observation only (the registry owns the stream from there).
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
  | {
      readonly kind: "detached"
      /** Why the foreground stream ended in a detach (ADR-0296 / WS-H):
       *  `consent` — the operator explicitly approved backgrounding at the
       *  deadline; `consent_timeout` — the consent prompt got NO answer within
       *  `consentWaitMs` and DEFAULTED to background (D-5: default kept, but
       *  announced); `auto` — plain background mode (no consent gate). */
      readonly reason: "consent" | "consent_timeout" | "auto"
      readonly detachedAt: number
      /** How long the consent prompt waited before defaulting. Present iff
       *  reason === "consent_timeout" (lets the surface say "no answer in Ns"
       *  without hardcoding the producer's wait). */
      readonly consentWaitMs?: number
    }

export type ShellExecObserver = (event: ShellExecEvent) => void
