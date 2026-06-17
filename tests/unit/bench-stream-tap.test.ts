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
