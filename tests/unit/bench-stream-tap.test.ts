/**
 * T-202 / F6 — bench stream tap (SSOT). Teeth on the observation contract:
 *  - editTargetOf reads the MUTATING_TOOL_TABLE `write_filesystem` set (not a
 *    private re-list) and pulls the right path field per tool,
 *  - firstEditFile is captured ONCE (first edit wins, never overwritten),
 *  - editCount counts only file-mutating calls (bash/test_runner excluded),
 *  - turnsToFirstEdit snapshots the turn at the first edit,
 *  - relFromSandbox relativizes absolute sandbox paths to gold-comparable form,
 *  - the tap forwards every event unchanged (pure pass-through).
 */
import { describe, expect, test } from "bun:test"
import { BenchStreamTap, editTargetOf, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import type { AgentEvent, StreamPort } from "@/stream"

class Capture implements StreamPort {
  events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

const toolCall = (name: string, input: unknown): AgentEvent => ({
  type: "tool_call",
  id: `c-${name}`,
  name,
  input,
})

describe("editTargetOf", () => {
  test("edit/write expose file_path", () => {
    expect(editTargetOf("edit", { file_path: "/s/a.py" })).toBe("/s/a.py")
    expect(editTargetOf("write", { file_path: "/s/b.py" })).toBe("/s/b.py")
  })

  test("apply_patch pulls first path from the V4A body", () => {
    const patch = "*** Begin Patch\n*** Update File: django/core/x.py\n@@\n-a\n+b\n*** End Patch"
    expect(editTargetOf("apply_patch", { patch })).toBe("django/core/x.py")
  })

  test("non-mutating tools (read/bash/test_runner) return undefined", () => {
    expect(editTargetOf("read", { file_path: "/s/a.py" })).toBeUndefined()
    expect(editTargetOf("bash", { command: "rm -rf x" })).toBeUndefined()
    expect(editTargetOf("test_runner", {})).toBeUndefined()
  })

  test("garbage input never throws, returns undefined", () => {
    expect(editTargetOf("edit", null)).toBeUndefined()
    expect(editTargetOf("edit", { file_path: 123 })).toBeUndefined()
  })
})

describe("relFromSandbox", () => {
  test("relativizes an absolute path under the sandbox to repo-relative", () => {
    expect(relFromSandbox("/tmp/sbx", "/tmp/sbx/django/core/x.py")).toBe("django/core/x.py")
  })
  test("an already-relative path is returned as-is (normalised)", () => {
    expect(relFromSandbox("/tmp/sbx", "django/core/x.py")).toBe("django/core/x.py")
  })
  test("a path outside the sandbox is kept raw (not guessed)", () => {
    expect(relFromSandbox("/tmp/sbx", "/other/y.py")).toBe("/other/y.py")
  })
  test("undefined stays undefined", () => {
    expect(relFromSandbox("/tmp/sbx", undefined)).toBeUndefined()
  })
})

describe("BenchStreamTap", () => {
  test("first edit wins; editCount counts only mutating; turnsToFirstEdit snapshots", () => {
    const down = new Capture()
    const tap = new BenchStreamTap(down)
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("read", { file_path: "/s/look.py" })) // not counted
    tap.emit({ type: "turn_start", turn: 2 })
    tap.emit(toolCall("edit", { file_path: "/s/first.py" })) // FIRST edit @ turn 2
    tap.emit({ type: "turn_start", turn: 3 })
    tap.emit(toolCall("write", { file_path: "/s/second.py" })) // 2nd edit
    tap.emit(toolCall("bash", { command: "pytest" })) // not an edit

    expect(tap.firstEditFile).toBe("/s/first.py") // not overwritten by second.py
    expect(tap.turnsToFirstEdit).toBe(2)
    expect(tap.editCount).toBe(2)
    expect(tap.lastVerifyCmd).toBe("pytest")
  })

  test("no edits ⇒ firstEditFile/turnsToFirstEdit undefined, editCount 0", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("read", { file_path: "/s/a.py" }))
    expect(tap.firstEditFile).toBeUndefined()
    expect(tap.turnsToFirstEdit).toBeUndefined()
    expect(tap.editCount).toBe(0)
  })

  test("pure pass-through: every event reaches downstream unchanged", () => {
    const down = new Capture()
    const tap = new BenchStreamTap(down)
    const evs: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      toolCall("edit", { file_path: "/s/x.py" }),
      { type: "error", message: "boom" },
    ]
    for (const e of evs) tap.emit(e)
    expect(down.events).toEqual(evs)
    expect(tap.lastErrorMessage).toBe("boom")
  })
})

// P0 — verify-pass detection (tentative-patch retention). The tap fires
// `onVerifyPass` exactly when a VERIFY tool_result comes back passing, so the
// driver can snapshot a verified-green candidate. Teeth: pass fires, fail/
// failing-output/non-verify do NOT, and absent callback is byte-identical.
const toolResult = (name: string, ok: boolean, preview = ""): AgentEvent => ({
  type: "tool_result",
  id: `c-${name}`,
  name,
  ok,
  preview,
})

describe("BenchStreamTap verify-pass (P0)", () => {
  const run = (events: AgentEvent[]): { fired: number; forwarded: number } => {
    const cap = new Capture()
    let fired = 0
    const tap = new BenchStreamTap(cap, () => {
      fired += 1
    })
    for (const e of events) tap.emit(e)
    return { fired, forwarded: cap.events.length }
  }

  test("test_runner PASS → fires once", () => {
    expect(run([toolCall("test_runner", {}), toolResult("test_runner", true)]).fired).toBe(1)
  })

  test("test_runner FAIL (ok:false) → does NOT fire", () => {
    expect(run([toolCall("test_runner", {}), toolResult("test_runner", false)]).fired).toBe(0)
  })

  test("test_runner ok:true but FAILING OUTPUT → does NOT fire", () => {
    expect(
      run([toolCall("test_runner", {}), toolResult("test_runner", true, "1 failed, 3 passed")])
        .fired,
    ).toBe(0)
  })

  test("bash test-like command (pytest) PASS → fires", () => {
    expect(
      run([toolCall("bash", { command: "python -m pytest tests/x.py" }), toolResult("bash", true)])
        .fired,
    ).toBe(1)
  })

  test("bash NON-test command PASS → does NOT fire", () => {
    expect(run([toolCall("bash", { command: "ls -la" }), toolResult("bash", true)]).fired).toBe(0)
  })

  test("an edit tool result → does NOT fire (only verifies count)", () => {
    expect(run([toolCall("edit", { file_path: "/s/a.py" }), toolResult("edit", true)]).fired).toBe(
      0,
    )
  })

  test("multiple verifies → fires once each (seq advances)", () => {
    expect(
      run([
        toolCall("test_runner", {}),
        toolResult("test_runner", true),
        toolCall("test_runner", {}),
        toolResult("test_runner", true),
      ]).fired,
    ).toBe(2)
  })

  test("RED-on-injection: NO callback → never fires, forwards EVERY event unchanged (byte-identical)", () => {
    const cap = new Capture()
    const tap = new BenchStreamTap(cap) // no onVerifyPass
    const events = [toolCall("test_runner", {}), toolResult("test_runner", true)]
    for (const e of events) tap.emit(e)
    expect(cap.events).toEqual(events) // pure pass-through, no crash
  })
})
