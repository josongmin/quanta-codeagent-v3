import { existsSync } from "node:fs"
import type { StructuredLogger } from "@/observability"
import { failSessionStartup } from "./repl/session-startup-error"

/**
 * CLI session I/O — switch-into-session-cwd helper.
 *
 * `switchToSessionCwd` stays here because it calls `process.chdir`. The
 * missing-target branch throws `SessionStartupError` (kind:
 * `session_cwd_missing`) instead of exiting inline so the top-level
 * `main().catch` owns the exit code and the contract test can assert
 * structured failure without killing the test runner.
 *
 * `persistTurn` (which is pure surface-agnostic plumbing) was moved to
 * `@/runner/orchestrate/persist-turn` and is re-exported below so existing
 * importers (`repl.ts`, the unit tests) keep resolving it from here.
 *
 * Default-OFF posture: `persistTurn` is still a no-op when neither `state`
 * (path-mode `--state <p>`) nor `idMeta` (id-mode `--resume <id>` /
 * `--new-session`) is set, matching the prior inline behavior.
 */

export type { PersistTurnInput } from "@/runner/orchestrate"
export { persistTurn } from "@/runner/orchestrate"

export const switchToSessionCwd = (
  current: string,
  target: string,
  slog: StructuredLogger,
): string => {
  if (target === current) return current
  if (!existsSync(target)) {
    failSessionStartup(
      "session_cwd_missing",
      `Session cwd missing: ${target}. The worktree may have been removed.`,
    )
  }
  process.chdir(target)
  const next = process.cwd()
  slog.info("session.cwd.switched", { from: current, to: next })
  return next
}
