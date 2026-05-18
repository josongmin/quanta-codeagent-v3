import { describe, expect, test } from "bun:test"
import { evaluate } from "@/permission"

describe("permission.evaluate", () => {
  test("read-only is always allowed", () => {
    const d = evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
    expect(d.kind).toBe("allow")
  })

  test("dangerous bash is hard-denied even in bypass", () => {
    const d = evaluate(
      { tool: "bash", input: { command: "rm -rf /" }, isReadOnly: false },
      { mode: "bypass" },
    )
    expect(d.kind).toBe("deny")
  })

  test("mutation asks in default mode, allows in acceptEdits", () => {
    const action = { tool: "write", input: { path: "a" }, isReadOnly: false }
    expect(evaluate(action, { mode: "default" }).kind).toBe("ask")
    expect(evaluate(action, { mode: "acceptEdits" }).kind).toBe("allow")
  })
})
