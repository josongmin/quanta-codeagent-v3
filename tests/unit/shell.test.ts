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
