/**
 * ADR-0077 — readonly deny-steer note.
 *
 * Pins the `buildDenySteerMessage(decision, isReadonly)` contract:
 *   - read-only tool denied with a `deny_and_steer` decision → returned steer
 *     ends with {@link READONLY_DENY_STEER_NOTE}.
 *   - mutating tool denied with a `deny_and_steer` decision → returned steer
 *     does NOT contain the note (byte-identical legacy).
 *   - `allow` / plain `deny` → null (the note is irrelevant — no steer to
 *     inject in the first place).
 *
 * The flag is DECLARED by the caller via `Tool.isReadOnly()` from the registry
 * lookup the gate already performs; here we drive the helper directly so the
 * test is hermetic.
 */
import { describe, expect, test } from "bun:test"
import { buildDenySteerMessage, type ConfirmDecision, READONLY_DENY_STEER_NOTE } from "@/agent"

const denyAndSteer = (steer: string): ConfirmDecision => ({
  decision: "deny_and_steer",
  steer,
})

describe("ADR-0077 — buildDenySteerMessage readonly note", () => {
  test("read-only tool denied → steer ends with the readonly note", () => {
    const out = buildDenySteerMessage(denyAndSteer("try a smaller file"), true)
    expect(out).not.toBeNull()
    expect(out).toContain(READONLY_DENY_STEER_NOTE)
    expect(out).toBe(`try a smaller file${READONLY_DENY_STEER_NOTE}`)
  })

  test("mutating tool denied → steer does NOT contain the readonly note (byte-identical)", () => {
    const out = buildDenySteerMessage(denyAndSteer("do not write that file"), false)
    expect(out).toBe("do not write that file")
    expect(out).not.toContain(READONLY_DENY_STEER_NOTE)
  })

  test("isReadonly undefined → byte-identical to mutating (legacy callers unaffected)", () => {
    const out = buildDenySteerMessage(denyAndSteer("foo"))
    expect(out).toBe("foo")
    expect(out).not.toContain(READONLY_DENY_STEER_NOTE)
  })

  test("plain deny → null (no steer regardless of readonly flag)", () => {
    expect(buildDenySteerMessage({ decision: "deny" }, true)).toBeNull()
    expect(buildDenySteerMessage({ decision: "deny" }, false)).toBeNull()
  })

  test("allow → null (no steer regardless of readonly flag)", () => {
    expect(buildDenySteerMessage({ decision: "allow" }, true)).toBeNull()
    expect(buildDenySteerMessage({ decision: "allow" }, false)).toBeNull()
  })
})

/**
 * Fake-registry integration: a callsite that looks up `tool.isReadOnly()`
 * derives the flag from a structurally minimal registry. Mirrors the wire
 * in `denyFromConfirm` (admissibility-gate) without dragging in the whole
 * dispatch surface.
 */
interface FakeTool {
  name: string
  isReadOnly(): boolean
}
const fakeRegistry = (tools: FakeTool[]) => {
  const map = new Map(tools.map((t) => [t.name, t]))
  return {
    get(name: string): FakeTool | undefined {
      return map.get(name)
    },
  }
}

describe("ADR-0077 — fake registry lookup mirrors the gate's path", () => {
  const registry = fakeRegistry([
    { name: "read", isReadOnly: () => true },
    { name: "write", isReadOnly: () => false },
  ])

  test("denying a read-only tool → readonly note appended", () => {
    const tool = registry.get("read")
    expect(tool).toBeDefined()
    const isReadonly = tool ? tool.isReadOnly() : false
    const out = buildDenySteerMessage(denyAndSteer("look elsewhere"), isReadonly)
    expect(out).toBe(`look elsewhere${READONLY_DENY_STEER_NOTE}`)
  })

  test("denying a mutating tool → note absent", () => {
    const tool = registry.get("write")
    expect(tool).toBeDefined()
    const isReadonly = tool ? tool.isReadOnly() : false
    const out = buildDenySteerMessage(denyAndSteer("do not write"), isReadonly)
    expect(out).toBe("do not write")
    expect(out).not.toContain(READONLY_DENY_STEER_NOTE)
  })

  test("unknown tool (registry miss) → mutating posture (no note)", () => {
    const tool = registry.get("ghost")
    const isReadonly = tool ? tool.isReadOnly() : false
    const out = buildDenySteerMessage(denyAndSteer("nope"), isReadonly)
    expect(out).toBe("nope")
    expect(out).not.toContain(READONLY_DENY_STEER_NOTE)
  })
})
