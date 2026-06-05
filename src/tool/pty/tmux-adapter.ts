/**
 * N6 — MVP-A: tmux-shell-out backend (RFC §4.0). Attaches to NAMED tmux sessions
 * through the `tmux` binary (`send-keys` / `capture-pane` / `resize-window`).
 * Zero deps; works against sessions a human/CI started outside quanta.
 *
 * Closed-port DI: the shell exec is INJECTED (`TmuxExec`), so the adapter is
 * testable without a real tmux, and the slice imports nothing concrete. NO-THROW:
 * every exec failure maps to a typed `PtyResult`.
 *
 * SECURITY (§8): only sessions whose name matches `allowPrefix` (default
 * `quanta-`) are attachable/killable; a foreign session is `foreign-denied`
 * unless `allowForeign` is set (the host gates that behind HITL).
 */

import {
  type AttachResult,
  PTY_MAX_DIM,
  PTY_MIN_DIM,
  type PtyChunk,
  type PtyHandle,
  type PtyHandleInfo,
  type PtyResult,
  type PtySessionPort,
  type PtyWriteOpts,
  type ReadResult,
} from "./port"

/** Run a `tmux` subcommand. Returns `{ ok, stdout }`; `ok:false` on non-zero
 *  exit or spawn error. INJECTED so the adapter is process-free in tests. */
export interface TmuxExec {
  run(args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string }>
}

export interface TmuxAdapterOpts {
  readonly exec: TmuxExec
  /** Session-name prefix that is attachable without HITL (default `quanta-`). */
  readonly allowPrefix?: string
  /** When true, foreign (non-prefixed) sessions are allowed (host gates w/ HITL). */
  readonly allowForeign?: boolean
}

const TMUX_PREFIX = "tmux:"
const nameOf = (handle: PtyHandle): string | undefined =>
  handle.startsWith(TMUX_PREFIX) ? handle.slice(TMUX_PREFIX.length) : undefined

const okR = <T>(value: T): PtyResult<T> => ({ ok: true, value })
const errR = <T>(
  code: Extract<PtyResult<T>, { ok: false }>["code"],
  message: string,
): PtyResult<T> => ({ ok: false, code, message })

/** Diff a fresh capture-pane snapshot against the previous one into a single
 *  monotone chunk (tmux has no event stream — we poll + diff). First capture =
 *  the whole text; a grown capture = the appended tail; unchanged = no chunk. */
const diffCapture = (
  prev: { text: string; seq: number } | undefined,
  text: string,
): { chunk: PtyChunk | undefined; seq: number } => {
  if (prev === undefined) return { chunk: { seq: 1, data: text }, seq: 1 }
  if (text === prev.text) return { chunk: undefined, seq: prev.seq }
  const seq = prev.seq + 1
  const tail = text.startsWith(prev.text) ? text.slice(prev.text.length) : text
  return { chunk: { seq, data: tail }, seq }
}

