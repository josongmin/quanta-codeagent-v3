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

import { createTmuxAdapter, type PtySessionPort, type TmuxExec } from "@/tool"

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
