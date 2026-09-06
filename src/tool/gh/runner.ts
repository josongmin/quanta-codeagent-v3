/**
 * GhRunner boundary — argv → exit/stdout/stderr.
 *
 * Pulled out of `index.ts` so all 9 gh tools share ONE spawn surface.
 * The default runner uses `Bun.spawn` with the SSOT CI env allowlist
 * (`CI_ENV_ALLOWLIST`, `@/shared/env-scrub` — audit G5-02: no local copy) —
 * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / provider creds NEVER leak to
 * `gh`; only `GH_TOKEN` / `GITHUB_*` + locale + `PATH/HOME/TMPDIR` +
 * SSL roots flow through.
 *
 * Tests inject a fake runner directly; the default is provided as a
 * convenience so production wiring is one import.
 */

import { defaultPpidWalkKiller, escalatingKill, scrubEnv } from "@/runtime"
import { CI_ENV_ALLOWLIST } from "@/shared"

/** Injectable subprocess boundary — argv, cwd, timeout → result. */
export interface GhRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
export type GhRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<GhRunResult>

export interface GhExecRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface GhExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type GhExecPort = (request: GhExecRequest) => Promise<GhExecResult>

export interface GhSpawnHandle {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly kill: (signal?: number | NodeJS.Signals) => void
}

export type GhSpawnFn = (
  argv: readonly string[],
  opts: {
    readonly cwd: string
    readonly env: Record<string, string>
    readonly stdout: "pipe"
    readonly stderr: "pipe"
  },
) => GhSpawnHandle

export interface GhExecDeps {
  readonly spawn?: GhSpawnFn
}

const GH_TREE_KILLER = defaultPpidWalkKiller()

const bunGhSpawn: GhSpawnFn = (argv, opts) =>
  Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  })

export const createGhExec = (deps: GhExecDeps = {}): GhExecPort => {
  const spawn = deps.spawn ?? bunGhSpawn
  return async (request) => {
    if (request.signal?.aborted) {
      return { code: 1, stdout: "", stderr: "aborted before spawn" }
    }
    const proc = spawn(request.argv, {
      cwd: request.cwd,
      env: scrubEnv(CI_ENV_ALLOWLIST),
      stdout: "pipe",
      stderr: "pipe",
    })
    const { kill, disarm } = escalatingKill(proc, GH_TREE_KILLER)
    let terminationStarted = false
    const terminateOnce = (): void => {
      if (terminationStarted) return
      terminationStarted = true
      kill()
    }
    const onAbort = (): void => {
      terminateOnce()
    }
    request.signal?.addEventListener("abort", onAbort, { once: true })
    // The signal can flip after the pre-spawn check but before the listener is
    // installed. Re-check after registration so that race cannot leave a child
    // running until its deadline. Both sources share the same one-shot latch.
    if (request.signal?.aborted) terminateOnce()
    const deadline = setTimeout(terminateOnce, request.timeoutMs)
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      return { code, stdout, stderr }
    } finally {
      clearTimeout(deadline)
      request.signal?.removeEventListener("abort", onAbort)
      disarm()
    }
  }
}

export const defaultGhExec: GhExecPort = createGhExec()

export const createGhRunner =
  (exec: GhExecPort = defaultGhExec): GhRunner =>
  async (argv, cwd, timeoutMs) =>
    exec({ argv, cwd, timeoutMs })

// G3-02: a `gh` invocation can fan out (credential helpers, git subprocesses),
// and a bare `proc.kill()` deadline signals only the root — a surviving child
// holds the stdout pipe open and the `.text()` await outlives the timeout. The
// deadline therefore tree-kills via the canonical escalating SIGTERM→SIGKILL
// (same primitive as `runner/batch/eval/exec.ts`).
export const defaultGhRunner: GhRunner = createGhRunner()

export const DEFAULT_TIMEOUT_MS = 60_000
