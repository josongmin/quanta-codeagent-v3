/**
 * P16 (jun-08 long-tail §P16) — Windows shell guard hellgate.
 *
 * `runShell` historically hardcoded `["bash","-lc",command]` with NO win32
 * branch — on Windows it would spawn a nonexistent `bash` and fail with an
 * opaque ENOENT (silent mis-behavior). This locks:
 *
 *   1. BYTE-IDENTITY: on every non-win32 platform the base argv is exactly
 *      `["bash","-lc",command]` (legacy hardcode) regardless of QUANTA_WIN_SHELL.
 *   2. win32 default ⇒ explicit typed `{kind:"error"}` decision (NOT a silent
 *      bash spawn).
 *   3. win32 + QUANTA_WIN_SHELL=cmd ⇒ explicit cmd.exe fallback argv.
 *   4. e2e: a real `runShell` on a forced-win32 platform returns a typed
 *      ShellResult (exitCode 127 + actionable stderr) and DOES NOT throw, DOES
 *      NOT spawn a process.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { buildBaseShellArgv, resolveWinShellMode } from "@/runtime"
import { runShell } from "@/runtime"

describe("P16 — buildBaseShellArgv (pure)", () => {
  test("non-win32 is byte-identical to the legacy hardcode (every platform, EVERY winShell mode incl. ADR-0529 auto/bash/pwsh)", () => {
    const platforms: NodeJS.Platform[] = ["darwin", "linux", "freebsd", "openbsd", "sunos", "aix"]
    // ADR-0529 invariant #1: `platform !== "win32"` ⇒ ["bash","-lc",cmd] REGARDLESS
    // of QUANTA_WIN_SHELL — must hold for the NEW modes too, not just error/cmd.
    for (const p of platforms) {
      for (const mode of ["error", "cmd", "auto", "bash", "pwsh"] as const) {
        const d = buildBaseShellArgv("echo hi", p, mode)
        expect(d.kind).toBe("argv")
        // The winShell mode must be IGNORED off win32.
        expect(d.kind === "argv" && d.argv).toEqual(["bash", "-lc", "echo hi"])
        expect(d.kind === "argv" && d.dialect).toBe("posix")
      }
    }
  })

  test("win32 default (error mode) refuses with a typed error carrying an actionable reason", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "error")
    expect(d.kind).toBe("error")
    if (d.kind !== "error") throw new Error("expected error decision")
    expect(d.reason).toContain("win32")
    expect(d.reason).toContain("QUANTA_WIN_SHELL=cmd")
  })

  test("win32 + cmd mode emits the cmd.exe fallback argv (Node shell:true shape)", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "cmd")
    expect(d.kind).toBe("argv")
    expect(d.kind === "argv" && d.argv).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hi"])
  })

  test("win32 defaults to error when winShell arg omitted", () => {
    const d = buildBaseShellArgv("echo hi", "win32")
    expect(d.kind).toBe("error")
  })
})

describe("P16 — resolveWinShellMode (pure env read)", () => {
  test("unset / empty / typo ⇒ error (safe default)", () => {
    expect(resolveWinShellMode({})).toBe("error")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "" })).toBe("error")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "powershell" })).toBe("error")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "1" })).toBe("error")
  })

  test("'cmd' (case-insensitive, trimmed) ⇒ cmd", () => {
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "cmd" })).toBe("cmd")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "CMD" })).toBe("cmd")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "  cmd  " })).toBe("cmd")
  })
})

/* ================================================================== */
/*  e2e hellgate — drive the REAL runShell seam on a forced win32      */
/* ================================================================== */

describe("P16 — runShell win32 e2e (no silent spawn)", () => {
  const realDesc = Object.getOwnPropertyDescriptor(process, "platform")
  const forcePlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, "platform", { value: p, configurable: true })
  }
  afterEach(() => {
    if (realDesc) Object.defineProperty(process, "platform", realDesc)
  })

  test("HELL-WIN-E2E: win32 default → typed error ShellResult, NO throw, exitCode 127", async () => {
    forcePlatform("win32")
    // Ensure the cmd opt-in is NOT set for this assertion.
    const prev = process.env.QUANTA_WIN_SHELL
    delete process.env.QUANTA_WIN_SHELL
    try {
      const result = await runShell("echo should-not-spawn")
      expect(result.exitCode).toBe(127)
      expect(result.timedOut).toBe(false)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("win32")
      expect(result.stderr).toContain("QUANTA_WIN_SHELL=cmd")
    } finally {
      if (prev !== undefined) process.env.QUANTA_WIN_SHELL = prev
    }
  })

  test("HELL-WIN-E2E2: real spawn still works on the host (non-win32 byte path is live)", async () => {
    // Sanity that the legacy path is untouched on the actual test host (darwin/
    // linux). If the host is genuinely win32 this would need cmd; CI is POSIX.
    if (realDesc?.value === "win32") return
    const result = await runShell("printf hello")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
  })
})
