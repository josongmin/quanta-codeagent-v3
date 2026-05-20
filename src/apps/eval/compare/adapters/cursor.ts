/**
 * Cursor Agent CLI adapter — `cursor-agent -p "<prompt>"`. Same one-shot
 * posture as the Claude Code adapter; consult `cursor-agent --help` for
 * the current flag set when the CLI drifts.
 */
import { CliAgentAdapter } from "./cli-base"

export const buildCursorAdapter = (): CliAgentAdapter =>
  new CliAgentAdapter({
    name: "cursor",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    buildArgv: (scenario) => ({
      argv: ["-p", scenario.prompt],
    }),
  })
