/**
 * WS-G (jul-10 uiux) — CLI stderr sink for the {@link OperatorNotice} bus.
 *
 * Renders `[quanta] <source>: <message> (<hint>)` to stderr, severity-coded to
 * match the REPL's existing color conventions (`turn-sinks.ts#renderTurnError`
 * red, `stream/adapters/stdout.ts` dim):
 *   - info  → dim (`\x1b[2m`)
 *   - warn  → plain
 *   - error → red (`\x1b[31m`)
 *
 * The composition root (`repl/session-setup.ts`) installs this once per REPL
 * session via {@link installOperatorNoticeSink}; every other surface leaves
 * the bus empty (emit = no-op, byte-identical).
 */

import { installOperatorNoticeSink, type OperatorNotice } from "@/shared"

const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"

/** Pure renderer — one line, trailing newline. `color: false` (non-TTY /
 *  piped stderr) emits plain text so captured logs stay grep-clean. */
export const renderOperatorNotice = (notice: OperatorNotice, color: boolean): string => {
  const hint = notice.hint !== undefined && notice.hint !== "" ? ` (${notice.hint})` : ""
  const line = `[quanta] ${notice.source}: ${notice.message}${hint}\n`
  if (!color) return line
  if (notice.severity === "info") return `${DIM}${line.slice(0, -1)}${RESET}\n`
  if (notice.severity === "error") return `${RED}${line.slice(0, -1)}${RESET}\n`
  return line
}

/** Build the CLI sink. `write` defaults to `process.stderr.write` and `color`
 *  to stderr-TTY-ness (chrome → stderr, per the terminal-chrome stream
 *  policy). NO-THROW: a writer failure (EPIPE on a closed pipe) is swallowed —
 *  a notice must never crash the code path that emitted it. */
export const createCliOperatorNoticeSink = (
  opts: { readonly write?: (s: string) => void; readonly color?: boolean } = {},
): ((notice: OperatorNotice) => void) => {
  const write =
    opts.write ??
    ((s: string): void => {
      process.stderr.write(s)
    })
  const color = opts.color ?? process.stderr.isTTY === true
  return (notice: OperatorNotice): void => {
    try {
      write(renderOperatorNotice(notice, color))
    } catch {
      // Writer failure (closed stderr) — the notice is best-effort chrome.
    }
  }
}

/** Composition-root helper: build + install the default stderr sink. Returns
 *  the uninstaller for the session teardown stack. */
export const installCliOperatorNoticeSink = (): (() => void) =>
  installOperatorNoticeSink(createCliOperatorNoticeSink())
