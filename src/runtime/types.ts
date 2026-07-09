import type { BoundedBuffer } from "./bounded-buffer"

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** ADR-0296 auto-background (deadline → detach). Present ONLY when this run
   *  hit its deadline under a `background` option (see {@link runShell}) and the
   *  still-running child was DETACHED into the bash background registry instead
   *  of being killed. `stdout`/`stderr` carry the output captured up to the
   *  detach moment; `exitCode` is a placeholder (the child has not exited). The
   *  caller surfaces `shellId` so the model can later `bash_await` / `bash_kill`.
   *  Absent ⇒ the run completed (or was killed/aborted) in the foreground — the
   *  field is never set on the legacy paths (byte-identical). */
  readonly detached?: { readonly shellId: string }
}

/** ADR-0296 auto-background — the detach seam `runShell` invokes when a
 *  `background`-mode command reaches its deadline. The tool layer binds `adopt`
 *  to the bash background registry; `runShell` hands over the still-running
 *  child (its kill/disarm closures, the live output buffers it keeps appending
 *  to, the child's exit-code promise, and the drain-completion promise) and the
 *  registry owns it from there. Returns the new background shell id. */
export interface BackgroundDetachSeam {
  readonly adopt: (args: {
    readonly command: string
    readonly cwd: string
    readonly kill: () => void
    readonly disarm: () => void
    readonly stdout: BoundedBuffer
    readonly stderr: BoundedBuffer
    readonly exited: Promise<number>
    readonly drainsDone: Promise<void>
  }) => Promise<{ id: string }>
  /** ADR-0296 PROMPT mode — optional consent gate invoked AT the deadline,
   *  BEFORE detaching. Resolves `true` ⇒ detach the still-running child into the
   *  registry; `false` (or throws) ⇒ kill it (legacy SIGTERM-on-timeout). Absent
   *  ⇒ detach immediately (plain `background` mode). The host binds this to a
   *  one-keystroke "move to background?" surface. */
  readonly confirm?: (info: {
    readonly command: string
    readonly elapsedMs: number
  }) => Promise<boolean>
  /** WS-H / UUX-6-20 — how long to wait for `confirm` before DEFAULTING to
   *  detach (D-5). Absent ⇒ the producer's named default (`CONSENT_WAIT_MS`,
   *  60 s). Injectable so hosts/tests can shorten the wait; the chosen value
   *  is echoed on the `detached(consent_timeout)` event so the surface can
   *  announce "no answer in Ns" honestly. */
  readonly consentWaitMs?: number
}

export interface ShellOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** ADR-0296 auto-background — when wired, the deadline DETACHES the live
   *  child into the registry (via {@link BackgroundDetachSeam}) instead of
   *  killing it. Absent ⇒ byte-identical legacy kill-on-deadline. */
  background?: BackgroundDetachSeam
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
  /** ADR-0428 socket-level egress proxy. When set with a bound `address`,
   *  `runShell` injects `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` into the child env
   *  (via `withProxyEnv`) so the spawned shell's OWN sockets are funneled
   *  through the loopback egress proxy — closing the subprocess egress bypass.
   *  Absent (or `address` undefined) ⇒ the child env is byte-identical to the
   *  pre-slice path (`withProxyEnv` returns the same reference). Typed
   *  structurally (mirror of `ProxyEnvInput` from `@/runtime/network-proxy`) so
   *  this leaf types module need not import the slice barrel. */
  proxyEnv?: {
    readonly address?: { readonly host: string; readonly port: number }
    readonly noProxy?: readonly string[]
  }
  /** ADR-0455 — DECLARED local-environment selection. When set, `runShell`
   *  composes the selected env's `vars` / `pathPrepend` ON TOP of the scrubbed
   *  base env (via `applyLocalEnv`), GOVERNED BY the same `envAllowlist` that
   *  scrubbed the base — a declared var whose name is not allowlisted is
   *  dropped, and `pathPrepend` fragments are prepended to the surviving PATH.
   *  Absent (or empty selection) ⇒ `applyLocalEnv` returns the same scrubbed
   *  env reference (byte-identical legacy). Typed structurally (mirror of
   *  `LocalEnvSelection` from `@/runtime/local-env`) so this leaf types module
   *  need not import the slice barrel. */
  localEnv?: {
    readonly vars: Readonly<Record<string, string>>
    readonly pathPrepend: readonly string[]
  }
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
  | {
      readonly kind: "detached"
      /** Mirror of the canonical doc (`@/shared/shell-exec-types`): consent =
       *  operator approved; consent_timeout = D-5 default after no answer in
       *  `consentWaitMs`; auto = plain background mode (no consent gate). */
      readonly reason: "consent" | "consent_timeout" | "auto"
      readonly detachedAt: number
      readonly consentWaitMs?: number
    }
