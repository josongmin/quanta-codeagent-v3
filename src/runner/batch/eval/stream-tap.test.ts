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
  opts: { durationMs?: number; exitCode?: number } = {},
): AgentEvent =>
  ({
    type: "tool_result",
    id,
    name,
    ok,
    preview: "",
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
})
