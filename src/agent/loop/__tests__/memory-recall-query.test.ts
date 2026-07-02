/**
 * Sibling of the captureInterruptedTurn stale-picker fix — `resolveMemoryContext`
 * derived its recall QUERY from the last `role:"user"` message unconditionally, so
 * after a tools turn (which appends a `{role:"user", content:[tool_result…]}`
 * carrier) the query collapsed to "" and recall ran unfocused on EVERY subsequent
 * turn. `deriveRecallQuery` skips carrier / whitespace-only user turns.
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { deriveRecallQuery } from "../context-assembler"

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const a = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })
const toolResultUser = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }],
})

describe("deriveRecallQuery — skip carrier turns", () => {
  test("after a tools turn, query is the real prompt (NOT the empty tool_result carrier)", () => {
    const wm = createWorkingMemory([u("Fix the auth bug"), a("running tests"), toolResultUser("c1")])
    expect(deriveRecallQuery(wm)).toBe("Fix the auth bug")
  })

  test("skips a whitespace-only trailing user turn", () => {
    const wm = createWorkingMemory([u("Refactor parser"), a("ok"), u("  \n ")])
    expect(deriveRecallQuery(wm)).toBe("Refactor parser")
  })

  test("regression: a normal trailing user prompt is used verbatim", () => {
    const wm = createWorkingMemory([a("earlier"), u("do the thing")])
    expect(deriveRecallQuery(wm)).toBe("do the thing")
  })

  test("interleaved text + tool_result in one user message ⇒ text picked", () => {
    const mixed: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false },
        { type: "text", text: "and now do X" },
      ],
    }
    const wm = createWorkingMemory([u("earlier"), mixed])
    expect(deriveRecallQuery(wm)).toBe("and now do X")
  })

  test("no user text anywhere ⇒ undefined (byte-identical to the prior empty-query path)", () => {
    const wm = createWorkingMemory([toolResultUser("c1"), a("orphan")])
    expect(deriveRecallQuery(wm)).toBeUndefined()
  })
})
