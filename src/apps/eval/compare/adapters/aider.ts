/**
 * Aider CLI adapter — single-message one-shot run.
 *
 * Flag rationale (mirror posture across the three competitor adapters):
 *   - `--message "<prompt>"` — single-turn instruction. Aider exits after the
 *     turn completes (in contrast to its default REPL form).
 *   - `--yes-always` — auto-accept every confirmation. We're in a throwaway
 *     sandbox + `scenario.forbidden` is the safety net; an interactive
 *     prompt would block the spawn until the timeout fires.
 *   - `--no-auto-commits` — keep the sandbox tree inspectable for the judge.
 *     Aider's default is to `git commit` after each edit, which both pollutes
 *     the working tree and creates state Tier-4 has no use for.
 *   - `--no-git` — Aider auto-initialises a repo when none is present; we
 *     skip that entirely (the sandbox is ephemeral, repo init is noise + a
 *     latency tax).
 *   - `--no-stream` — pin a deterministic batched stdout layout so the judge
 *     sees the full final response, not a partial delta-stream.
 *   - `--no-pretty` — disable ANSI escape codes so the transcript the judge
 *     reads is plain text (judge prompt + LLM tokenisation behave better on
 *     plain text than on terminal escape codes).
 *   - `--no-show-model-warnings` — strip the chatty pre-flight banner so the
 *     transcript starts with the actual assistant response, not editor info.
 *
 * Aider can stall on slow model providers; we hand the configured 180s
 * default down so `cli-base` SIGTERMs + escalates to SIGKILL without leaks.
 *
 * `toolsUsed` is left empty (same reason as cursor / claude-code): we do not
 * parse the vendor stdout for tool-call markers.
 */
import { CliAgentAdapter, DEFAULT_RUN_TIMEOUT_MS } from "./cli-base"

export const buildAiderAdapter = (): CliAgentAdapter =>
  new CliAgentAdapter({
    name: "aider",
    bin: "aider",
    versionArgs: ["--version"],
    buildArgv: (scenario) => ({
      argv: [
        "--message",
        scenario.prompt,
        "--yes-always",
        "--no-auto-commits",
        "--no-git",
        "--no-stream",
        "--no-pretty",
        "--no-show-model-warnings",
      ],
    }),
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  })
