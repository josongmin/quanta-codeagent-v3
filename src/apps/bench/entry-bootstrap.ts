/**
 * Helpers shared by the TWO bench entrypoints — `index.ts` (the local-run
 * composition root) and `cli.ts` (the subcommand router) — so the terminal-IO
 * routing and the `--flag` argv reader are defined ONCE instead of being
 * copy-pasted verbatim into both surfaces (the old state: identical
 * `setTerminalIo({...})` blocks + identical `argValue` definitions in each).
 *
 * Behaviour-identical to the inlined originals: both read the live
 * `process.argv` / `process.stdout` exactly as before.
 */
import { setTerminalIo } from "@/shared"

/** Route the shared `logger` sink to the real process stdout/stderr. Both bench
 *  entrypoints MUST call this at module load, else `logger.*` writes nowhere. */
export const routeBenchTerminalIo = (): void => {
  setTerminalIo({
    stdout: (chunk) => {
      void process.stdout.write(chunk)
    },
    stderr: (chunk) => {
      void process.stderr.write(chunk)
    },
    // Surface the real TTY-ness so TTY-aware consumers (the lane-progress panel)
    // can activate. Omitting these (undefined) forced every consumer onto the
    // non-TTY path — the other four entry points all set them.
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
  })
}

/** Read a value flag in BOTH `--flag value` and `--flag=value` forms. The
 *  `=`-form previously fell through `indexOf` and was silently ignored. */
export const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  if (i >= 0) return process.argv[i + 1]
  const pref = `${flag}=`
  const eq = process.argv.find((a) => a.startsWith(pref))
  return eq !== undefined ? eq.slice(pref.length) : undefined
}
