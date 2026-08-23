/**
 * N6 Phase-1b — Bun-native PTY backend (RFC `docs/plans/jun-6-pty-bun-native-backend.md`).
 *
 * A SECOND `PtySessionPort` implementation for OWNED PTYs — sessions quanta
 * itself spawns under a REAL controlling terminal (`Bun.Terminal` +
 * `Bun.spawn({ terminal })`, zero-dep, Bun 1.3.14+). It serves the owned half of
 * Cursor's "SpawnPty vs AttachTmux" split: tmux is the foreign half (already
 * landed); this is the owned half quanta was missing.
 *
 * Security inversion (RFC §4.1): owned ⇒ NO foreign-jail. quanta spawned the
 * child under its own cwd/argv, so there is no "attach to someone else's
 * privileged terminal" risk — the `foreign-denied` gate that dominates the tmux
 * adapter is STRUCTURALLY ABSENT. The only trust boundary is the cwd-jail at
 * spawn time (the injected `PtyFactoryPort.jailCwd`); the adapter is strictly
 * LESS privileged than tmux (it can never reach outside what quanta spawned).
 *
 * Closed-port DI (RFC §4.4): this slice never calls `Bun.spawn` /
 * `new Bun.Terminal` — those are INJECTED behind {@link PtyFactoryPort}, exactly
 * as `createTmuxAdapter` takes an injected `TmuxExec`. The real factory lives in
 * the composition layer (`src/host/runtime/pty-backend.ts`). No `Date.now` /
 * `Math.random` / `process.env`: the seq is a pure counter, so no clock is
 * needed.
 *
 * NO-THROW (the round-3 contract): every port method + `spawn` resolves a typed
 * `PtyResult`, never throws at the boundary — a factory that throws maps to a
 * `backend-error` result.
 */

import { errMessage } from "@/shared/errors"
import {
  type AttachResult,
  type BunPtyAdapter,
  type BunPtySpawnOpts,
  PTY_MAX_DIM,
  PTY_MAX_WRITE_BYTES,
  PTY_MIN_DIM,
  PTY_RING_BYTES,
  type PtyChildHandle,
  type PtyChunk,
  type PtyFactoryPort,
  type PtyHandle,
  type PtyHandleInfo,
  type PtyResult,
  type PtyTerminalHandle,
  type PtyWriteOpts,
  type ReadResult,
} from "./port"

const PTY_PREFIX = "pty:"

const okR = <T>(value: T): PtyResult<T> => ({ ok: true, value })
const errR = <T>(
  code: Extract<PtyResult<T>, { ok: false }>["code"],
  message: string,
): PtyResult<T> => ({ ok: false, code, message })

/** Decode a chunk of child bytes to a string. The model only ever sees
 *  well-formed UTF-8: a multi-byte sequence split across two `onData` callbacks
 *  is decoded losslessly with a streaming decoder (`stream:true`), so a code
 *  point straddling a callback boundary is NOT corrupted into a replacement char
 *  — mirroring Codex's lossy-but-well-formed `String::from_utf8_lossy`. */
const mkDecoder = (): ((bytes: Uint8Array) => string) => {
  const dec = new TextDecoder("utf-8")
  return (bytes) => dec.decode(bytes, { stream: true })
}

/** Keep the last `keep` UTF-16 units off the END of `s`, surrogate-safe (never
 *  lead with a lone LOW half whose HIGH half was just dropped). */
const tailWhole = (s: string, keep: number): string => {
  const start = s.length - keep
  const c = s.charCodeAt(start)
  return s.slice(c >= 0xdc00 && c <= 0xdfff ? start + 1 : start)
}

/** One owned session: its terminal, child, decoded ring + monotone seq. */
interface OwnedSession {
  readonly handle: PtyHandle
  readonly terminal: PtyTerminalHandle
  child: PtyChildHandle | undefined
  readonly cwd: string
  /** The decoded output ring (bounded at {@link PTY_RING_BYTES}). */
  ring: PtyChunk[]
  /** Total UTF-16 code units currently retained across `ring` (the bound axis). */
  ringChars: number
  /** Monotone chunk counter (NOT a byte offset). Only ever increases. */
  seq: number
  /** The lowest seq still retained after head-truncation. A `read(since)` with
   *  `since < firstSeq - 1` lost chunks — the read reports the gap rather than
   *  silently dropping (RFC §4.2 missed-bytes signal). */
  firstSeq: number
  decode: (bytes: Uint8Array) => string
  /** Whether the child has exited (so `list` can reflect liveness if desired). */
  exited: boolean
  /** Whether the terminal has been closed (kill / closeAll). */
  closed: boolean
}

/**
 * Build the owned (Bun-native) `PtySessionPort` superset over an INJECTED
 * {@link PtyFactoryPort}. Every op is NO-THROW.
 */
/**
 * The adapter's shared state: the owned-session table, its bounded chunk
 * buffer, and the lookup every operation resolves a handle through. Split out
 * of `createBunPtyAdapter` (god-function burndown).
 */
