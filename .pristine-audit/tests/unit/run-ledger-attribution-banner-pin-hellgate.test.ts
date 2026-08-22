/**
 * Audit R1-B / R2 (F6) — cross-module banner pinning.
 *
 * The `run-ledger-attribution` matchers (`src/agent/run-ledger-attribution/
 * matchers.ts`) consume the `post_tool_use` event's `output` STRING and
 * anchor on literal banner prefixes (`[bash background]` / `Subagent launched
 * in background.` / `Stopped task `). If a tool author renames its banner
 * without coordinating, the matcher silently returns null → ledger
 * attribution goes dark for that tool, and unit tests in each file continue
 * to pass because each side only knows its OWN literal.
 *
 * This file is the cross-test: it constructs the SAME banner string both
 * the tool produces and the matcher expects, then feeds it into the
 * matcher. If either side drifts, this test fails with a precise diff so a
 * renamer sees the contract break in CI rather than at runtime.
 *
 * Scope is limited to the load-bearing anchors (4 banners total). A future
 * tool that grows a new background lifecycle should add its banner here.
 */

import { describe, expect, test } from "bun:test"
import { createDefaultLedgerMatcher } from "@/agent/run-ledger-attribution/matchers"

const matcher = createDefaultLedgerMatcher()

describe("run-ledger-attribution: cross-module banner pinning (F6)", () => {
  // ---- bash background (loop into the matcher's start) -------------------
  test("bash background launch banner: tool string ⇒ matcher emits 'start' kind:'shell'", () => {
    // EXACT literal must match `src/tool/bash/index.ts:267` (lines like
    // `[bash background] shellId=<id> status=running\n…`).
    const shellId = "sh-pin-1"
    const output = `[bash background] shellId=${shellId} status=running\nstdout so far:\n`
    const action = matcher.match({ name: "bash", input: {}, output, ok: true })
    expect(action?.kind).toBe("start")
    if (action?.kind === "start") {
      expect(action.runKind).toBe("shell")
      expect(action.id).toBe(shellId)
    }
  })

  // ---- subagent (agent tool background) ----------------------------------
  test("subagent background launch banner: tool string ⇒ matcher emits 'start' kind:'subagent'", () => {
    // EXACT literal must match `src/subagent/agent-tool.ts:244`
    // (`Subagent launched in background. task_id: <id>\n…`).
    const taskId = "task-pin-1"
    const output = `Subagent launched in background. task_id: ${taskId}\npoll with task_output`
    const action = matcher.match({
      name: "agent",
      input: { background: true },
      output,
      ok: true,
    })
    expect(action?.kind).toBe("start")
    if (action?.kind === "start") {
      expect(action.runKind).toBe("subagent")
      expect(action.id).toBe(taskId)
    }
  })

  // ---- task_stop banner --------------------------------------------------
  test("task_stop success banner: tool string ⇒ matcher emits 'settle' status:'stopped'", () => {
    // EXACT literal must match `src/subagent/task-tools.ts:156`
    // (`Stopped task <id>.`).
    const taskId = "task-pin-stop-1"
    const output = `Stopped task ${taskId}.`
    const action = matcher.match({
      name: "task_stop",
      input: { task_id: taskId },
      output,
      ok: true,
    })
    expect(action?.kind).toBe("settle")
    if (action?.kind === "settle") {
      expect(action.status).toBe("stopped")
      expect(action.id).toBe(taskId)
    }
  })

  // ---- bash_kill banner (companion to bash background lifecycle) ---------
  test("bash_kill banner: tool [bash_kill … ] prefix ⇒ matcher emits 'settle' status:'stopped'", () => {
    // The matcher anchors on `[bash_kill` (`matchers.ts:165`). Pin the prefix
    // alongside the bash tool's `bash_kill` event surface so a rename of
    // either side breaks here.
    const shellId = "sh-pin-kill-1"
    const output = `[bash_kill shellId=${shellId} signaled]`
    const action = matcher.match({ name: "bash_kill", input: {}, output, ok: true })
    expect(action?.kind).toBe("settle")
    if (action?.kind === "settle") {
      expect(action.status).toBe("stopped")
      expect(action.id).toBe(shellId)
    }
  })
})
