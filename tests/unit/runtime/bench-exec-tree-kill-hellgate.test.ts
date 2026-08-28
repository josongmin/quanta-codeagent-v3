/**
 * F4 — the bench exec deadline must reap the whole process TREE.
 *
 * `runner/batch/eval/exec.ts` used to hand-roll its own SIGTERM→SIGKILL
 * escalation instead of using the canonical `escalatingKill`. Converging it onto
 * the shared primitive must not regress the behaviour the hand-rolled copy
 * existed for: a bench `testCmd` is a TREE (`bash -c` → pytest → workers), and a
 * surviving grandchild holds the stdout pipe open so the `.text()` await HANGS
 * past the deadline — the exact stall jun-26 fixed.
 *
 * This is a REAL-process test (it spawns `bash`), deliberately: the hazard is a
 * pipe held open by a grandchild, which a fake child cannot reproduce. The
 * grandchild writes its pid to a temp file so we can probe it with signal 0
 * AFTER the deadline and prove it is actually gone, rather than inferring
 * liveness from exec returning.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exec } from "@/runner/batch/eval/exec"

const scratch = mkdtempSync(join(tmpdir(), "bench-exec-tree-kill-"))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Is `pid` still alive? `kill(pid, 0)` delivers no signal; it only probes. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("bench exec — deadline tree-kill (F4 convergence guard)", () => {
  test("a timed-out command's GRANDCHILD is reaped, and exec returns instead of hanging", async () => {
    const pidFile = join(scratch, "grandchild.pid")
    // bash (root) → bash -c subshell (child) → sleep (grandchild). The
    // grandchild inherits the stdout pipe, so a root-only kill would leave
    // `new Response(proc.stdout).text()` pending until the sleep finishes.
    const cmd = `bash -c 'echo $$ > ${pidFile}; sleep 45' & sleep 45`

    const started = Date.now()
    const result = await exec(cmd, scratch, 400)
    const elapsed = Date.now() - started

    // It RETURNED — the pipe was released well before the 45s sleeps.
    expect(elapsed).toBeLessThan(15_000)
    expect(result).toHaveProperty("code")

    // And the GRANDCHILD is actually dead, not merely detached from our pipe.
    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(grandchild).toBeGreaterThan(0)
    // Give the SIGTERM a moment to be delivered and reaped.
    await Bun.sleep(300)
    expect(alive(grandchild), `grandchild ${grandchild} survived the deadline`).toBe(false)
  }, 30_000)

  // PAIRED CONTROL — the deadline must not kill a command that finishes in time.
  // A "fix" that just kills everything immediately fails this.
  test("a command that finishes inside its deadline runs to completion untouched", async () => {
    const result = await exec("echo tree-kill-control", scratch, 20_000)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("tree-kill-control")
  }, 30_000)
})
