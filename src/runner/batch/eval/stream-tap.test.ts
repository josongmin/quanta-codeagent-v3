/**
 * BenchStreamTap — unit tests for the onToolResult observer callback.
 *
 * Pins the new 5th-param contract: a callback supplied to the constructor is
 * called once per tool_result event with the tool name, ok flag, and optional
 * durationMs / exitCode when the event carries them. Absent callback ⇒
 * byte-identical (no call, no throw). Verify calls are ALSO dispatched (the
 * callback observes ALL tool results, not just non-verify ones).
 *
 * RED-on-injection: if the callback is never invoked, the spied call counts
 * assertions fail.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import { BenchStreamTap } from "./stream-tap"

const nullStream = { emit: () => {} }

const toolCall = (id: string, name: string, input: unknown = {}): AgentEvent =>
  ({ type: "tool_call", id, name, input }) as AgentEvent

const toolResult = (
  id: string,
  name: string,
  ok: boolean,
  opts: { durationMs?: number; exitCode?: number; preview?: string } = {},
): AgentEvent =>
  ({
    type: "tool_result",
    id,
    name,
    ok,
    preview: opts.preview ?? "",
    content: [],
    ...opts,
  }) as unknown as AgentEvent

describe("BenchStreamTap — onToolResult", () => {
  test("callback fires once per tool_result with name + ok", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    tap.emit(toolCall("c1", "bash", { command: "ls" }))
    tap.emit(toolResult("c1", "bash", true))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: "bash", ok: true })
  })

  test("callback receives durationMs and exitCode when present", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    tap.emit(toolCall("c1", "bash", { command: "pytest" }))
    tap.emit(toolResult("c1", "bash", false, { durationMs: 1234, exitCode: 1 }))
    expect(calls[0]).toMatchObject({ name: "bash", ok: false, durationMs: 1234, exitCode: 1 })
  })

  test("durationMs and exitCode are omitted from callback when absent", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    tap.emit(toolCall("c1", "edit", { file_path: "/f.py" }))
    tap.emit(toolResult("c1", "edit", true))
    const c = calls[0] as Record<string, unknown>
    expect(c).not.toHaveProperty("durationMs")
    expect(c).not.toHaveProperty("exitCode")
  })

  test("absent callback ⇒ no throw on tool_result", () => {
    const tap = new BenchStreamTap(nullStream)
    tap.emit(toolCall("c1", "bash", { command: "echo hi" }))
    expect(() => tap.emit(toolResult("c1", "bash", true))).not.toThrow()
  })

  test("fires for every tool_result including verify commands", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    tap.emit(toolCall("v1", "test_runner", {}))
    tap.emit(toolResult("v1", "test_runner", true))
    tap.emit(toolCall("b1", "bash", { command: "ls" }))
    tap.emit(toolResult("b1", "bash", false))
    expect(calls).toHaveLength(2)
    expect((calls[0] as { name: string }).name).toBe("test_runner")
    expect((calls[1] as { name: string }).name).toBe("bash")
  })

  test("edit tool result includes file path; non-edit result does not", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    // edit tool → should carry file
    tap.emit(toolCall("e1", "edit", { file_path: "src/foo.py" }))
    tap.emit(toolResult("e1", "edit", true))
    // bash (non-edit) → no file
    tap.emit(toolCall("b1", "bash", { command: "pytest" }))
    tap.emit(toolResult("b1", "bash", true))
    expect(calls).toHaveLength(2)
    expect((calls[0] as Record<string, unknown>).file).toBe("src/foo.py")
    expect(calls[1] as Record<string, unknown>).not.toHaveProperty("file")
  })

  test("failed edit result still includes file path", () => {
    const calls: unknown[] = []
    const tap = new BenchStreamTap(nullStream, undefined, undefined, undefined, (args) =>
      calls.push(args),
    )
    tap.emit(toolCall("e1", "edit", { file_path: "src/bar.py" }))
    tap.emit(toolResult("e1", "edit", false))
    expect((calls[0] as Record<string, unknown>).file).toBe("src/bar.py")
    expect((calls[0] as Record<string, unknown>).ok).toBe(false)
  })
})

// ── onEditResult (6th param, jul-13 editTrace debug enricher, ADR-0539) ──────
// Pins the per-edit observer: fires ONLY for file-mutating tools, carries the
// raw edit signals (file / ok / preview / replaceAll) the driver shapes into an
// editTrace slice, and is byte-identical when absent (no stash, no call).
describe("BenchStreamTap — onEditResult", () => {
  const editArgs = (calls: unknown[]) =>
    new BenchStreamTap(nullStream, undefined, undefined, undefined, undefined, (a) => calls.push(a))

  test("fires once per edit tool_result with file + ok + preview + replaceAll", () => {
    const calls: unknown[] = []
    const tap = editArgs(calls)
    tap.emit(toolCall("e1", "edit", { file_path: "src/foo.py", replace_all: true }))
    tap.emit(toolResult("e1", "edit", true, { preview: "src/foo.py: Replaced 3 occurrence(s)" }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      file: "src/foo.py",
      ok: true,
      preview: "src/foo.py: Replaced 3 occurrence(s)",
      replaceAll: true,
    })
  })

  test("replaceAll defaults to false when the tool_call omits it", () => {
    const calls: unknown[] = []
    const tap = editArgs(calls)
    tap.emit(toolCall("e1", "edit", { file_path: "a.py" }))
    tap.emit(toolResult("e1", "edit", true, { preview: "a.py: Replaced 1 occurrence(s)" }))
    expect((calls[0] as Record<string, unknown>).replaceAll).toBe(false)
  })

  test("does NOT fire for a non-mutating tool_result", () => {
    const calls: unknown[] = []
    const tap = editArgs(calls)
    tap.emit(toolCall("b1", "bash", { command: "pytest" }))
    tap.emit(toolResult("b1", "bash", true, { preview: "ok" }))
    tap.emit(toolCall("r1", "read", { path: "x.py" }))
    tap.emit(toolResult("r1", "read", true, { preview: "file body" }))
    expect(calls).toHaveLength(0)
  })

  test("multiple edits in a turn each fire (accumulation source)", () => {
    const calls: unknown[] = []
    const tap = editArgs(calls)
    tap.emit(toolCall("e1", "edit", { file_path: "a.py" }))
    tap.emit(toolResult("e1", "edit", true, { preview: "a.py: Replaced 1 occurrence(s)" }))
    tap.emit(toolCall("e2", "edit", { file_path: "b.py" }))
    tap.emit(
      toolResult("e2", "edit", true, {
        preview: "b.py: Replaced 1 occurrence(s) via whitespace-flexible match",
      }),
    )
    expect(calls).toHaveLength(2)
    expect((calls[0] as Record<string, unknown>).file).toBe("a.py")
    expect((calls[1] as Record<string, unknown>).file).toBe("b.py")
  })

  test("absent callback ⇒ no throw, no stash growth (byte-identical)", () => {
    const tap = new BenchStreamTap(nullStream)
    tap.emit(toolCall("e1", "edit", { file_path: "a.py" }))
    expect(() =>
      tap.emit(toolResult("e1", "edit", true, { preview: "a.py: Replaced 1 occurrence(s)" })),
    ).not.toThrow()
  })
})
