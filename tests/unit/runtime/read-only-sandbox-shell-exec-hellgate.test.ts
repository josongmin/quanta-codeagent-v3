import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { runShell } from "@/runtime"
import { DEFAULT_SANDBOX_EXEC_PATH, defaultPerCallSandbox } from "@/runtime/os-sandbox"

describe("read-only per-call Seatbelt shell exec", () => {
  test("darwin read-only sandbox can start the resolved shell", async () => {
    if (process.platform !== "darwin" || !existsSync(DEFAULT_SANDBOX_EXEC_PATH)) return

    const port = defaultPerCallSandbox("read-only")
    expect(port.availability()).toEqual({ supported: true })

    const result = await runShell("printf ok", {
      cwd: "/tmp",
      timeoutMs: 10_000,
      perCallWrap: async (argv, cwd) => port.wrap(argv, cwd),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("ok")
  })
})
