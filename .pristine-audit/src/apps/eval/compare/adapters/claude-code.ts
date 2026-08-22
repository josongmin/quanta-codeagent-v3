/**
 * Claude Code CLI adapter — `claude -p "<prompt>"` runs a single non-interactive
 * turn that prints the assistant transcript to stdout and exits.
 *
 * Permissions: we pass `--permission-mode bypassPermissions` so the CLI does
 * not prompt for confirmation (the work happens in a throwaway sandbox dir,
 * matching the in-process Quanta adapter). If a future Claude Code release
 * renames the flag, only this file needs updating.
 *
 * Tool/usage telemetry: `toolsUsed` is left empty — extracting it from the
 * CLI's stdout would require parsing a vendor-specific format we don't want
 * to chase. The judge sees the full transcript and scores accordingly.
 */
import { CliAgentAdapter } from "./cli-base"

export const buildClaudeCodeAdapter = (): CliAgentAdapter =>
  new CliAgentAdapter({
    name: "claude-code",
    bin: "claude",
    versionArgs: ["--version"],
    buildArgv: (scenario) => ({
      argv: ["-p", scenario.prompt, "--permission-mode", "bypassPermissions"],
    }),
  })
