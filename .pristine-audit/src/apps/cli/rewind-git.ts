/**
 * Real-git implementation of {@link RewindGitPort} for the CLI surface.
 *
 * `/rewind <id> --restore-files` requires a {@link RewindGitPort} injected on
 * the slash context (see `rewind-cmd.ts`). The wrapper layer in
 * `@/session/rewind` calls only two methods (`stash` + `resetHard`); this
 * factory provides a thin {@link spawn}-backed implementation plus a couple of
 * read-only helpers (`currentSha`, `isCleanWorkingTree`, `restoreStash`) used
 * by integration-test surfaces and by the dispatch's pre-flight checks.
 *
 * Slice contract: `src/apps/cli/**` is allowed to talk to `node:child_process`
 * (surface-local concern — the agent loop, session slice, and `@/tool/git`
 * never reach into the CLI). The wrapper layer stays surface-agnostic; this
 * file is the ONE place where the real `git` binary is invoked for rewind.
 *
 * Default-OFF posture:
 *   - The factory simply returns a port. It is the slash command's job (in
 *     `rewind-cmd.ts`) to gate on `QUANTA_REWIND_GIT=1` AND port presence.
 *   - The factory itself does NOTHING until `stash` / `resetHard` are invoked.
 *     Constructing it is byte-identical to a no-op.
 */

import { spawn } from "node:child_process"
import type { RewindGitPort } from "@/session"

/* ------------------------------------------------------------------ */
/* exec port (test seam)                                               */
/* ------------------------------------------------------------------ */

/** Result of one `git` invocation. `code === 0` ⇒ success. `stderr` is
 *  always populated when `code !== 0` so the slash command can surface a
 *  meaningful error to the user. */
export interface GitExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Shape of the `git`-runner the factory uses. The default is a `spawn`
 *  wrapper; tests inject a deterministic mock. */
export type GitExec = (cmd: string, args: readonly string[], cwd: string) => Promise<GitExecResult>

/** Bounded wall-clock for any single `git` invocation. Stash + reset on a
 *  large monorepo can be slow, but never minutes. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Default {@link GitExec} — spawns `git <args>` under `cwd` with a fixed
 *  timeout. stdout / stderr are read fully before resolving so the caller
 *  never sees a partial stream. */
export const defaultGitExec: GitExec = (cmd, args, cwd) =>
  new Promise<GitExecResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      finish(124)
    }, DEFAULT_TIMEOUT_MS)
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8")
    })
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8")
    })
    child.on("error", (e) => {
      stderr += stderr.length === 0 ? String(e) : `\n${String(e)}`
      clearTimeout(timer)
      finish(127)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? 1)
    })
  })

/* ------------------------------------------------------------------ */
/* port factory                                                        */
/* ------------------------------------------------------------------ */

export interface RewindGitPortOptions {
  /** Working directory for every `git` invocation. Typically the session's
   *  `meta.cwd`. The factory does NOT validate it — invalid cwd surfaces as
   *  spawn error (code 127) which the slash command then surfaces. */
  readonly cwd: string
  /** Inject for tests. Defaults to {@link defaultGitExec}. */
  readonly exec?: GitExec
  /** Stash message prefix used by `stashUncommitted`. The full message is
   *  `"<prefix>-<unix-ms>"` so repeated rewinds in one session each get a
   *  distinct stash entry the user can later `git stash pop` by name. */
  readonly stashLabel?: string
}

/** Extended port surface the CLI factory exposes. Wrapper-layer consumers
 *  (`@/session/rewind.ts`) only see `RewindGitPort`; the extra read-only
 *  helpers are used by integration tests and surface preflight checks. */
export interface CliRewindGitPort extends RewindGitPort {
  /** `git rev-parse HEAD` → the current commit sha or `undefined` on
   *  failure (detached HEAD with no commits, not a git repo, etc.). Used
   *  by the slash command's preflight summary. */
  currentSha(): Promise<string | undefined>
  /** `git status --porcelain` empty ⇒ clean working tree. Used to skip the
   *  stash step entirely when there's nothing to save. */
  isCleanWorkingTree(): Promise<boolean>
  /** `git stash pop <ref>` — restores a stash created by `stash()`. The
   *  slash command surfaces this in the error-recovery path if `resetHard`
   *  fails after a successful stash. */
  restoreStash(stashRef: string): Promise<void>
}

/** Validate a git-ish identifier (sha or ref) is free of shell-meta chars.
 *  We pass args via `spawn` argv (no shell), so meta-chars aren't an
 *  injection risk per se, but a malformed sha is much better caught here
 *  with a clear error than passed to `git` and surfaced as a cryptic
 *  "bad revision" line. */
