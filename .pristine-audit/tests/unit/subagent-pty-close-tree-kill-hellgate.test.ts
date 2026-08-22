/**
 * WS1 hell-audit remediation (P1) — a RETAINED pty child must be torn down by
 * the same escalating TREE killer that timeout/abort uses, not a single-pid
 * `proc.kill()`.
 *
 * GAP found in self-audit: `exec_command({pty:true})` that stays alive past the
 * attach grace is registered into the PtyTable; the WS1 tree-kill only guarded
 * the timeout/abort window. Session shutdown / test cleanup then reaps the slot
 * via `PtyTable.closeAll()`, which did a bare `s.proc.kill()` — SIGTERM to the
 * foreground shell only. A `bash -lc` that backgrounded a grandchild left that
 * descendant ORPHANED (reparented to init). So the exact leak class WS1 claimed
 * to fix ("reaps the whole tree") survived on the retained-pty axis.
 *
 * Fix: the PtySlot carries the `ProcKillHandle` built at spawn, and `closeAll`
 * routes through it. This test drives the REAL handler with a REAL tree killer.
 *
 * Red-on-injection: revert `closeAll` to `s.proc.kill()` (or drop the slot's
 * killHandle) ⇒ the backgrounded grandchild survives ⇒ RED.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultPpidWalkKiller, escalatingKill } from "@/runtime"
import { handleExecCommand, PtyTable } from "../../src/subagent/handlers-6"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitForFile = async (path: string): Promise<void> => {
  for (let i = 0; i < 150; i++) {
    if (existsSync(path)) return
    await sleep(20)
  }
  throw new Error(`pid file never appeared: ${path}`)
}

const awaitReaped = async (pid: number): Promise<boolean> => {
  let alive = true
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) await sleep(100)
  }
  if (alive) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // race
    }
  }
  return !alive
}

describe("WS1 P1 — PtyTable.closeAll tree-kills a retained pty's grandchild", () => {
  test("retained pty → closeAll reaps the backgrounded grandchild (red-on-injection: single-pid ⇒ survives)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-pty-close-"))
    const pidFile = join(dir, "gc.pid")
    const ptyTable = new PtyTable()
    try {
      // pty:true + a command that outlives the attach grace ⇒ the foreground
      // shell is RETAINED into the table (exitCode -1), backgrounding a sleep.
      const r = await handleExecCommand(
        {
          command: `sleep 30 & echo $! > ${pidFile}; wait`,
          cwd: dir,
          pty: true,
          timeoutMs: 60_000,
        },
        { ptyTable, makeKill: (proc) => escalatingKill(proc, defaultPpidWalkKiller()) },
      )
      expect(r.kind).toBe("success")
      if (r.kind === "success") expect(r.exitCode).toBe(-1) // attached, not exited
      expect(ptyTable.size()).toBe(1)

      await waitForFile(pidFile)
      const gcPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
      expect(gcPid).toBeGreaterThan(0)

      // Session shutdown / cleanup path — MUST reap the whole tree.
      ptyTable.closeAll()
      expect(await awaitReaped(gcPid)).toBe(true)
    } finally {
      ptyTable.closeAll()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
