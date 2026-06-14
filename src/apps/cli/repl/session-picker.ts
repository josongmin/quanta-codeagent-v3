/**
 * `session-picker` — TTY startup session selector.
 *
 * Extracted from `repl.ts` so that the TTY-based session-list check
 * (`process.stderr.isTTY`) and the session-scoped `process.argv` mutation
 * live in one helper rather than inline in `runRepl`. Note: `repl.ts` still
 * reads `process.env` directly at several call sites (composeSurfaceWires,
 * crashResumeEnabled, bootstrapCrashResumeOffers, buildSessionLoopOptions
 * env, etc.) — this extraction does NOT create a full process-env fence for
 * repl.ts; it only isolates the isTTY + argv side-effects of the picker.
 */

import { homedir } from "node:os"
import * as readline from "node:readline/promises"
import { listSessions } from "@/session"
import { argvPrompt, newSessionFlag, resumePath } from "../internal"

/** Show a numbered session picker at startup when the user hasn't passed any
 *  resume/new-session flags. If the user picks a previous session, injects
 *  `--resume <id>` into process.argv so setupSession picks it up via the
 *  normal resumePath() path. TTY-only; no-op in piped/one-shot/headless mode. */
export const maybePickSession = async (): Promise<void> => {
  if (!process.stderr.isTTY) return
  if (resumePath() !== undefined) return
  if (newSessionFlag()) return
  if (argvPrompt().length > 0) return

  const sessions = (await listSessions({ includeArchived: false })).slice(0, 10)
  if (sessions.length === 0) return

  const home = homedir()
  const shorten = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
  // Relative-time display thresholds (durations in ms, not timers) — named so
  // the no-magic-timeout scanner sees bound constants, not stray wall-clock.
  const MINUTE_MS = 60_000
  const HOUR_MS = 60 * MINUTE_MS
  const DAY_MS = 24 * HOUR_MS
  const relTime = (ms: number): string => {
    const d = Date.now() - ms
    if (d < MINUTE_MS) return "just now"
    if (d < HOUR_MS) return `${Math.round(d / MINUTE_MS)}m ago`
    if (d < DAY_MS) return `${Math.round(d / HOUR_MS)}h ago`
    return `${Math.round(d / DAY_MS)}d ago`
  }

  process.stderr.write("\x1b[2mRecent sessions:\x1b[0m\n")
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!
    const title = s.title.length > 44 ? `${s.title.slice(0, 41)}…` : s.title
    const age = relTime(s.lastTouched)
    process.stderr.write(
      `  \x1b[2m[${i + 1}]\x1b[0m ${title}  \x1b[2m${shorten(s.cwd)}  ${age}\x1b[0m\n`,
    )
  }
  process.stderr.write("  \x1b[2m[N]\x1b[0m New session\n")

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const ans = (
    await rl.question(
      `\x1b[2mResume a session? [1-${sessions.length} or Enter for new]: \x1b[0m`,
    )
  ).trim()
  rl.close()

  if (ans === "" || ans.toLowerCase() === "n") return
  const num = parseInt(ans, 10)
  if (!isNaN(num) && num >= 1 && num <= sessions.length) {
    process.argv.push("--resume", sessions[num - 1]!.id)
  }
}
