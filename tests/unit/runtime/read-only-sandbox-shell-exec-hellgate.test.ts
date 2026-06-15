import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("darwin read-only sandbox supports scoped temp writes while blocking workspace writes", async () => {
    if (process.platform !== "darwin" || !existsSync(DEFAULT_SANDBOX_EXEC_PATH)) return

    const workspace = mkdtempSync(join(tmpdir(), "quanta-ro-tmp-ws-"))
    const sandboxTmp = mkdtempSync(join(tmpdir(), "quanta-ro-tmp-scope-"))
    try {
      const port = defaultPerCallSandbox("read-only", { extraWritePaths: [sandboxTmp] })
      expect(port.availability()).toEqual({ supported: true })

      const ok = await runShell('touch "$TMPDIR/ok"', {
        cwd: workspace,
        localEnv: { vars: { TMPDIR: `${sandboxTmp}/` }, pathPrepend: [] },
        timeoutMs: 10_000,
        perCallWrap: async (argv, cwd) => port.wrap(argv, cwd),
      })

      expect(ok.exitCode).toBe(0)
      expect(ok.stderr).toBe("")
      expect(existsSync(join(sandboxTmp, "ok"))).toBe(true)

      const denied = await runShell("touch should-not-exist", {
        cwd: workspace,
        localEnv: { vars: { TMPDIR: `${sandboxTmp}/` }, pathPrepend: [] },
        timeoutMs: 10_000,
        perCallWrap: async (argv, cwd) => port.wrap(argv, cwd),
      })

      expect(denied.exitCode).not.toBe(0)
      expect(denied.stderr.toLowerCase()).toContain("operation not permitted")
      expect(existsSync(join(workspace, "should-not-exist"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(sandboxTmp, { recursive: true, force: true })
    }
  })
})
