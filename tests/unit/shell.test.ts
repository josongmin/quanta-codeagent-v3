import { describe, expect, test } from "bun:test"
import { runShell } from "@/runtime"

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
      const r = await runShell('echo "$RUNSHELL_TEST_INHERIT"', { inheritEnv: true })
      expect(r.stdout.trim()).toBe("inherited-value")
    } finally {
      delete process.env.RUNSHELL_TEST_INHERIT
    }
  })
})
