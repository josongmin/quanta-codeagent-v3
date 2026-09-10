import { describe, expect, test } from "bun:test"
import { runShell } from "@/runtime/shell"

const waitForProcessExit = async (pid: number, timeoutMs = 1_000): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await Bun.sleep(10)
  }
  return false
}

describe("runShell", () => {
  test("captures stdout and a zero exit code", async () => {
    const r = await runShell("echo hi")
    expect(r.stdout).toContain("hi")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  test("reports a non-zero exit code without throwing", async () => {
    const r = await runShell("false")
    expect(r.exitCode).not.toBe(0)
    expect(r.timedOut).toBe(false)
  })

  test("times out a slow command and marks timedOut", async () => {
    const r = await runShell("sleep 2", { timeoutMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
  })
})

describe("runShell child-process leak on observer throw (lifecycle audit)", () => {
  /** REGRESSION: when the typed-event observer throws mid-drain, the child must
   *  be killed on the way out, not orphaned. Before the fix the `finally` only
   *  cleared the timer/listener and left a long-running child alive (verified
   *  by the audit repro: a `sleep` survived for its full duration). We assert
   *  the throw propagates AND the child is dead shortly after. */
  test("kills the child when the observer callback throws", async () => {
    // Capture the pid from the `start` event, then throw from the first chunk
    // observer call so the drain rejects.
    let pid = -1
    const boom = new Error("observer boom")
    await expect(
      runShell("echo first; sleep 30", {
        onShellEvent: (e) => {
          if (e.kind === "start") pid = e.pid
          if (e.kind === "stdout") throw boom
        },
      }),
    ).rejects.toBe(boom)

    expect(pid).toBeGreaterThan(0)
    // Poll the real OS state instead of paying a fixed 300ms on every pass.
    expect(await waitForProcessExit(pid)).toBe(true)
  })
})

describe("runShell env scrubbing (ADR-0006)", () => {
  test("scrubs *_API_KEY / *_SECRET from the child by default", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-openai"
    process.env.ANTHROPIC_API_KEY = "sk-fake-anthropic"
    process.env.RUNSHELL_TEST_SECRET = "top-secret"
    try {
      const r = await runShell('echo "[$OPENAI_API_KEY|$ANTHROPIC_API_KEY|$RUNSHELL_TEST_SECRET]"')
      expect(r.exitCode).toBe(0)
      // All expand to empty: the child never received them.
      expect(r.stdout.trim()).toBe("[||]")
      expect(r.stdout).not.toContain("sk-fake")
      expect(r.stdout).not.toContain("top-secret")
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.RUNSHELL_TEST_SECRET
    }
  })

  test("PATH/HOME still reach the child so normal commands work", async () => {
    const r = await runShell('echo "$HOME"; command -v echo >/dev/null && echo OK')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("OK")
    expect(r.stdout.trim().length).toBeGreaterThan(2)
  })

  test("inheritEnv:true opts back into the full parent env", async () => {
    process.env.RUNSHELL_TEST_INHERIT = "inherited-value"
    try {
      // Precondition: the parent owns the value.
      expect(process.env.RUNSHELL_TEST_INHERIT).toBe("inherited-value")
      const r = await runShell('echo "$RUNSHELL_TEST_INHERIT"', { inheritEnv: true })
      expect(r.stdout.trim()).toBe("inherited-value")
      // Counter-control: with inheritEnv DEFAULT (scrubbed), same key is gone.
      const rScrubbed = await runShell(
        ['echo "', "$", "{RUNSHELL_TEST_INHERIT:-MISSING}", '"'].join(""),
      )
      expect(rScrubbed.stdout.trim()).toBe("MISSING")
    } finally {
      process.env.RUNSHELL_TEST_INHERIT = undefined
    }
  })
})
