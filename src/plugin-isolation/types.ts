/**
 * Plugin process isolation — port + handle types (ADR-0162, W11).
 *
 * The slice's PUBLIC contract: every concrete spawner (Bun/Node child_process/
 * future Electron `UtilityProcess`) must implement {@link IsolatedProcessSpawnerPort}
 * and produce an {@link IsolatedProcess} that follows the lifecycle below.
 *
 * Ready modes (W0.5 freeze):
 *   - {@link IsolatedReadyMode} `dxt-ready-line` (default): wait for first stdout
 *     line (NUL-byte free, ≤ {@link MAX_MESSAGE_BYTES}) within
 *     {@link SpawnOpts.spawnTimeoutMs}; that line is a sentinel and is NOT
 *     forwarded to `onMessage`.
 *   - `process-ready`: spawn + stdio connected is ready. Do NOT consume the
 *     first stdout line — it is JSON-RPC (MCP `initialize` owned by McpClient).
 *
 * Lifecycle:
 *   spawn(opts) → ready-mode wait (see above); on timeout, kill + reject
 *                 → on success, resolve with handle
 *   handle.send / handle.onMessage are noop / unsubscribe after child exit.
 *   handle.kill('SIGTERM') sends SIGTERM, escalates to SIGKILL after
 *   {@link SpawnOpts.gracefulKillMs} (default {@link DEFAULT_GRACEFUL_KILL_MS})
 *   unless the child has exited.
 *
 * **Why a separate `gracefulKillMs` (5s) when `src/runtime/guarded-spawn.ts`
 * already has `KILL_GRACE_MS = 2000`?** The runtime helper is the
 * byte-identical contract for shell tool / sandbox cancellation; widening it
 * would change observable timing for every existing spawn site. Plugin
 * isolation is a separate, opt-in layer with the DXT-standard 5s grace,
 * deliberately decoupled.
 *
 * NO-THROW contract for `IsolatedProcess`:
 * - `send` after exit: silently dropped (caller's request will time out at the
 *   host layer instead — a hard throw mid-send is worse than a typed timeout).
 * - `onMessage` after exit: handler is registered but will never fire; the
 *   returned unsubscribe is still safe to call (idempotent).
 * - `kill` after exit: resolves immediately with the already-known exit.
 */

/** How {@link IsolatedProcessSpawnerPort.spawn} decides the child is ready.
 *  Default remains `dxt-ready-line` so DXT/plugin spawn is byte-identical. */
export type IsolatedReadyMode = "dxt-ready-line" | "process-ready"

/** Default first-message timeout. DXT standard; do not change without ADR. */
export const DEFAULT_SPAWN_TIMEOUT_MS = 5_000

/** Default SIGTERM → SIGKILL grace. DXT standard (deliberately wider than
 *  `runtime/guarded-spawn.ts` `KILL_GRACE_MS=2000`, which guards short-lived
 *  shell spawns; plugin processes can have heavier shutdown work). */
export const DEFAULT_GRACEFUL_KILL_MS = 5_000

/** Single-line payload ceiling (10MB). A larger line is dropped + warned to
 *  prevent OOM on a hostile/runaway plugin (DoS). */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

/** A handle to a spawned, isolated plugin process. Returned by
 *  {@link IsolatedProcessSpawnerPort.spawn}. */
export interface IsolatedProcess {
  /** OS process id. Stable for the lifetime of the handle. */
  readonly pid: number
  /** Human-readable label exposed via env to the child (`QUANTA_SERVICE_NAME`)
   *  so external tools (`ps`, Activity Monitor) can attribute the process. */
  readonly serviceName: string
  /** Send one JSON-serialisable message (newline-framed) to the child.
   *  Silently dropped if the child has exited or the encoded payload exceeds
   *  {@link MAX_MESSAGE_BYTES}. NO-THROW (DXT plugin contract). MCP carriers
   *  must use {@link IsolatedProcess.trySend} instead. */
  send(msg: unknown): void
  /** MCP isolated carrier: same write as {@link IsolatedProcess.send} but
   *  returns a typed `Error` on oversize/dead stdin instead of silent-drop.
   *  Optional so existing test doubles remain valid; production bun-spawner
   *  always implements it. */
  trySend?(msg: unknown): Error | null
  /** Subscribe to incoming messages from the child. Returns an idempotent
   *  unsubscribe closure. Handler is NEVER invoked synchronously from inside
   *  `onMessage` — always microtask-deferred so a re-entrant `onMessage` /
   *  `send` is safe. */
  onMessage(handler: (msg: unknown) => void): () => void
  /** Polite SIGTERM, escalating to SIGKILL after `gracefulKillMs`. Idempotent;
   *  multiple calls do not re-arm the timer. Resolves once the child has been
   *  reaped (the `exitPromise` settles). */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>
  /** Resolves when the child exits. Never rejects. */
  readonly exitPromise: Promise<{ code: number | null; signal: string | null }>
}

/** Arguments to {@link IsolatedProcessSpawnerPort.spawn}. All optional fields
 *  use `exactOptionalPropertyTypes`-compatible shapes (no `undefined` union). */
export interface SpawnOpts {
  /** Executable path for the child. Resolved relative to `cwd` if not absolute
   *  (subject to PATH lookup by the underlying spawn API). */
  readonly entry: string
  /** Argv tail (entry is argv[0]). */
  readonly args?: ReadonlyArray<string>
  /** OS-visible label (≤ 64 chars, ASCII). Exposed via `QUANTA_SERVICE_NAME`. */
  readonly serviceName: string
  /** Extra env vars merged on top of `{PATH: parent.PATH}` (no other host
   *  secret inheritance). */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory for the child. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Opt-in flag (sets `QUANTA_ALLOW_UNSIGNED=1` so the child can detect it).
   *  Mirrors Claude DXT's `allowLoadingUnsignedLibraries`. */
  readonly allowLoadingUnsignedLibraries?: boolean
  /** Ready-mode (default {@link IsolatedReadyMode} `dxt-ready-line`). */
  readonly readyMode?: IsolatedReadyMode
  /** Override the first-message timeout (default {@link DEFAULT_SPAWN_TIMEOUT_MS}). */
  readonly spawnTimeoutMs?: number
  /** Override the SIGTERM grace (default {@link DEFAULT_GRACEFUL_KILL_MS}). */
  readonly gracefulKillMs?: number
  /** Abort the spawn before it completes. Once the handle is returned, abort
   *  has no effect (use `handle.kill()` instead). */
  readonly signal?: AbortSignal
}

/** The closed port. Concrete impls: `bun-spawner.ts` today; Node
 *  child_process / Electron `UtilityProcess` are future swap candidates with no
 *  caller changes (OCP). */
export interface IsolatedProcessSpawnerPort {
  spawn(opts: SpawnOpts): Promise<IsolatedProcess>
}

/** Typed errors. Stable codes for caller branching without string matching. */
export class IsolatedSpawnError extends Error {
  override readonly name = "IsolatedSpawnError"
  readonly code:
    | "spawn-timeout"
    | "spawn-aborted"
    | "spawn-failed"
    | "invalid-service-name"
    | "invalid-entry"
  constructor(
    code:
      | "spawn-timeout"
      | "spawn-aborted"
      | "spawn-failed"
      | "invalid-service-name"
      | "invalid-entry",
    message: string,
  ) {
    super(message)
    this.code = code
  }
}
