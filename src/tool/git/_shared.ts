/** Slice-internal helpers shared by the four git tool factories. Kept in a
 *  private file (leading underscore) so external callers continue to consume
 *  the slice through `index.ts` only. */

import type { GitRunner, GitRunResult } from "./types"

export const isNotARepo = (stderr: string): boolean => /not a git repository/i.test(stderr)

/** Result of `safeRun` — discriminated so callers can branch cleanly. */
export type RunOutcome =
  | { kind: "ok"; result: GitRunResult }
  | { kind: "spawn-error"; message: string }

/** Invoke the runner, normalizing thrown spawn errors into a tagged result.
 *  This is the only place the catch-and-coerce lives, so each tool's
 *  `execute()` is a flat happy-path → branch on outcome. */
export const safeRun = async (
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
  toolName: string,
): Promise<RunOutcome> => {
  try {
    const result = await runner.run(args, cwd)
    return { kind: "ok", result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: "spawn-error", message: `${toolName} failed: ${msg}` }
  }
}

/** Map a non-zero git exit to a single "best-effort" error string. */
export const stderrReason = (stderr: string, exitCode: number, toolName: string): string => {
  const trimmed = stderr.trim()
  if (isNotARepo(stderr)) return trimmed || "not a git repository"
  return trimmed || `${toolName} exited ${exitCode}`
}
