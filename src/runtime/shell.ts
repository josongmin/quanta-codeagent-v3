import type { ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000

/** Run a command through the system shell. Captures stdout/stderr, never
 *  throws on non-zero exit (the caller decides what a failure means). */
export const runShell = async (
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOutFlag = false

  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: options.cwd ?? process.cwd(),
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
