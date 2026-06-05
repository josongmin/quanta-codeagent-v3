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

/** Bounds + caps the slice enforces uniformly (mirrors the 6-tool discipline). */
export const PTY_MAX_WRITE_BYTES = 64 * 1024
export const PTY_MAX_ATTACHED = 32
export const PTY_RING_BYTES = 256 * 1024
export const PTY_MIN_DIM = 1
export const PTY_MAX_DIM = 1000
