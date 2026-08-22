/**
 * Cursor Agent CLI adapter — `cursor-agent -p "<prompt>"` runs a single
 * non-interactive turn that prints the assistant transcript to stdout and
 * exits.
 *
 * Flags rationale (mirrors the Claude Code adapter's posture):
 *   - `-p "<prompt>"` — print/non-interactive entry, the documented one-shot
 *     form.
 *   - `--output-format text` — plain stdout text. We pin this explicitly so a
 *     future CLI default-change to `stream-json` (or another structured form)
 *     does NOT silently break the judge's transcript expectation; if the flag
 *     is removed in a future release, the version probe + spawn still yield
 *     a typed failure (`exit≠0`) rather than a parsed-as-JSON-but-wrong-shape
 *     transcript.
 *   - `--force` — skip the "you're outside a workspace / untrusted folder"
 *     interactive prompt that would otherwise hang the spawn forever inside
 *     the throwaway sandbox dir. Same in spirit as Claude Code's
 *     `--permission-mode bypassPermissions` and Aider's `--yes-always`.
 *
 * Per-scenario timeout matches the base default (180s). When the CLI hangs
 * (network stall, model overload, etc.) `cli-base` SIGTERMs first then
 * promotes to SIGKILL after the grace period — no orphaned child processes.
 *
 * `toolsUsed` is left empty by design: extracting it from the CLI's stdout
 * would require parsing a vendor-specific format we don't want to chase. The
 * judge scores the full transcript.
 */
import { CliAgentAdapter, DEFAULT_RUN_TIMEOUT_MS } from "./cli-base"

export const buildCursorAdapter = (): CliAgentAdapter =>
  new CliAgentAdapter({
    name: "cursor",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    buildArgv: (scenario) => ({
      argv: ["-p", scenario.prompt, "--output-format", "text", "--force"],
    }),
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  })
