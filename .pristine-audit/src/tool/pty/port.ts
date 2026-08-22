/**
 * N6 — PTY / tmux session attach (RFC `docs/plans/jun-4-pty-attach.md`).
 *
 * A closed `PtySessionPort` over ONE attach model with two backends (Cursor's
 * "tmux → pty_id" cue): a handle is an opaque tagged string (`tmux:<name>` or
 * `pty:<seq>`); the SAME attach/write/read/resize/kill ops apply regardless of
 * the underlying backend. Zero new deps — tmux is an external binary; Bun has a
 * native PTY (`Bun.Terminal`) for the Phase-1b backend.
 *
 * Fence: `@/tool/pty` imports only `zod` (contracts) + this slice. The real
 * tmux/Bun backends + cwd-jail + HITL are INJECTED (closed-port DI), so the
 * slice is fully testable over a Fake backend with no real process/tmux.
 * NO-THROW: every op resolves a typed `PtyResult`, never throws at the boundary.
 */

/** A backend-tagged opaque handle. `tmux:<session>` or `pty:<seq>`. */
export type PtyHandle = string

export type PtyBackendKind = "tmux" | "bun"

export interface PtyHandleInfo {
  readonly handle: PtyHandle
  readonly kind: PtyBackendKind
  /** Best-effort current working dir of the session (provenance). */
  readonly cwd?: string
  /** Best-effort shell / process label. */
  readonly title?: string
  /** Whether quanta OWNS this handle (spawned it) vs merely attaches to it. */
  readonly owned: boolean
}

/** One monotone-sequenced output chunk. */
export interface PtyChunk {
  readonly seq: number
  readonly data: string
}

export interface AttachResult {
  readonly handle: PtyHandle
  /** The current output cursor — pass to `read({sinceSeq})` to resume. */
  readonly cursor: number
}

export interface ReadResult {
  readonly chunks: readonly PtyChunk[]
  /** The new cursor (caller persists this at the turn boundary). */
  readonly nextSeq: number
}

export type PtyErrorCode =
  | "not-found"
  | "foreign-denied"
  | "cap-exceeded"
  | "invalid-size"
  | "too-large"
  | "backend-error"

/** No-throw result envelope. */
export type PtyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: PtyErrorCode; readonly message: string }

export interface PtyWriteOpts {
  readonly appendNewline?: boolean
}

/** The closed port the 6 tools call. Every method is NO-THROW (returns a typed
 *  `PtyResult`). */
export interface PtySessionPort {
  /** Enumerate attachable handles (owned PTYs + allow-listed tmux sessions). */
  list(): Promise<readonly PtyHandleInfo[]>
  /** Attach by handle (idempotent — re-attach returns the current cursor). */
  attach(handle: PtyHandle): Promise<PtyResult<AttachResult>>
  /** Live stdin. 64 KiB cap; `appendNewline` appends exactly one `\n`. */
  write(handle: PtyHandle, data: string, opts?: PtyWriteOpts): Promise<PtyResult<void>>
  /** Resumable stdout: chunks with `seq > sinceSeq`, plus the new cursor. */
  read(handle: PtyHandle, sinceSeq: number): Promise<PtyResult<ReadResult>>
  /** Resize `(cols, rows)`. Bounds 1..1000 each (reject 0 / absurd). */
  resize(handle: PtyHandle, cols: number, rows: number): Promise<PtyResult<void>>
  /** Stop streaming; the session SURVIVES (tmux predates us). */
  detach(handle: PtyHandle): Promise<PtyResult<void>>
  /** Terminate. Only owned / allow-listed handles. */
  kill(handle: PtyHandle): Promise<PtyResult<void>>
}

/* Bounds + caps the slice enforces uniformly. These are the SSOT both backends
 * (tmux + Bun-native) read; the use-sites re-state the basis inline. Each value
 * is a DEFENSIVE bound (reject/truncate-safe), not a protocol constant — they
 * exist so a flood-write or absurd resize cannot exhaust memory, and the exact
 * magnitudes are chosen to mirror the EXISTING terminal-tool discipline rather
 * than invented here. */

/** Max bytes per `write` (live stdin), measured in UTF-8 WIRE bytes. Mirrors
 *  Codex's `write_stdin` cap / the tmux `send-keys` discipline — one keystroke
 *  burst, not a file transfer. Over-cap ⇒ a typed `too-large` (never truncated
 *  silently). */
export const PTY_MAX_WRITE_BYTES = 64 * 1024
/** Max distinct handles whose last-capture snapshot the tmux adapter retains at
 *  once — bounds the per-handle `lastCapture` map so a session reading from many
 *  foreign panes cannot grow it without limit. A NEW handle past the cap ⇒
 *  `cap-exceeded` (detach/kill frees a slot). Injectable per-adapter
 *  (`createTmuxAdapter({ maxAttached })`); this is the default. */
export const PTY_MAX_ATTACHED = 32
/** Decoded output-ring retention per owned session, in UTF-16 code units. A
 *  scrollback bound: the oldest chunks are head-truncated past this, and the gap
 *  is SIGNALLED on the next `read` (a `… [N chunks dropped] …` marker), never
 *  dropped silently. 256 KiB ≈ a few thousand lines of terminal scrollback —
 *  enough to resume a turn's view, bounded so one flood-write cannot leak. */
