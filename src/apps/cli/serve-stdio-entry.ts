/**
 * Focused executable entry for the session.v1 stdio server.
 *
 * The general CLI front door still owns user-facing `quanta serve --stdio`
 * routing. This entry exists for supervisors and transport conformance tests
 * that already selected the serve command and must not cold-load the unrelated
 * interactive REPL, remote runner, status projection, and slash-command graph.
 */
import { errMessage } from "@/shared"
import { runServeStdioCmd } from "./serve-stdio-cmd"

export const runServeStdioEntry = async (argv: readonly string[]): Promise<number> =>
  runServeStdioCmd(argv)

if (import.meta.main) {
  void runServeStdioEntry(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`serve stdio fatal: ${errMessage(error)}\n`)
      process.exit(1)
    })
}
