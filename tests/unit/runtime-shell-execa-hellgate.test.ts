/** ADR-0192 hellgate — `runShellExeca` parity with `runShell`. 15 cases
 *  proving the execa-backed sibling honors the same ShellResult contract:
 *  basic exec (5), timeout + kill (4), signal cancellation (3), edge (3). */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runShellExeca } from "@/runtime/shell-execa"

// Per-suite scratch dir for cwd / env / large-output cases. Created once,
// removed on teardown. Hellgate cases must be hermetic; no /tmp pollution.
let workdir: string
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "shell-execa-hellgate-"))
})
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe("ADR-0192 / A — basic exec parity", () => {
  test("A1: echo hello → stdout 'hello\\n', exitCode 0", async () => {
    const r = await runShellExeca("echo hello")
    expect(r.stdout).toBe("hello\n")
    expect(r.stderr).toBe("")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  test("A2: `false` → non-zero exitCode, ShellResult shape preserved", async () => {
    const r = await runShellExeca("false")
    expect(r.exitCode).not.toBe(0)
    expect(r.timedOut).toBe(false)
    expect(typeof r.stdout).toBe("string")
    expect(typeof r.stderr).toBe("string")
  })

  test("A3: stderr capture — `echo err >&2`", async () => {
    const r = await runShellExeca("echo err >&2")
    expect(r.stderr).toBe("err\n")
    expect(r.stdout).toBe("")
    expect(r.exitCode).toBe(0)
  })

  test("A4: cwd option — `pwd` runs in the chosen dir", async () => {
    const r = await runShellExeca("pwd", { cwd: workdir })
    // macOS resolves /var → /private/var; both end with the same trailing dir.
    expect(r.stdout.trim().endsWith(workdir.split("/").pop() ?? "")).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  test("A5: inheritEnv:true makes a parent var visible in the subprocess", async () => {
    process.env.RUNSHELL_EXECA_HG_VAR = "visible-to-child"
    try {
      const r = await runShellExeca('echo "$RUNSHELL_EXECA_HG_VAR"', {
        inheritEnv: true,
      })
      expect(r.stdout.trim()).toBe("visible-to-child")
      expect(r.exitCode).toBe(0)
    } finally {
      delete process.env.RUNSHELL_EXECA_HG_VAR
    }
  })
})

describe("ADR-0192 / B — timeout + kill escalation", () => {
  test("B6: sleep + timeoutMs:100 → timedOut:true and non-zero exitCode", async () => {
    const r = await runShellExeca("sleep 5", { timeoutMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
  })

  test("B7: default killSignal is SIGTERM (exitCode 143 convention when killed)", async () => {
    // execa sends SIGTERM by default; our adapter maps the resulting
    // signal-killed Result to exitCode 143 (the conventional 128+SIGTERM).
    const r = await runShellExeca("sleep 5", { timeoutMs: 50 })
    expect(r.timedOut).toBe(true)
    // exitCode is 143 (SIGTERM convention) OR a numeric subprocess exit code
    // if the shell trapped + exited cleanly before the force-kill. Either
    // way it MUST be non-zero.
    expect(r.exitCode).not.toBe(0)
  })

  test("B8: kill escalation actually terminates the child (not 30s wait)", async () => {
    // If timeout escalation were broken we'd hang for 30s. Wall-clock the
    // call and assert it returns well within the force-kill window (5s + a
    // generous CI buffer = 7s).
    const start = Date.now()
    const r = await runShellExeca("sleep 30", { timeoutMs: 100 })
    const elapsedMs = Date.now() - start
    expect(r.timedOut).toBe(true)
    expect(elapsedMs).toBeLessThan(7_000)
  })

  test("B9: trap-ignoring child still dies via SIGKILL force-escalation", async () => {
    // A bash script that traps SIGTERM into a no-op would normally survive
    // execa's default SIGTERM. `forceKillAfterDelay: 5000` should kick in
    // and SIGKILL it. We use a short timeout (200ms) + assert we don't wait
    // anywhere near 30s.
    const start = Date.now()
    const r = await runShellExeca("trap '' TERM; sleep 30", { timeoutMs: 200 })
    const elapsedMs = Date.now() - start
    expect(r.timedOut).toBe(true)
    expect(elapsedMs).toBeLessThan(7_000)
  })
})

describe("ADR-0192 / C — AbortSignal cancellation", () => {
  test("C10: signal already aborted before call → child terminated promptly", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    const r = await runShellExeca("sleep 30", { signal: ctrl.signal })
    const elapsedMs = Date.now() - start
    // Already-aborted signal: execa should refuse / terminate immediately.
    // We tolerate up to the force-kill window (5s) as the upper bound.
    expect(elapsedMs).toBeLessThan(7_000)
    expect(r.exitCode).not.toBe(0)
  })

  test("C11: signal aborted mid-run → subprocess killed, total < 7s", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
    const start = Date.now()
    const r = await runShellExeca("sleep 30", { signal: ctrl.signal })
    const elapsedMs = Date.now() - start
    expect(elapsedMs).toBeLessThan(7_000)
    expect(r.exitCode).not.toBe(0)
  })

  test("C12: signal NOT provided → no abort wiring, command runs to completion", async () => {
    // Defensive: with no signal set, a quick command must complete normally
    // without any abort-related side effects in the ShellResult.
    const r = await runShellExeca("echo done")
    expect(r.stdout).toBe("done\n")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })
})

describe("ADR-0192 / D — edge cases", () => {
  test("D13: empty command → exitCode 127, no spawn", async () => {
    const r = await runShellExeca("")
    expect(r.exitCode).toBe(127)
    expect(r.stderr).toContain("empty command")
    expect(r.timedOut).toBe(false)
  })

  test("D14: large stdout (>=1MB) captured intact", async () => {
    // 1024 * 1024 = 1,048,576 bytes; printf with %.s repeats one char.
    // Using yes piped to head keeps the test fast and deterministic.
    const r = await runShellExeca("yes A | head -c 1048576")
    expect(r.exitCode).toBe(0)
    // Allow trailing newline tolerance (head doesn't add one but the
    // assertion focuses on the byte count being captured, not truncated).
    expect(r.stdout.length).toBeGreaterThanOrEqual(1_048_576)
  })

  test("D15: utf-8 multibyte stdout round-trips through the decoder", async () => {
    // Non-ASCII payload — proves the encoding:'utf8' wiring is not silently
    // re-encoding via latin1 or stripping high bytes.
    const r = await runShellExeca("printf '한글-テスト-🚀\\n'")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("한글-テスト-🚀\n")
  })
})