const ptyState = (factory: PtyFactoryPort) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and the groups mutate in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    nextHandleSeq: 0,
  }
  const sessions = new Map<PtyHandle, OwnedSession>()
  // Monotone handle counter — `pty:<seq>` handles are never reused even after a
  // kill, so a stale handle can never alias a fresh session.

  /** Drain `data` into the ring with a monotone seq, then TRUNCATE the head so
   *  retained chars never exceed {@link PTY_RING_BYTES}. A truncated head bumps
   *  `firstSeq` so a later `read` can detect (and signal) the gap. */
  const pushChunk = (s: OwnedSession, data: string): void => {
    if (data.length === 0) return
    const seq = ++s.seq
    s.ring.push({ seq, data })
    s.ringChars += data.length
    // Head-truncate oldest chunks until the retained char budget fits. A single
    // chunk that ALONE exceeds the budget is itself trimmed to the tail so one
    // flood-write cannot blow the bound (RFC §6.2 leak invariant).
    while (s.ringChars > PTY_RING_BYTES && s.ring.length > 0) {
      const head = s.ring[0] as PtyChunk
      if (s.ring.length === 1 && head.data.length > PTY_RING_BYTES) {
        // The lone chunk is over budget: keep only its tail (surrogate-safe).
        const trimmed = tailWhole(head.data, PTY_RING_BYTES)
        s.ring[0] = { seq: head.seq, data: trimmed }
        s.ringChars = trimmed.length
        s.firstSeq = head.seq
        break
      }
      s.ring.shift()
      s.ringChars -= head.data.length
      s.firstSeq = head.seq + 1
    }
    if (s.firstSeq === 0 && s.ring.length > 0) s.firstSeq = (s.ring[0] as PtyChunk).seq
  }

  const lookup = (handle: PtyHandle): PtyResult<OwnedSession> => {
    const s = sessions.get(handle)
    if (s === undefined) return errR("not-found", `no owned pty ${handle}`)
    return okR(s)
  }
  return { factory, sessions, pushChunk, lookup, mut }
}

/** The state every operation group shares, inferred from {@link ptyState} so it
 *  can never drift from what that function actually builds. */
type PtyCtx = ReturnType<typeof ptyState>

/** Session lifecycle: spawn a pty we OWN, enumerate, attach/detach, and the
 *  two teardown paths. */
const ptyLifecycleOps = (
  ctx: PtyCtx,
): Pick<BunPtyAdapter, "spawn" | "list" | "attach" | "detach" | "kill" | "closeAll"> => {
  const { factory, sessions, pushChunk, lookup, mut } = ctx
  return {
    async spawn(argv: readonly string[], opts: BunPtySpawnOpts): Promise<PtyResult<AttachResult>> {
      try {
        // The ONLY trust boundary: the cwd-jail at spawn (owned ⇒ no foreign
        // gate). A cwd escaping the workspace is rejected exactly as `bash`'s
        // jail does — the inversion is "no FOREIGN jail," NOT "no jail."
        const jailed = factory.jailCwd(opts.cwd)
        if (!jailed.ok) {
          return errR("foreign-denied", `cwd-jail rejected ${opts.cwd}: ${jailed.reason}`)
        }
        const cols = opts.cols ?? 80
        const rows = opts.rows ?? 24
        if (cols < PTY_MIN_DIM || cols > PTY_MAX_DIM || rows < PTY_MIN_DIM || rows > PTY_MAX_DIM) {
          return errR("invalid-size", `(${cols},${rows}) out of 1..${PTY_MAX_DIM}`)
        }
        const handle = `${PTY_PREFIX}${++mut.nextHandleSeq}`
        const session: OwnedSession = {
          handle,
          // biome-ignore lint/style/noNonNullAssertion: terminal is set immediately below
          terminal: undefined!,
          child: undefined,
          cwd: jailed.cwd,
          ring: [],
          ringChars: 0,
          seq: 0,
          firstSeq: 0,
          decode: mkDecoder(),
          exited: false,
          closed: false,
        }
        const terminal = factory.open({
          cols,
          rows,
          onData: (bytes) => {
            if (session.closed) return
            pushChunk(session, session.decode(bytes))
          },
          onExit: () => {
            session.exited = true
          },
        })
        ;(session as { terminal: PtyTerminalHandle }).terminal = terminal
        const env = opts.env ?? {}
        session.child = factory.spawn(argv, jailed.cwd, env, terminal)
        sessions.set(handle, session)
        return okR({ handle, cursor: 0 })
      } catch (e) {
        return errR("backend-error", `spawn failed: ${errMessage(e)}`)
      }
    },

    async list(): Promise<readonly PtyHandleInfo[]> {
      const out: PtyHandleInfo[] = []
      for (const s of sessions.values()) {
        out.push({
          handle: s.handle,
          kind: "bun",
          owned: true,
          ...(s.cwd.length > 0 ? { cwd: s.cwd } : {}),
        })
      }
      return out
    },

    async attach(handle: PtyHandle): Promise<PtyResult<AttachResult>> {
      const r = lookup(handle)
      if (!r.ok) return r
      // Idempotent: re-attach returns the CURRENT cursor (the latest seq) so a
      // resumed read starts after what is already buffered.
      return okR({ handle, cursor: r.value.seq })
    },

    async detach(handle: PtyHandle): Promise<PtyResult<void>> {
      const r = lookup(handle)
      if (!r.ok) return r
      // Owned children SURVIVE detach (consistent with the port doc) — only
      // `kill` reaps them. detach is a local no-op (we keep the ring so a later
      // re-attach can resume).
      return okR(undefined)
    },

    async kill(handle: PtyHandle): Promise<PtyResult<void>> {
      const r = lookup(handle)
      if (!r.ok) return r
      const s = r.value
      // We OWN the child — no allow-list needed (the tmux adapter's foreign
      // refusal is structurally absent). Reap the child + close the terminal,
      // then drop the session so its handle is `not-found` afterward.
      s.closed = true
      try {
        s.child?.kill()
      } catch {
        // best-effort: a kill of an already-dead child is a no-op, never a throw.
      }
      try {
        s.terminal.close()
      } catch {
        // idempotent close.
      }
      sessions.delete(handle)
      return okR(undefined)
    },

    async closeAll(): Promise<void> {
      // Reap every owned child + close every terminal (idempotent — a second
      // call sees an empty map). Honors the "tear down PTY children FIRST"
      // teardown invariant.
      for (const s of sessions.values()) {
        s.closed = true
        try {
          s.child?.kill()
        } catch {
          // best-effort
        }
        try {
          s.terminal.close()
        } catch {
          // idempotent
        }
      }
      sessions.clear()
    },
  }
}

