/**
 * Aider CLI adapter — `aider --message "<prompt>" --yes-always --no-auto-commits`.
 *
 * `--yes-always` skips Aider's interactive confirmations (we're in a sandbox,
 * scenario.forbidden gates destructive ops at the Quanta side; we accept the
 * trade-off for Aider where the post-judge step is the safety net).
 * `--no-auto-commits` keeps the sandbox state inspectable.
 */
import { CliAgentAdapter } from "./cli-base"

export const buildAiderAdapter = (): CliAgentAdapter =>
  new CliAgentAdapter({
    name: "aider",
    bin: "aider",
    versionArgs: ["--version"],
    buildArgv: (scenario) => ({
      argv: ["--message", scenario.prompt, "--yes-always", "--no-auto-commits"],
    }),
  })
