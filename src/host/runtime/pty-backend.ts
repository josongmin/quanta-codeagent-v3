/**
 * `host/runtime/pty-backend.ts` — N6 (jun-4-pty-attach.md) composition-root
 * backend for the PTY/tmux attach tools.
 *
 * The `@/tool/pty` slice ships the FENCE-CLEAN `createTmuxAdapter` whose ONLY
 * dependency is an injected {@link TmuxExec} (a `tmux <subcommand>` runner). The
 * slice imports nothing concrete and reads no process global — the actual
 * subprocess spawn lives HERE in the composition layer, mirroring how
 * `ChildProcessGitPort` (`@/memory/consolidate/git`) wraps `Bun.spawn(["git",
 * …])` for the memory slice.
 *
 * Closed-port DI (RFC §3.1): the `Bun.spawn` call is the ONLY effect, isolated
 * behind {@link TmuxExec}. argv-array (NO shell) so a tmux subcommand argument
 * can never inject a shell command. NO-THROW: a spawn failure (e.g. `tmux` not
 * installed) maps to `{ ok:false, stdout:"" }`, which the adapter turns into a
 * typed `PtyResult` — the model sees `backend-error`, never a crash.
 *
 * Default-OFF: the composition root constructs this backend + wires
 * `DefaultToolPorts.ptySession` ONLY when `runtimeConfig().ptyAttach` is true
 * (`QUANTA_PTY_ATTACH === "1"`). Absent ⇒ no port ⇒ the 6 `pty_*` tools are NOT
 * registered (byte-identical default menu).
 */

import type { PtyBackend } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import {
  createBunPtyAdapter,
  createTmuxAdapter,
  type PtyChildHandle,
  type PtyFactoryPort,
  type PtySessionPort,
  type PtyTerminalHandle,
  type TmuxExec,
} from "@/tool"

/** Real `tmux` runner backed by `Bun.spawn`. argv-array (no shell). Captures
 *  stdout; a non-zero exit OR a spawn-error (binary missing) yields
 *  `{ ok:false, stdout:"" }`. NEVER throws — the adapter maps every `ok:false`
 *  onto a typed `PtyResult`, so a tmux-less host degrades gracefully rather than
 *  crashing the turn. */
export const bunTmuxExec = (): TmuxExec => ({
  async run(args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string }> {
    try {
      const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      return { ok: exitCode === 0, stdout }
    } catch {
      // spawn-error (tmux not installed / not on PATH) ⇒ treated as a failed
      // subcommand. The adapter surfaces `backend-error` / `not-found`; the
      // model never sees an exception.
      return { ok: false, stdout: "" }
    }
  },
})

/** Build the production tmux-backed {@link PtySessionPort} for the composition
 *  root. The `allowPrefix` / `allowForeign` security gate stays at the adapter
 *  default (`quanta-` prefix; foreign sessions denied) — a host that wants to
 *  attach foreign sessions opts in behind its own HITL, not here. */
export const buildTmuxPtyBackend = (): PtySessionPort => createTmuxAdapter({ exec: bunTmuxExec() })

/** Minimal structural view of the `Bun.Terminal` runtime surface this factory
 *  uses — declared locally so the module typechecks on a Bun version whose
 *  ambient types predate `Bun.Terminal`. The real object is duck-typed at
 *  construction (the feature probe below confirms it exists before use). */
interface BunTerminalLike {
  write(data: string | Uint8Array): number
  resize(cols: number, rows: number): void
  setRawMode?(enabled: boolean): void
  close?(): void
  onData?(cb: (bytes: Uint8Array) => void): void
  onExit?(cb: (code: number) => void): void
}
interface BunTerminalCtor {
  new (opts: { cols: number; rows: number }): BunTerminalLike
}
interface BunSpawnedChild {
  readonly pid: number
  kill(): void
}

/** Probe the running Bun for the native `Bun.Terminal` ctor (1.3.14+). Returns
 *  `undefined` when unavailable, so the router can fall back to tmux rather than
 *  crash on an older runtime. */
const bunTerminalCtor = (): BunTerminalCtor | undefined => {
  const ctor = (Bun as unknown as { Terminal?: unknown }).Terminal
  return typeof ctor === "function" ? (ctor as BunTerminalCtor) : undefined
}

/** True iff this Bun build exposes the native `Bun.Terminal` PTY surface. The
 *  router consults this to decide whether the `bun`/`both` backends are real. */
export const bunNativePtyAvailable = (): boolean => bunTerminalCtor() !== undefined

