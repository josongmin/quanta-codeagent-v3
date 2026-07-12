/**
 * WS1 SCENARIO hellgate (jul-12 OmO absorption) — end-to-end guarantees for
 * exec_command's process-tree teardown, driven through the REAL
 * `buildSubagentBlock` → `exec_command` Tool.execute path with REAL bash (no
 * fake fork). Complements the composition-wire test (timeout → backgrounded
 * grandchild reaped) with the two remaining real-process guarantees:
 *
 *   §1  ABORT parity — a cancelled tool call (ctx.signal abort) reaps the
 *       backgrounded grandchild, same as a timeout. (Previously abort was only
 *       pinned at the spy level.)
 *   §2  DEPTH — a two-level tree (foreground bash → `bash -c` → sleep) is fully
 *       reaped: the great-grandchild sleep dies too, proving the ppid walk
 *       descends past the immediate child.
 *
 * Red-on-injection: remove tier1's `makeKill` injection and exec falls back to a
 * single-pid `proc.kill()` on the foreground shell — the backgrounded
 * descendant survives ⇒ both go RED.
 *
 * HONEST LIMITATION (not tested green): the ppid-walk killer re-reads `ps -A`
 * on each signal, so a descendant that IGNORES SIGTERM (trap) AND whose
 * intermediate parent dies before the SIGKILL grace elapses gets reparented to
 * init and is MISSED by the escalation walk. Reaping that case needs
 * pidfd/cgroup.kill containment — the RFC's deferred Phase-2 SOTA fix
 * (00-final-rfc §0.3). The stopgap guarantees the common (SIGTERM-responsive,
 * tree-intact-at-signal) case, which is what §1/§2 pin.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSubagentBlock } from "../../src/agent/tier1/subagent"
import type { AgentConfig } from "../../src/agent/types"
import type { Tool, ToolContext } from "../../src/tool"

const cfg = (subagent: NonNullable<AgentConfig["subagent"]>): AgentConfig =>
  ({ subagent }) as unknown as AgentConfig

const execTool = (): Tool => {
  const block = buildSubagentBlock(cfg({ enable6Tools: true }))
  const exec = block?.extraTools.find((t) => t.name === "exec_command")
  if (exec === undefined) throw new Error("exec_command tool not assembled")
  return exec
}

const driveWith = async (tool: Tool, input: unknown, signal: AbortSignal): Promise<void> => {
  const ctx = { cwd: tmpdir(), signal } as ToolContext
  for await (const _ev of tool.execute(input as never, ctx)) {
    // drain to completion
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait until `path` exists (the child has recorded its pid), or throw. Generous
 *  ceiling (~3s) so a cold bash start on a slow/loaded box can't flake the test
 *  before the pid file is written. */
const waitForFile = async (path: string): Promise<void> => {
  for (let i = 0; i < 150; i++) {
    if (existsSync(path)) return
    await sleep(20)
  }
  throw new Error(`pid file never appeared: ${path}`)
}

/** Poll until `pid` is reaped (up to ~4s); returns whether it died. Kills it on
 *  failure so a regression never leaves a real orphan on the box. */
const awaitReaped = async (pid: number): Promise<boolean> => {
  let alive = true
  for (let i = 0; i < 40 && alive; i++) {
    alive = isAlive(pid)
    if (alive) await sleep(100)
  }
  if (alive) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // race — already gone
    }
  }
  return !alive
}

describe("WS1 scenarios — exec_command process-tree teardown (real bash)", () => {
  test("§1 ABORT reaps the backgrounded grandchild (parity with timeout)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-ws1-abort-"))
    const pidFile = join(dir, "gc.pid")
    const controller = new AbortController()
    try {
      const p = driveWith(
        execTool(),
        { command: `sleep 30 & echo $! > ${pidFile}; wait`, cwd: dir, timeoutMs: 60_000 },
        controller.signal,
      )
      await waitForFile(pidFile)
      controller.abort()
      await p

      const gcPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
      expect(gcPid).toBeGreaterThan(0)
      expect(await awaitReaped(gcPid)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test("§2 DEPTH — a two-level tree reaps the great-grandchild sleep on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-ws1-depth-"))
    const ggFile = join(dir, "gg.pid")
    try {
      // foreground `bash -lc` → `bash -c` → backgrounded sleep (great-grandchild).
      await driveWith(
        execTool(),
        {
          command: `bash -c 'sleep 30 & echo $! > ${ggFile}; wait'`,
          cwd: dir,
          timeoutMs: 300,
        },
        new AbortController().signal,
      )
      await waitForFile(ggFile)
      const ggPid = Number.parseInt(readFileSync(ggFile, "utf8").trim(), 10)
      expect(ggPid).toBeGreaterThan(0)
      expect(await awaitReaped(ggPid)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
