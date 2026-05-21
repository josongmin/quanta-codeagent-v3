export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface ShellOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** When true, the child inherits the parent's FULL environment (API keys
   *  included). Default/absent ⇒ scrubbed env (shared allowlist; see
   *  {@link runShell}). LLM-driven tools MUST NOT set this. */
  inheritEnv?: boolean
  /** PR-5 / ADR-0081 — OPTIONAL typed event observer for long-running output
   *  streaming. When provided, `runShell` emits a `start` event, per-chunk
   *  `stdout`/`stderr` deltas as the child writes, and a terminal `exit` (or
   *  `aborted`) event — IN ADDITION TO the buffered accumulator that still
   *  produces the final `ShellResult`. Absent ⇒ no events, no extra branching,
   *  byte-identical legacy behavior. Typed structurally (mirror of
   *  `ShellExecEvent` from `@/tool/shell-exec-types`) so `@/runtime` does not
   *  import `@/tool` — the tool-layer observer is structurally assignable. */
  onShellEvent?: (event: RunShellEvent) => void
}

/** Structural mirror of `ShellExecEvent` from `@/tool/shell-exec-types` —
 *  kept here so the `@/runtime` slice stays leaf-level (no `@/tool` import).
 *  The closed union is identical; the `@/tool` declaration is the source of
 *  truth that consumers depend on, and the structural mirror is verified by
 *  a compile-time assignability check in `src/runtime/shell.ts`. */
export type RunShellEvent =
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
      readonly offset: number
    }
  | {
      readonly kind: "stderr"
      readonly chunk: Uint8Array
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
