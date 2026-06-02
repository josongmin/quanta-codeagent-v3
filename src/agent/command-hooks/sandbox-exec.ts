/**
 * Production {@link CommandHookExecPort} adapter (ADR-0454).
 *
 * REUSE, NOT REINVENT — this is the SAME confinement `LocalSandbox`
 * (src/runtime/sandbox.ts) applies to the shell tool, with ONE addition the
 * sandbox lacks: stdin delivery (the Claude Code command-hook contract feeds
 * the event payload as JSON on the child's stdin). Specifically it reuses:
 *   - `scrubEnv(envAllowlist)` — the SINGLE source of truth for the env
 *     allowlist (parent secrets / API keys never leak to the child);
 *   - `disclaimedShellArgv("bash", command)` — dotfile-skipping shell so a
 *     hijacked `~/.bashrc` cannot run in the child;
 *   - `escalatingKill` + `withSpawnedChild` — the SIGTERM→SIGKILL escalation +
 *     kill-on-throw guard the sandbox / shell tool already use.
 *
 * The command travels as the argv tail (`bash --noprofile --norc -c <command>`)
 * — it is NEVER interpolated with the payload. The payload is written to stdin
 * and stdin is then closed (EOF) so a well-behaved hook reads its full input.
 *
 * The plugin-isolation spawner (src/plugin-isolation) was evaluated and is the
 * WRONG fit: its `IsolatedProcessSpawnerPort` is a PERSISTENT, line-framed JSON
 * RPC duplex that REQUIRES a READY-sentinel first line and rejects a child that
 * exits before emitting one. A command hook is a one-shot fire-and-collect with
 * a free-form (often non-JSON) stdout — it would always trip `spawn-timeout` /
 * `spawn-failed`. The sandbox's one-shot capture model is the correct reuse;
 * the env-allowlist source of truth is shared either way. See ADR-0454.
 */

import { scrubEnv } from "@/runtime"
import { escalatingKill, withSpawnedChild } from "@/runtime/guarded-spawn"
import { disclaimedShellArgv } from "@/runtime/shell-disclaim"
import type { CommandHookExecOpts, CommandHookExecPort, CommandHookExecResult } from "./types"

const TRUNCATION_MARKER = "\n…[output truncated by command-hook maxOutputBytes]"

/** Cap combined output to a byte budget, appending a visible marker once. */
const capOutput = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return text
  return bytes.subarray(0, maxBytes).toString("utf8") + TRUNCATION_MARKER
}

/**
 * Build the {@link CommandHookExecPort} backed by `Bun.spawn`, reusing the
 * sandbox env-scrub + kill-escalation machinery. Injectable for tests (which
 * pass a fake port instead, so NO real shell runs in CI).
 */
export const createSandboxCommandHookExec = (): CommandHookExecPort => ({
  exec: async (opts: CommandHookExecOpts): Promise<CommandHookExecResult> => {
    // SAME env scrub as LocalSandbox — only allowlisted names reach the child;
    // parent secrets are dropped.
    const env = scrubEnv(opts.envAllowlist)
    // Dotfile-skipping shell (POSIX_SPAWN_SETDISCLAIM approximation). The user
    // command is the argv tail — never concatenated with the payload.
    const argv = [...disclaimedShellArgv("bash", opts.command)]
    let timedOut = false

    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    // Deliver the payload as JSON on stdin, then EOF. A hook reads its input
    // here (Claude Code contract). Writing is best-effort — a command that does
    // not read stdin simply ignores it.
    try {
      const stdin = proc.stdin
      if (stdin !== undefined) {
        stdin.write(new TextEncoder().encode(opts.stdinJson))
        await stdin.end()
      }
    } catch {
      // Child closed stdin early (did not read it) — not an error; continue to
      // capture stdout/exit.
    }

    const { kill, disarm } = escalatingKill(proc)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)

    // Honor an external abort (composes with the loop's AbortSignal). An abort
    // is a cancellation, NOT a hook timeout — `timedOut` stays false, so the
    // killed child interprets via its (non-zero) exit code = fail-closed deny.
    const onAbort = (): void => {
      kill()
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    return withSpawnedChild(
      {
        kill,
        timer,
        cleanup: () => {
          disarm()
          opts.signal?.removeEventListener("abort", onAbort)
        },
      },
      async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const exitCode = await proc.exited
        return {
          stdout: capOutput(stdout, opts.maxOutputBytes),
          stderr: capOutput(stderr, opts.maxOutputBytes),
          exitCode,
          timedOut,
        }
      },
    )
  },
})