/**
 * The REAL {@link PtyFactoryPort} — the ONLY place that touches `Bun.Terminal` /
 * `Bun.spawn({ terminal })`. Mirrors `bunTmuxExec`: the slice
 * (`createBunPtyAdapter`) stays fence-clean + process-free in tests, and the one
 * effectful seam lives here in the composition layer.
 *
 * `jailCwd` reuses the SAME `resolveJailed` chokepoint the FS-jail (`@/storage`)
 * enforces everywhere — a `../`-escape / NUL / out-of-root cwd is rejected as
 * `{ ok:false }` (the adapter maps it to a typed `foreign-denied` result, never a
 * crash). The jail root is the workspace `jailRoot` passed at construction.
 *
 * NOTE: requires `Bun.Terminal` (Bun 1.3.14+). `buildPtyBackend` only mints this
 * factory after `bunNativePtyAvailable()` confirms the ctor exists, so `open`
 * never dereferences an undefined ctor in production.
 */
export const bunPtyFactory = (jailRoot: string): PtyFactoryPort => ({
  open(opts) {
    const Ctor = bunTerminalCtor()
    if (Ctor === undefined) {
      // Defensive: the router gates on bunNativePtyAvailable(), so this is only
      // reachable if a caller mints the factory directly on an old runtime.
      throw new Error("Bun.Terminal is not available on this Bun runtime (needs 1.3.14+)")
    }
    const term = new Ctor({ cols: opts.cols, rows: opts.rows })
    term.onData?.((bytes) => opts.onData(bytes))
    term.onExit?.((code) => opts.onExit(code))
    const handle: PtyTerminalHandle = {
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      setRawMode: (enabled) => term.setRawMode?.(enabled),
      close: () => term.close?.(),
    }
    // Stash the live terminal so `spawn` can pass it to `Bun.spawn({ terminal })`.
    bunTerminalByHandle.set(handle, term)
    return handle
  },
  spawn(argv, cwd, env, terminal): PtyChildHandle {
    const term = bunTerminalByHandle.get(terminal)
    const child = Bun.spawn(argv as string[], {
      cwd,
      env: { ...process.env, ...env },
      // `terminal` is the Bun-native option that attaches a real controlling tty.
      ...(term !== undefined ? { terminal: term } : {}),
    } as Parameters<typeof Bun.spawn>[1]) as unknown as BunSpawnedChild
    return {
      pid: child.pid ?? 0,
      kill: () => child.kill(),
    }
  },
  jailCwd(cwd) {
    try {
      const jailed = resolveJailed(cwd, jailRoot)
      return { ok: true, cwd: jailed as unknown as string }
    } catch (e) {
      const reason = e instanceof FsJailError ? e.message : String(e)
      return { ok: false, reason }
    }
  },
})

/** Map a returned {@link PtyTerminalHandle} back to its live `Bun.Terminal` so
 *  `spawn` can attach the SAME terminal. WeakMap ⇒ the entry is collected with
 *  the handle (no leak). */
const bunTerminalByHandle = new WeakMap<PtyTerminalHandle, BunTerminalLike>()

/** Build the Bun-native owned {@link PtySessionPort} (superset adapter exposed
 *  as the port). `jailRoot` is the workspace cwd. */
export const buildBunPtyBackend = (jailRoot: string): PtySessionPort =>
  createBunPtyAdapter(bunPtyFactory(jailRoot))

/**
 * N6 backend ROUTER (RFC jun-6-pty-bun-native-backend) — select the
 * {@link PtySessionPort} for the requested `QUANTA_PTY_BACKEND`:
 *
 *  - `tmux` (default): the foreign-attach tmux adapter (byte-identical to the
 *    pre-slice path).
 *  - `bun`: the owned Bun-native PTY adapter — falls back to tmux when
 *    `Bun.Terminal` is unavailable on the runtime (graceful, never a crash).
 *  - `both`: prefer the Bun-native adapter when available, else tmux.
 *
 * `tmux` and the unavailable-`bun` fallback both yield the tmux adapter, so an
 * operator on an older Bun keeps a working PTY surface. The choice is pure +
 * IO-free (no spawn until a tool dispatches).
 */
export const buildPtyBackend = (backend: PtyBackend, jailRoot: string): PtySessionPort => {
  switch (backend) {
    case "tmux":
      return buildTmuxPtyBackend()
    case "bun":
    case "both":
      return bunNativePtyAvailable() ? buildBunPtyBackend(jailRoot) : buildTmuxPtyBackend()
    default:
      return buildTmuxPtyBackend()
  }
}