/** I/O against an attached session: stdin write, buffered read, and resize. */
const ptyIoOps = (ctx: PtyCtx): Pick<BunPtyAdapter, "write" | "read" | "resize"> => {
  const { lookup } = ctx
  return {
    async write(handle: PtyHandle, data: string, wopts?: PtyWriteOpts): Promise<PtyResult<void>> {
      const r = lookup(handle)
      if (!r.ok) return r
      const payload = wopts?.appendNewline === true ? `${data}\n` : data
      // 64 KiB cap measured in UTF-8 BYTES (the wire size), matching the tmux
      // adapter / `write_stdin` discipline.
      if (Buffer.byteLength(payload, "utf8") > PTY_MAX_WRITE_BYTES) {
        return errR("too-large", `write exceeds ${PTY_MAX_WRITE_BYTES} bytes`)
      }
      try {
        r.value.terminal.write(payload)
        return okR(undefined)
      } catch (e) {
        return errR("backend-error", `terminal write failed: ${errMessage(e)}`)
      }
    },

    async read(handle: PtyHandle, sinceSeq: number): Promise<PtyResult<ReadResult>> {
      const r = lookup(handle)
      if (!r.ok) return r
      const s = r.value
      const chunks = s.ring.filter((c) => c.seq > sinceSeq)
      // Gap signal (RFC §4.2): if the caller's cursor is older than the oldest
      // retained chunk, head-truncation dropped output between them. Surface it
      // as a synthetic chunk rather than silently dropping (vs tmux's snapshot
      // lossiness). `firstSeq > sinceSeq + 1` ⇒ at least one seq was evicted.
      if (s.firstSeq > sinceSeq + 1 && s.ring.length > 0) {
        const missed = s.firstSeq - (sinceSeq + 1)
        const marker: PtyChunk = {
          seq: s.firstSeq - 1,
          data: `… [${missed} output chunk(s) dropped: ring buffer overflow] …\n`,
        }
        return okR({ chunks: [marker, ...chunks], nextSeq: s.seq })
      }
      return okR({ chunks, nextSeq: chunks.length > 0 ? s.seq : sinceSeq })
    },

    async resize(handle: PtyHandle, cols: number, rows: number): Promise<PtyResult<void>> {
      const r = lookup(handle)
      if (!r.ok) return r
      if (cols < PTY_MIN_DIM || cols > PTY_MAX_DIM || rows < PTY_MIN_DIM || rows > PTY_MAX_DIM) {
        return errR("invalid-size", `(${cols},${rows}) out of 1..${PTY_MAX_DIM}`)
      }
      try {
        r.value.terminal.resize(cols, rows)
        return okR(undefined)
      } catch (e) {
        return errR("backend-error", `terminal resize failed: ${errMessage(e)}`)
      }
    },
  }
}

export const createBunPtyAdapter = (factory: PtyFactoryPort): BunPtyAdapter => {
  const ctx = ptyState(factory)
  return {
    ...ptyLifecycleOps(ctx),
    ...ptyIoOps(ctx),
  }
}
