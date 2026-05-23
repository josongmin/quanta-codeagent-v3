import type { GitRunner, GitRunResult } from "./types"

/** Bounded wall-clock for any single git invocation. Reads are typically
 *  sub-second; this catches hangs (e.g. a stuck filesystem) without ever
 *  letting a stray child outlive the tool call. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Subset of the parent env that git needs to function but cannot carry
 *  credentials or arbitrary code-exec. Mirrors the spirit of
 *  `@/runtime`'s default allowlist; copied here to keep `@/tool/git` slice-
 *  isolated (it must not depend on `@/runtime`). */
const ALLOWED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  // Allow ssh/https auth state if present — read-only ops may consult a
  // packed object via http(s) only when the user explicitly passes a base
  // that references a remote, which we don't construct ourselves.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
]

const buildEnv = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const k of ALLOWED_ENV) {
    const v = process.env[k]
    if (typeof v === "string") out[k] = v
  }
  return out
}

/** Default GitRunner — spawns `git <args>` via Bun.spawn under `cwd`, with a
 *  bounded wall-clock and a scrubbed env. Stdout/stderr are read fully before
 *  resolving so callers never see a partial stream.
 *
 *  When the caller-supplied `signal` aborts (loop cancellation, subagent
 *  cancel, side-conversation budget exhaustion), the spawned process is killed
 *  immediately rather than orphaned until the wall-clock timeout fires. The
 *  abort listener is unhooked in `finally` so an already-completed run never
 *  leaks a reference into the AbortSignal's listener set. */
export const defaultGitRunner: GitRunner = {
  async run(args, cwd, signal): Promise<GitRunResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: buildEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const killProc = (): void => {
      try {
        proc.kill()
      } catch {
        // ignore — already exited
      }
    }
    const timer = setTimeout(killProc, DEFAULT_TIMEOUT_MS)
    let onAbort: (() => void) | undefined
    if (signal !== undefined) {
      if (signal.aborted) {
        killProc()
      } else {
        onAbort = killProc
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout, stderr, exitCode }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort)
      }
    }
  },
}
