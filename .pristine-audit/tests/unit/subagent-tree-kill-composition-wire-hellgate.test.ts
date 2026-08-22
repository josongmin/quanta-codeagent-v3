/**
 * WS1 composition wire (jul-12 OmO absorption) — proves the tree-kill capability
 * is ACTUALLY injected by the composition root, so the correctness fix cannot
 * degrade into an inert gate (the exact "sophisticated machine + green test +
 * never wired live" pathology the self-audit 04 §4 flagged).
 *
 * The seam (`handleExecCommand.makeKill`) + the dispatcher forward are pinned by
 * `subagent-exec-tree-kill-hellgate`. THIS file closes the loop end-to-end: it
 * builds the REAL `buildSubagentBlock` (which is where `tier1/subagent.ts`
 * injects `escalatingKill(proc, defaultPpidWalkKiller())`), drives the REAL
 * `exec_command` Tool.execute path, and asserts a backgrounded GRANDCHILD is
 * reaped on timeout.
 *
 * Red-on-injection: remove the `makeKill:` line from tier1/subagent.ts and
 * exec_command falls back to a single-pid `proc.kill()` on the `bash` shell —
 * the backgrounded `sleep` is orphaned (reparented to init), stays alive, and
 * this test goes RED. NO fake fork: a real bash really backgrounds a real sleep.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSubagentBlock } from "../../src/agent/tier1/subagent"
import type { AgentConfig } from "../../src/agent/types"
import type { Tool, ToolContext } from "../../src/tool"

const ctx = (): ToolContext =>
  ({ cwd: tmpdir(), signal: new AbortController().signal }) as ToolContext

const drive = async (tool: Tool, input: unknown): Promise<void> => {
  for await (const _ev of tool.execute(input as never, ctx())) {
    // drain to completion (terminal result carries cause:"timeout")
  }
}

const cfg = (subagent: NonNullable<AgentConfig["subagent"]>): AgentConfig =>
  ({ subagent }) as unknown as AgentConfig

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("WS1 composition — exec_command reaps a backgrounded grandchild on timeout", () => {
  test("real tier1-injected tree killer reaps the orphaned sleep (red-on-injection: legacy proc.kill ⇒ survives)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-ws1-"))
    const pidFile = join(dir, "gc.pid")
    try {
      const block = buildSubagentBlock(cfg({ enable6Tools: true }))
      const exec = block?.extraTools.find((t) => t.name === "exec_command")
      expect(exec).toBeDefined()

      // bash backgrounds a 30s sleep, records ITS pid, then waits. On timeout the
      // shell is torn down; only a TREE kill also reaps the backgrounded sleep.
      await drive(exec as Tool, {
        command: `sleep 30 & echo $! > ${pidFile}; wait`,
        cwd: dir,
        timeoutMs: 300,
      })

      // The grandchild pid was recorded before the timeout fired.
      const gcPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
      expect(Number.isInteger(gcPid)).toBe(true)
      expect(gcPid).toBeGreaterThan(0)

      // Poll for reaping (SIGTERM→grace→SIGKILL over the tree needs a moment).
      let alive = true
      for (let i = 0; i < 40 && alive; i++) {
        alive = isAlive(gcPid)
        if (alive) await sleep(100)
      }
      // Clean up the sleep if the fix regressed, so the box isn't left leaking.
      if (alive) {
        try {
          process.kill(gcPid, "SIGKILL")
        } catch {
          // race — already gone
        }
      }
      expect(alive).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