export const PTY_RING_BYTES = 256 * 1024
/** Terminal dimension bounds (cols/rows). `1` rejects a 0-sized tty; `1000` is a
 *  sanity ceiling rejecting an absurd resize (no real terminal is 1000×1000+).
 *  Out-of-range ⇒ a typed `invalid-size`, never a backend crash. */
export const PTY_MIN_DIM = 1
export const PTY_MAX_DIM = 1000

/* ─────────────────────────── Phase-1b: owned (Bun-native) PTY ──────────────────
 * The Bun-native adapter (`createBunPtyAdapter`) is a SECOND `PtySessionPort`
 * implementation for OWNED PTYs — sessions quanta itself spawns under a real tty
 * (`Bun.Terminal` + `Bun.spawn({ terminal })`). The port contract above is
 * UNCHANGED (same 7 methods, same NO-THROW envelope, same caps); the only
 * additive surface is the spawn entry point (how an owned `pty:<seq>` handle is
 * BORN), which is NOT a `PtySessionPort` method (handles are minted here, then
 * attached/written/read via the port like any other).
 *
 * Security inversion (RFC §4.1): owned ⇒ NO foreign-jail (quanta spawned it under
 * its own cwd/argv — there is no "attach to someone else's privileged terminal"
 * risk, so `foreign-denied` simply does not apply). The only trust boundary is the
 * cwd-jail at spawn time, enforced by the injected {@link PtyFactoryPort.jailCwd}.
 *
 * Closed-port DI (RFC §4.4): the slice never touches `Bun.spawn` / `new
 * Bun.Terminal` — those are INJECTED behind {@link PtyFactoryPort}, exactly as
 * `createTmuxAdapter` takes an injected `TmuxExec`. So the adapter is fully
 * testable over a `FakePtyFactory` with no real process / no Bun global. */

/** A live owned terminal handle (one Bun.Terminal). The factory hands one back
 *  from {@link PtyFactoryPort.open}; the adapter drives it through these ops and
 *  never sees the concrete `Bun.Terminal`. */
export interface PtyTerminalHandle {
  /** Feed bytes to the child's stdin. Returns the number of bytes written. */
  write(data: string): number
  /** Resize the tty `(cols, rows)` — Bun's `Terminal.resize(cols, rows)` order. */
  resize(cols: number, rows: number): void
  /** Toggle raw mode (input passed through unprocessed). */
  setRawMode(enabled: boolean): void
  /** Close the terminal (idempotent). */
  close(): void
}

/** A spawned owned child process. */
export interface PtyChildHandle {
  /** The OS process id (best-effort; 0 when the fake has none). */
  readonly pid: number
  /** Terminate the child (idempotent). */
  kill(): void
}

/**
 * INJECTED factory for the owned (Bun-native) backend. The real impl
 * (`new Bun.Terminal(...)` + `Bun.spawn(argv, { terminal })`) lives in the
 * composition layer (`src/host/runtime/pty-backend.ts`) next to `bunTmuxExec`,
 * so the `@/tool/pty` slice stays fence-clean (imports only `zod` + this slice)
 * and process-free in tests. NONE of these methods runs inside the slice's hot
 * path without going through the adapter's NO-THROW wrapper.
 */
export interface PtyFactoryPort {
  /** Allocate a real tty. `onData` streams child output (the adapter drains it
   *  into a bounded ring); `onExit` fires once when the child exits. */
  open(opts: {
    readonly cols: number
    readonly rows: number
    readonly onData: (bytes: Uint8Array) => void
    readonly onExit: (code: number) => void
  }): PtyTerminalHandle
  /** Spawn `argv` under `terminal` with `cwd`/`env`. `terminal` is the opaque
   *  object the factory's `open` is backed by (the real impl passes the
   *  `Bun.Terminal` to `Bun.spawn({ terminal })`); the slice treats it as a
   *  token it merely round-trips. */
  spawn(
    argv: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    terminal: PtyTerminalHandle,
  ): PtyChildHandle
  /** cwd-jail — validates/normalizes the spawn cwd (closed port, same chokepoint
   *  as the 6-tool `bash` jail). A cwd escaping the workspace ⇒ `{ ok:false }`. */
  jailCwd(cwd: string):
    | { readonly ok: true; readonly cwd: string }
    | {
        readonly ok: false
        readonly reason: string
      }
}

/** Options for {@link BunPtyAdapter.spawn}. */
export interface BunPtySpawnOpts {
  /** Working dir — the cwd-jail (`PtyFactoryPort.jailCwd`) resolves/validates it. */
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** Default 80 (Bun TerminalOptions default). */
  readonly cols?: number
  /** Default 24. */
  readonly rows?: number
}

/** The concrete owned-PTY adapter type — a SUPERSET of {@link PtySessionPort}
 *  (the 7 port methods are identical) plus the spawn entry point (handles are
 *  minted here, then attached via the port). */
export interface BunPtyAdapter extends PtySessionPort {
  /** Spawn an OWNED process under a real tty. Returns its `pty:<seq>` handle +
   *  the resumable output cursor. NO-THROW: a jail/spawn/open failure ⇒ a typed
   *  `PtyResult` err (never an exception at the boundary). NOT a
   *  `PtySessionPort` method. */
  spawn(argv: readonly string[], opts: BunPtySpawnOpts): Promise<PtyResult<AttachResult>>
  /** Reap every owned child + close every terminal (idempotent). The composition
   *  layer calls this at session shutdown (the "tear down PTY children FIRST"
   *  teardown invariant). */
  closeAll(): Promise<void>
}
