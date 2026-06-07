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

import { DEFAULT_ENV_ALLOWLIST, defaultPpidWalkKiller } from "@/runtime"
import { asScrubbedEnv, bunScrubbedSpawner } from "@/runtime/scrubbed-spawn"
import type { PtyBackend } from "@/shared"
import { runtimeConfig } from "@/shared"
import { errMessage } from "@/shared/errors"
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
    // D3 — scrub the child env through the same chokepoint as `runShell`
    // (drops `*_API_KEY`/`*_TOKEN`/`*_SECRET`). Default scrubbed; opt out with
    // `QUANTA_PTY_INHERIT_ENV` for an interactive shell that needs full env.
    // S1 — brand at the scrubber chokepoint, then route through the typed
    // `spawnScrubbed` boundary so an env leak is a tsc error. The `terminal`
    // attach option rides the `extra` escape hatch.
    const childEnv = asScrubbedEnv(
      buildPtyEnv({
        parentEnv: process.env,
        declared: env,
        inheritEnv: runtimeConfig().ptyInheritEnv,
      }),
    )
    const child = bunScrubbedSpawner(argv, {
      cwd,
      env: childEnv,
      // `terminal` is the Bun-native option that attaches a real controlling tty.
      ...(term !== undefined ? { extra: { terminal: term } } : {}),
    }) as unknown as BunSpawnedChild
    const pid = child.pid ?? 0
    return {
      pid,
      // D1 — reap the whole PTY process tree (shell + its job-control children)
      // instead of only the shell pid. Fall back to the single-PID `child.kill()`
      // if we have no usable pid (defensive — Bun always populates it). No-throw.
      kill: () => {
        if (pid > 0) PTY_TREE_KILLER.signalTree(pid, "SIGTERM")
        else child.kill()
      },
    }
  },
  jailCwd(cwd) {
    try {
      const jailed = resolveJailed(cwd, jailRoot)
      return { ok: true, cwd: jailed as unknown as string }
    } catch (e) {
      const reason = e instanceof FsJailError ? e.message : errMessage(e)
      return { ok: false, reason }
    }
  },
})

/** Inputs to {@link buildPtyEnv}, all injected so the env policy is a pure,
 *  testable unit (the production caller passes `process.env` +
 *  `runtimeConfig().ptyInheritEnv`). */
export interface BuildPtyEnvArgs {
  /** The parent process env (production: `process.env`). */
  readonly parentEnv: Record<string, string | undefined>
  /** The declared per-spawn overlay (the PTY tool's `env` arg), or undefined. */
  readonly declared: Readonly<Record<string, string>> | undefined
  /** Escape hatch — true keeps the FULL parent env (interactive opt-out). */
  readonly inheritEnv: boolean
}

/**
 * D3 — build the PTY child env through the SAME chokepoint as `runShell`.
 *
 * Default (`inheritEnv:false`): scrub the parent env to the
 * {@link DEFAULT_ENV_ALLOWLIST} (drops `*_API_KEY`/`*_TOKEN`/`*_SECRET` and
 * every other non-allowlisted var, ADR-0006), then overlay the declared vars
 * — but ONLY allowlisted names pass (a declared secret name is still dropped),
 * mirroring `applyLocalEnv`'s var-overlay governance. This closes the
 * credential leak from the legacy `{ ...process.env, ...env }` full inherit.
 *
 * Opt-out (`inheritEnv:true`): the full parent env, then the declared overlay
 * (no allowlist filtering) — the pre-D3 interactive behaviour, now explicit.
 *
 * Pure + no-throw. Returns a plain `Record<string,string>` ready for
 * `Bun.spawn({ env })`.
 */
export const buildPtyEnv = (args: BuildPtyEnvArgs): Record<string, string> => {
  const { parentEnv, declared, inheritEnv } = args
  const allow = new Set(DEFAULT_ENV_ALLOWLIST)

  if (inheritEnv) {
    // Full inherit (escape hatch): copy every defined parent var, then overlay
    // the declared vars unfiltered — byte-identical to the legacy spread.
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parentEnv)) {
      if (v !== undefined) out[k] = v
    }
    if (declared !== undefined) {
      for (const [k, v] of Object.entries(declared)) out[k] = v
    }
    return out
  }

  // Scrubbed (default): only allowlisted names from the parent, then overlay
  // only allowlisted declared names — the same allowlist that scrubbed the base.
  const out: Record<string, string> = {}
  for (const name of DEFAULT_ENV_ALLOWLIST) {
    const v = parentEnv[name]
    if (v !== undefined) out[name] = v
  }
  if (declared !== undefined) {
    for (const [k, v] of Object.entries(declared)) {
      if (allow.has(k)) out[k] = v
    }
  }
  return out
}

/** D1 — whole-tree killer for PTY children. An attached interactive shell
 *  (`bash`/`zsh`) is the root of a tree (the shell + whatever it launches); the
 *  legacy `child.kill()` SIGTERMed only the shell pid, leaking its job-control
 *  children. Module-level singleton (the adapter is pure per `signalTree`). */
const PTY_TREE_KILLER = defaultPpidWalkKiller()

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
