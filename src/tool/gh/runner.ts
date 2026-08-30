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

// G3-02: a `gh` invocation can fan out (credential helpers, git subprocesses),
// and a bare `proc.kill()` deadline signals only the root — a surviving child
// holds the stdout pipe open and the `.text()` await outlives the timeout. The
// deadline therefore tree-kills via the canonical escalating SIGTERM→SIGKILL
// (same primitive as `runner/batch/eval/exec.ts`).
const GH_TREE_KILLER = defaultPpidWalkKiller()

export const defaultGhRunner: GhRunner = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(CI_ENV_ALLOWLIST),
  })
  const { kill, disarm } = escalatingKill(proc, GH_TREE_KILLER)
  const deadline = setTimeout(kill, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(deadline)
    disarm()
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000