export const createTmuxAdapter = (opts: TmuxAdapterOpts): PtySessionPort => {
  const allowPrefix = opts.allowPrefix ?? "quanta-"
  const allowForeign = opts.allowForeign ?? false
  // Per-handle last-capture, so `read` can diff snapshots into a monotone seq
  // (tmux has no event stream — capture-pane is poll-based).
  const lastCapture = new Map<PtyHandle, { text: string; seq: number }>()

  const gate = (handle: PtyHandle): PtyResult<string> => {
    const name = nameOf(handle)
    if (name === undefined || name.length === 0) {
      return errR("not-found", `not a tmux handle: ${handle}`)
    }
    if (!allowForeign && !name.startsWith(allowPrefix)) {
      return errR("foreign-denied", `session "${name}" outside allow-prefix "${allowPrefix}"`)
    }
    return okR(name)
  }

  /** Parse one `list-sessions` line into a visible handle (or `undefined` when
   *  blank or filtered out by the allow-prefix). */
  const parseLine = (line: string): PtyHandleInfo | undefined => {
    const [name, cwd] = line.split("\t")
    if (name === undefined || name.length === 0) return undefined
    if (!allowForeign && !name.startsWith(allowPrefix)) return undefined
    return {
      handle: `${TMUX_PREFIX}${name}`,
      kind: "tmux",
      owned: false,
      ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
    }
  }

  const exists = async (name: string): Promise<boolean> =>
    (await opts.exec.run(["has-session", "-t", name])).ok

  return {
    async list(): Promise<readonly PtyHandleInfo[]> {
      const r = await opts.exec.run([
        "list-sessions",
        "-F",
        "#{session_name}\t#{pane_current_path}",
      ])
      if (!r.ok) return []
      return r.stdout
        .split("\n")
        .map(parseLine)
        .filter((i): i is PtyHandleInfo => i !== undefined)
    },

    async attach(handle: PtyHandle): Promise<PtyResult<AttachResult>> {
      const g = gate(handle)
      if (!g.ok) return g
      if (!(await exists(g.value))) return errR("not-found", `no tmux session "${g.value}"`)
      const prev = lastCapture.get(handle)
      return okR({ handle, cursor: prev?.seq ?? 0 })
    },

    async write(handle: PtyHandle, data: string, wopts?: PtyWriteOpts): Promise<PtyResult<void>> {
      const g = gate(handle)
      if (!g.ok) return g
      // `-l` = literal (no key-name interpretation), defusing `send-keys` parsing
      // of the model's data. A submit is a separate explicit `Enter` key.
      const w = await opts.exec.run(["send-keys", "-t", g.value, "-l", data])
      if (!w.ok) return errR("backend-error", "tmux send-keys failed")
      if (wopts?.appendNewline === true) {
        const e = await opts.exec.run(["send-keys", "-t", g.value, "Enter"])
        if (!e.ok) return errR("backend-error", "tmux send Enter failed")
      }
      return okR(undefined)
    },

    async read(handle: PtyHandle, sinceSeq: number): Promise<PtyResult<ReadResult>> {
      const g = gate(handle)
      if (!g.ok) return g
      const r = await opts.exec.run(["capture-pane", "-t", g.value, "-p"])
      if (!r.ok) return errR("backend-error", "tmux capture-pane failed")
      const { chunk, seq } = diffCapture(lastCapture.get(handle), r.stdout)
      lastCapture.set(handle, { text: r.stdout, seq })
      const fresh = chunk !== undefined && chunk.seq > sinceSeq ? [chunk] : []
      return okR({ chunks: fresh, nextSeq: seq })
    },

    async resize(handle: PtyHandle, cols: number, rows: number): Promise<PtyResult<void>> {
      const g = gate(handle)
      if (!g.ok) return g
      if (cols < PTY_MIN_DIM || cols > PTY_MAX_DIM || rows < PTY_MIN_DIM || rows > PTY_MAX_DIM) {
        return errR("invalid-size", `(${cols},${rows}) out of 1..${PTY_MAX_DIM}`)
      }
      const r = await opts.exec.run([
        "resize-window",
        "-t",
        g.value,
        "-x",
        String(cols),
        "-y",
        String(rows),
      ])
      return r.ok ? okR(undefined) : errR("backend-error", "tmux resize-window failed")
    },

    async detach(handle: PtyHandle): Promise<PtyResult<void>> {
      // tmux sessions PREDATE us → detach is a local no-op (session survives).
      lastCapture.delete(handle)
      return okR(undefined)
    },

    async kill(handle: PtyHandle): Promise<PtyResult<void>> {
      const g = gate(handle)
      if (!g.ok) return g
      const r = await opts.exec.run(["kill-session", "-t", g.value])
      lastCapture.delete(handle)
      return r.ok ? okR(undefined) : errR("backend-error", "tmux kill-session failed")
    },
  }
}
