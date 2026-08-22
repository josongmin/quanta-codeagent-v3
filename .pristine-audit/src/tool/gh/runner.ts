/**
 * GhRunner boundary — argv → exit/stdout/stderr.
 *
 * Pulled out of `index.ts` so all 9 gh tools share ONE spawn surface.
 * The default runner uses `Bun.spawn` with a scoped env allowlist
 * (`CI_ENV_ALLOWLIST_LOCAL`) — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
 * provider creds NEVER leak to `gh`; only `GH_TOKEN` / `GITHUB_*` + locale
 * + `PATH/HOME/TMPDIR` flow through.
 *
 * Tests inject a fake runner directly; the default is provided as a
 * convenience so production wiring is one import.
 */

import { scrubEnv } from "@/runtime"

/** Injectable subprocess boundary — argv, cwd, timeout → result. */
export interface GhRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
export type GhRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<GhRunResult>

/** CI-scoped env allowlist. Hard fence against provider-credential leaks. */
const CI_ENV_ALLOWLIST_LOCAL: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
])

export const defaultGhRunner: GhRunner = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(CI_ENV_ALLOWLIST_LOCAL),
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000
