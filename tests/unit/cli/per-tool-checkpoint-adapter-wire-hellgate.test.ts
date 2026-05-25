/**
 * ★ CONTRACT — ADR-0300: T1 per-tool-checkpoint-adapter ←
 * GranularRegistryPort wire.
 *
 * 6 hellgate cases:
 *
 *   - HELL-W15: adapter built WITHOUT registry → all restoreXxx return
 *     `shadow-odb-not-configured` Err (backward-compat with the legacy
 *     T1 stub posture)
 *   - HELL-W16: restoreFiles after record → ok:true + files Map
 *   - HELL-W17: restoreTask after record → ok:true + frozen messages
 *   - HELL-W18: restoreBoth returns both files + messages
 *   - HELL-W19: restoreXxx for unknown id → Err("not-found")
 *   - HELL-W20: throwing registry → Err("registry-failure"), never throws
 *
 * Hermetic: hand-rolled in-memory registry + a mocked throwing variant.
 */

import { describe, expect, test } from "bun:test"
import type { GranularRegistryPort, ToolSnapshot } from "@/agent/checkpoint/granular-registry"
import { defaultGranularRegistry } from "@/agent/checkpoint/granular-registry"
import { createPerToolCheckpointAdapter } from "@/apps/cli/repl/ctx-adapters/per-tool-checkpoint-adapter"
import type { Message } from "@/llm"

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const makeSnap = (id: string): ToolSnapshot => ({
  toolCallId: id,
  turn: 1,
  takenAt: 0,
  filesBefore: new Map<string, string>([
    ["a.ts", "alpha"],
    ["b.ts", "beta"],
  ]),
  taskMessagesBefore: [msg("user", "do thing"), msg("assistant", "ok")],
})

describe("per-tool-checkpoint adapter — ADR-0300 registry wire", () => {
  test("HELL-W15: no registry → restoreXxx return shadow-odb-not-configured", () => {
    const a = createPerToolCheckpointAdapter()
    const f = a.restoreFiles("any-id")
    const t = a.restoreTask("any-id")
    const b = a.restoreBoth("any-id")
    expect(f.ok).toBe(false)
    expect(t.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (!f.ok) expect(f.errorCode).toBe("shadow-odb-not-configured")
    if (!t.ok) expect(t.errorCode).toBe("shadow-odb-not-configured")
    if (!b.ok) expect(b.errorCode).toBe("shadow-odb-not-configured")

    // explicit `registry: undefined` also routes through the same arm
    const a2 = createPerToolCheckpointAdapter({})
    const f2 = a2.restoreFiles("any-id")
    expect(f2.ok).toBe(false)
    if (!f2.ok) expect(f2.errorCode).toBe("shadow-odb-not-configured")
  })

  test("HELL-W16: restoreFiles after record → ok:true + files Map", () => {
    const reg = defaultGranularRegistry()
    reg.record(makeSnap("tc-w16"))
    const a = createPerToolCheckpointAdapter({ registry: reg })
    const out = a.restoreFiles("tc-w16")
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.toolCallId).toBe("tc-w16")
      expect(out.files?.get("a.ts")).toBe("alpha")
      expect(out.files?.get("b.ts")).toBe("beta")
      expect(out.messages).toBeUndefined() // files-only arm
    }
  })

  test("HELL-W17: restoreTask returns ok:true with frozen messages array", () => {
    const reg = defaultGranularRegistry()
    reg.record(makeSnap("tc-w17"))
    const a = createPerToolCheckpointAdapter({ registry: reg })
    const out = a.restoreTask("tc-w17")
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.toolCallId).toBe("tc-w17")
      expect(out.messages).toHaveLength(2)
      expect(Object.isFrozen(out.messages)).toBe(true)
      expect(out.files).toBeUndefined() // task-only arm
    }
  })

  test("HELL-W18: restoreBoth returns both files + messages", () => {
    const reg = defaultGranularRegistry()
    reg.record(makeSnap("tc-w18"))
    const a = createPerToolCheckpointAdapter({ registry: reg })
    const out = a.restoreBoth("tc-w18")
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.toolCallId).toBe("tc-w18")
      expect(out.files?.size).toBe(2)
      expect(out.messages).toHaveLength(2)
      expect(Object.isFrozen(out.messages)).toBe(true)
    }
  })

  test("HELL-W19: unknown toolCallId → Err('not-found')", () => {
    const reg = defaultGranularRegistry()
    const a = createPerToolCheckpointAdapter({ registry: reg })
    const f = a.restoreFiles("nope")
    const t = a.restoreTask("nope")
    const b = a.restoreBoth("nope")
    expect(f.ok).toBe(false)
    expect(t.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (!f.ok) expect(f.errorCode).toBe("not-found")
    if (!t.ok) expect(t.errorCode).toBe("not-found")
    if (!b.ok) expect(b.errorCode).toBe("not-found")
  })

  test("HELL-W20: throwing registry → Err('registry-failure'), never throws", () => {
    const throwingReg: GranularRegistryPort = {
      record: () => {
        throw new Error("synthetic record boom")
      },
      restore: () => {
        throw new Error("synthetic restore boom")
      },
      list: () => [],
      clear: () => {
        throw new Error("clear boom")
      },
    }
    const a = createPerToolCheckpointAdapter({ registry: throwingReg })
    // None of the three arms must throw — even when the registry does.
    expect(() => a.restoreFiles("x")).not.toThrow()
    expect(() => a.restoreTask("x")).not.toThrow()
    expect(() => a.restoreBoth("x")).not.toThrow()
    const f = a.restoreFiles("x")
    const t = a.restoreTask("x")
    const b = a.restoreBoth("x")
    expect(f.ok).toBe(false)
    expect(t.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (!f.ok) {
      expect(f.errorCode).toBe("registry-failure")
      expect(f.message).toContain("synthetic restore boom")
    }
    if (!t.ok) expect(t.errorCode).toBe("registry-failure")
    if (!b.ok) expect(b.errorCode).toBe("registry-failure")
  })
})