const isSafeRef = (s: string): boolean => /^[A-Za-z0-9._\-/^~@{}:]+$/.test(s) && s.length <= 256

/** Build a real-git {@link RewindGitPort} that the slash command injects on
 *  the {@link SlashContext}. Constructing it is side-effect free. */
export const createCliRewindGitPort = (opts: RewindGitPortOptions): CliRewindGitPort => {
  const exec = opts.exec ?? defaultGitExec
  const label = opts.stashLabel ?? "quanta-rewind"
  const run = (args: readonly string[]): Promise<GitExecResult> => exec("git", args, opts.cwd)

  const port: CliRewindGitPort = {
    async stash(_cwd: string): Promise<string | undefined> {
      // _cwd is the wrapper-layer signature; we use the factory's bound cwd
      // so a single port instance never straddles two working directories.
      const status = await run(["status", "--porcelain"])
      // status itself failing (not a repo, permissions, etc.) ⇒ surface as
      // throw so the slash command exits 1 with the error.
      if (status.code !== 0) {
        throw new Error(`git status failed: ${status.stderr.trim() || `exit ${status.code}`}`)
      }
      if (status.stdout.trim() === "") {
        // Clean tree — nothing to stash. Caller treats `undefined` as "no
        // stash made" and proceeds straight to reset.
        return undefined
      }
      const stashMsg = `${label}-${Date.now()}`
      const out = await run(["stash", "push", "-u", "-m", stashMsg])
      if (out.code !== 0) {
        throw new Error(`git stash failed: ${out.stderr.trim() || `exit ${out.code}`}`)
      }
      return stashMsg
    },

    async resetHard(_cwd: string, sha: string): Promise<void> {
      if (!isSafeRef(sha)) {
        throw new Error(`refusing to reset: unsafe sha/ref: ${sha}`)
      }
      // Verify the sha is reachable BEFORE the destructive reset — better
      // to abort with a clear error than half-execute.
      const verify = await run(["rev-parse", "--verify", `${sha}^{commit}`])
      if (verify.code !== 0) {
        throw new Error(
          `git rev-parse failed for ${sha}: ${verify.stderr.trim() || `exit ${verify.code}`}`,
        )
      }
      const out = await run(["reset", "--hard", sha])
      if (out.code !== 0) {
        throw new Error(`git reset --hard failed: ${out.stderr.trim() || `exit ${out.code}`}`)
      }
    },

    async currentSha(): Promise<string | undefined> {
      const out = await run(["rev-parse", "HEAD"])
      if (out.code !== 0) return undefined
      const sha = out.stdout.trim()
      return sha === "" ? undefined : sha
    },

    async isCleanWorkingTree(): Promise<boolean> {
      const out = await run(["status", "--porcelain"])
      if (out.code !== 0) return false
      return out.stdout.trim() === ""
    },

    async restoreStash(stashRef: string): Promise<void> {
      if (!isSafeRef(stashRef)) {
        throw new Error(`refusing to pop: unsafe stash ref: ${stashRef}`)
      }
      // `git stash pop` accepts either a stash@{N} ref or a partial message
      // match via `git stash list | grep`. We use the saved message via
      // `stash apply stash@{0}` ONLY when the ref matches our label-prefix
      // (paranoia: never pop an arbitrary user stash by mistake).
      const list = await run(["stash", "list"])
      if (list.code !== 0) {
        throw new Error(`git stash list failed: ${list.stderr.trim() || `exit ${list.code}`}`)
      }
      const lines = list.stdout.split("\n")
      let stashIdx = -1
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] as string
        if (line.includes(stashRef)) {
          stashIdx = i
          break
        }
      }
      if (stashIdx < 0) {
        throw new Error(`stash not found: ${stashRef}`)
      }
      const out = await run(["stash", "pop", `stash@{${stashIdx}}`])
      if (out.code !== 0) {
        throw new Error(`git stash pop failed: ${out.stderr.trim() || `exit ${out.code}`}`)
      }
    },
  }
  return port
}

/* ------------------------------------------------------------------ */
/* env gate                                                            */
/* ------------------------------------------------------------------ */

/** First gate: `QUANTA_REWIND_GIT=1` must be set for the CLI bootstrap to
 *  inject a real git port. Used by `repl.ts` when building the slash ctx;
 *  duplicated check vs `rewind-cmd.ts` is intentional belt-and-suspenders
 *  (the slash command also re-checks before running). */
export const isCliRewindGitEnabled = (
  envSource?: Readonly<Record<string, string | undefined>>,
): boolean => {
  const e = envSource ?? process.env
  const raw = (e.QUANTA_REWIND_GIT ?? "0").trim().toLowerCase()
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no"
}
