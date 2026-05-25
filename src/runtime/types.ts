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
  /** ADR-0204 wire (opt-in) — when set, `runShell` calls
   *  `port.restore(handle, argv)` BEFORE spawning so the child shell sources
   *  the captured per-turn snapshot file (params/aliases/functions). Absent
   *  ⇒ argv is unchanged (byte-identical legacy). Typed structurally so
   *  `@/runtime` does not have to reach into `@/runtime/shell-snapshot` for
   *  its closed types — the slice's adapter is structurally assignable. */
  shellSnapshot?: ShellSnapshotRestoreSeam
  /** ADR-0295 — per-call argv wrapper (per-call OS sandbox). When set,
   *  `runShell` invokes this BEFORE the installed `ShellSandboxSlot.wrap` and
   *  the shell-snapshot restore: the per-call wrap is the OUTERMOST sandbox.
   *  Returns the wrapped argv + sandboxApplied flag (mirrors `ShellSandboxSlot`
   *  but at call granularity). Absent ⇒ legacy path (slot + snapshot only).
   *  Used by the bash tool's `mode="read"` arm to wrap a SINGLE call without
   *  mutating the session-wide slot. Typed structurally so `@/runtime` does
   *  not import `@/tool` / `@/runtime/os-sandbox` types directly here — the
   *  consumer adapts a `PerCallSandboxPort.wrap` to this shape. */
  perCallWrap?: (
    argv: ReadonlyArray<string>,
    cwd: string,
  ) => Promise<{
    readonly argv: string[]
    readonly sandboxApplied: boolean
    readonly degradeReason?: string
  }>
}

/** ADR-0204 wire — minimal structural shape consumed by `runShell`. Matches
 *  the public surface of `ShellSnapshotPort` (`./shell-snapshot/port.ts`)
 *  + `SnapshotHandle` (`./shell-snapshot/types.ts`). Declared here so the
 *  shell.ts module need not import the slice barrel directly. */
export interface ShellSnapshotRestoreSeam {
  /** Per-turn snapshot reference; pass through verbatim. */
  readonly handle: { readonly id: string; readonly path: string }
  /** Pure function — same shape as `ShellSnapshotPort.restore`. */
  readonly restore: (
    handle: { readonly id: string; readonly path: string },
    prefix: ReadonlyArray<string>,
  ) => { readonly argv: string[] }
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
