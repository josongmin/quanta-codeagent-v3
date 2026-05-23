import { existsSync } from "node:fs"
import type { StructuredLogger } from "@/observability"
import { logger } from "@/shared"

/**
 * CLI session I/O — switch-into-session-cwd helper.
 *
 * `switchToSessionCwd` stays here because it calls `process.chdir` /
 * `process.exit` — both surface-specific lifetime concerns. `persistTurn`
 * (which is pure surface-agnostic plumbing) was moved to
 * `@/runner/orchestrate/persist-turn` and is re-exported below so existing
 * importers (`repl.ts`, the unit tests) keep resolving it from here.
 *
 * Default-OFF posture: `persistTurn` is still a no-op when neither `state`
 * (path-mode `--state <p>`) nor `idMeta` (id-mode `--resume <id>` /
 * `--new-session`) is set, matching the prior inline behavior.
 */

export type { PersistTurnInput } from "@/runner/orchestrate"
export { persistTurn } from "@/runner/orchestrate"

/**
 * HIGH-4 helper: if the resumed id-mode session lives in a different cwd
 * (e.g. a fork-worktree session), chdir into it BEFORE the cwd captured by
 * `SessionDeps` is read. Exits 1 with a clear error when the directory is
 * missing on disk (worktree removed since the session was saved). Returns
 * the post-chdir cwd.
 */
export const switchToSessionCwd = (
  current: string,
  target: string,
  slog: StructuredLogger,
): string => {
  if (target === current) return current
  if (!existsSync(target)) {
    logger.error(`Session cwd missing: ${target}. The worktree may have been removed.`)
    process.exit(1)
  }
  process.chdir(target)
  const next = process.cwd()
  slog.info("session.cwd.switched", { from: current, to: next })
  return next
}
