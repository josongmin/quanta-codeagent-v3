/**
 * BenchStreamTap — a tool name the plan-mode table does not know must not crash a run.
 *
 * `editTargetOf` used `mutatingToolKind`, which fails CLOSED by throwing
 * `UnknownToolError`. The tap is the run's `config.stream`, and the streaming turn
 * emits `tool_call` for every deferred slot before dispatch validates the name and
 * outside its try block — so a hallucinated tool name threw out of `emit` and took
 * the instance down instead of producing an unknown-tool result for the model.
 */
import { describe, expect, test } from "bun:test"
import { classifiedMutatingKind, mutatingToolKind } from "@/agent"
import { isMutatingTool } from "@/agent/mode"
import type { AgentEvent } from "@/stream"
import { BenchStreamTap, editTargetOf } from "./stream-tap"

const nullStream = { emit: () => {} }
const toolCall = (id: string, name: string, input: unknown): AgentEvent =>
  ({ type: "tool_call", id, name, input }) as AgentEvent

describe("BenchStreamTap — unknown tool names", () => {
  test("a hallucinated tool name passes through emit without throwing and counts no edit", () => {
    const tap = new BenchStreamTap(nullStream)
    for (const name of ["made_up_tool", "mcp__github__create_issue", "constructor", "__proto__"]) {
      expect(() => tap.emit(toolCall(name, name, { file_path: "src/x.ts" })), name).not.toThrow()
    }
    expect(tap.editCount).toBe(0)
  })

  test("PAIRED CONTROL: a classified edit tool is still counted, with its path", () => {
    // Without this, an editTargetOf that returned undefined for everything would pass
    // the arm above.
    const tap = new BenchStreamTap(nullStream)
    tap.emit(toolCall("e1", "edit", { file_path: "src/a.ts" }))
    expect(tap.editCount).toBe(1)
    expect(editTargetOf("edit", { file_path: "src/a.ts" })).toBe("src/a.ts")
  })

  test("notebook_edit counts as an edit — its write_filesystem kind is what drives it", () => {
    // An adversarial audit changed `notebook_edit` to `bash_mutating` and 706 tests
    // across ten files stayed green. The kind is load-bearing HERE: it decides whether
    // a bench run's notebook edits reach editCount and the no-patch breaker.
    expect(classifiedMutatingKind("notebook_edit")).toBe("write_filesystem")
    expect(editTargetOf("notebook_edit", { notebook_path: "nb/a.ipynb" })).toBe("nb/a.ipynb")
  })
})

describe("the plan-mode classifier reads OWN keys only", () => {
  test("prototype names are unknown, not classified", () => {
    // `in` walks the prototype chain: `constructor` read as classified with a
    // function as its kind. Fail-closed at the seam is preserved — they now throw.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(classifiedMutatingKind(name), name).toBeUndefined()
      expect(() => mutatingToolKind(name), name).toThrow()
      expect(() => isMutatingTool(name), name).toThrow()
    }
  })

  test("PAIRED CONTROL: a real row still answers from both accessors", () => {
    expect(classifiedMutatingKind("read")).toBeNull()
    expect(mutatingToolKind("read")).toBeNull()
    expect(classifiedMutatingKind("bash")).toBe("bash_mutating")
    expect(isMutatingTool("bash")).toBe(true)
  })
})
