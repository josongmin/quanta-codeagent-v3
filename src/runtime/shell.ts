import { scrubEnv } from "./sandbox"
import type { ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000

/** Run a command through the system shell. Captures stdout/stderr, never
 *  throws on non-zero exit (the caller decides what a failure means).
 *
 *  ENV SCRUBBING (ADR-0006, now actually enforced for tool execution): unless
 *  `inheritEnv: true` is passed, the child runs with a SCRUBBED env built by
 *  the shared {@link scrubEnv} (ONE source of truth — the allowlist lives in
 *  src/runtime/sandbox.ts, this module does not duplicate it). That means
 *  only PATH/HOME/LANG/LC_ALL/TZ/TERM (when present in the parent) reach the
 *  child; `*_API_KEY`/`*_TOKEN`/`*_SECRET` and every other parent var are
 *  dropped. All LLM-driven shell tools (bash/grep/localize/test-runner) call
 *  this without `inheritEnv`, so provider keys can no longer leak into a
 *  child process. Default behavior stays functional: PATH/HOME are forwarded
 *  when set, so normal commands (`echo`, `pwd`, `rg`, `bun test`) still run. */
export const runShell = async (
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOutFlag = false

  // Scrubbed by default; opt OUT only with an explicit `inheritEnv: true`.
  // When inheriting we pass `process.env` explicitly (Bun.spawn snapshots the
  // original env if `env` is omitted and would miss vars set after startup).
  const env =
    options.inheritEnv === true ? (process.env as Record<string, string | undefined>) : scrubEnv()

  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const kill = () => {
    try {
      proc.kill()
    } catch {
      // already exited
    }
  }
  const onAbort = () => kill()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOutFlag = true
    kill()
  }, timeoutMs)

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode, timedOut: timedOutFlag }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
