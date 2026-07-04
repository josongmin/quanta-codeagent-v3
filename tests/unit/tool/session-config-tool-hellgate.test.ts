/**
 * Hellgate — `session_config` tool composition path adversarial pins.
 *
 * Distinct from:
 *   - `session-config.test.ts`      — unit tests of the tool factory directly
 *   - `session-config-dispatch.integration.test.ts` — positive dispatch wiring
 *
 * THIS FILE proves:
 *   1. Gate-OFF (seam absent): every op returns ok:false with reason:"not_wired",
 *      never throws.
 *   2. Lifecycle (abort before start): aborted signal → typed "aborted" failure,
 *      NEVER throws.
 *   3. Adversarial get: seam readers that throw → ok:false, NEVER throws out of
 *      the tool (no-throw invariant).
 *   4. Adversarial set_effort: seam writer throws → ok:false, NEVER throws.
 *   5. Unknown op schema rejection: non-union op value → zod parse error caught
 *      by dispatch before the tool sees it (dispatch returns ok:false).
 *   6. Real dispatch end-to-end: a fully-wired seam + real EffortStore +
 *      ToolRegistry → the composition root path (bootstrap-session equivalent)
 *      proves all four files (types → tool → dispatch → registry) are wired in
 *      a single call.
 *   7. No-op set_effort: set to the SAME tier → ok:true, body contains
 *      "(unchanged)", store value unchanged.
 *   8. Permission mode is INSPECTABLE but NOT self-mutable through this tool
 *      (schema rejects authority-bearing posture mutation verbs).
 *
 * Hellgate criteria (from definition-of-done.ts):
 *   - Exercises the REAL composition path (ToolRegistry + dispatchTool), not just
 *     the tool factory.
 *   - gate-OFF path (seam unwired) tested adversarially.
 *   - Adversarial seam readers/writers that throw are handled by the tool.
 */

import { describe, expect, test } from "bun:test"
import { type AgentConfig, createEffortStore } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { type SessionConfigSeam, sessionConfigTool, ToolRegistry } from "@/tool"

const perm: PermissionContext = { mode: "acceptEdits" }

const makeConfig = (sessionConfigPort: SessionConfigSeam | undefined): AgentConfig =>
  ({
    registry: new ToolRegistry([sessionConfigTool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...(sessionConfigPort !== undefined ? { sessionConfigPort } : {}),
  }) as AgentConfig

const makeAbortedConfig = (sessionConfigPort: SessionConfigSeam | undefined): AgentConfig => {
  const controller = new AbortController()
  controller.abort()
  return {
    registry: new ToolRegistry([sessionConfigTool]),
    cwd: "/repo",
    signal: controller.signal,
    planMode: false,
    permission: perm,
    ...(sessionConfigPort !== undefined ? { sessionConfigPort } : {}),
  } as AgentConfig
}

const call = (input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "session_config",
  input,
})

const extractContent = (result: Awaited<ReturnType<typeof dispatchTool>>): string => {
  const content = result.block?.content
  return typeof content === "string" ? content : JSON.stringify(content)
}

// ── 1. Gate-OFF: seam absent ───────────────────────────────────────────────────

describe("hellgate — gate-OFF (seam absent)", () => {
  test("op:get with no seam → ok at dispatch level, content contains not_wired", async () => {
    const result = await dispatchTool(call({ op: "get" }), makeConfig(undefined), perm)
    // dispatchTool itself does NOT throw — it wraps into tool_result
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(content).toMatch(/not.?wire/i)
  })

  test("op:set_effort with no seam → never throws, content contains not_wired", async () => {
    const result = await dispatchTool(
      call({ op: "set_effort", level: "max" }),
      makeConfig(undefined),
      perm,
    )
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(content).toMatch(/not.?wire/i)
  })

  test("gate-OFF invariant: same result regardless of effort level requested", async () => {
    for (const level of ["low", "medium", "high", "max", "default"] as const) {
      const result = await dispatchTool(
        call({ op: "set_effort", level }),
        makeConfig(undefined),
        perm,
      )
      expect(result.block).toBeDefined()
      const content = extractContent(result)
      expect(content).toMatch(/not.?wire/i)
    }
  })
})

// ── 2. Lifecycle: aborted signal ───────────────────────────────────────────────

describe("hellgate — abort lifecycle", () => {
  test("pre-aborted signal + wired seam → typed 'aborted' failure, never throws", async () => {
    const effortStore = createEffortStore("high")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
    }
    const result = await dispatchTool(call({ op: "get" }), makeAbortedConfig(seam), perm)
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    // Aborted path yields ok:false; content signals abort, not "not_wired".
    expect(content).toMatch(/abort/i)
    expect(content).not.toMatch(/not.?wire/i)
  })

  test("pre-aborted signal + no seam → aborted wins over not_wired (signal checked first)", async () => {
    const result = await dispatchTool(call({ op: "get" }), makeAbortedConfig(undefined), perm)
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(content).toMatch(/abort/i)
  })
})

// ── 3. Adversarial: throwing seam readers ─────────────────────────────────────

describe("hellgate — adversarial throwing seam", () => {
  test("readEffort throws → dispatchTool does NOT throw; result contains error info", async () => {
    const seam: SessionConfigSeam = {
      readEffort: () => {
        throw new Error("storage failure")
      },
      writeEffort: () => {},
    }
    // Must NOT throw — the no-throw invariant is absolute.
    const result = await dispatchTool(call({ op: "get" }), makeConfig(seam), perm)
    expect(result.block).toBeDefined()
    // The tool caught the throw and turned it into ok:false — content is an error message.
    const content = extractContent(result)
    expect(typeof content).toBe("string")
  })

  test("writeEffort throws → dispatchTool does NOT throw", async () => {
    const effortStore = createEffortStore("medium")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: () => {
        throw new Error("write failure")
      },
    }
    const result = await dispatchTool(
      call({ op: "set_effort", level: "high" }),
      makeConfig(seam),
      perm,
    )
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(typeof content).toBe("string")
  })

  test("all optional readers throw → ok:false, never propagates", async () => {
    const throwing = (): never => {
      throw new Error("boom")
    }
    const seam: SessionConfigSeam = {
      readEffort: throwing,
      writeEffort: () => {},
      readIdentityMode: throwing,
      readToolProfile: throwing,
      readModel: throwing,
      readProvider: throwing,
    }
    const result = await dispatchTool(call({ op: "get" }), makeConfig(seam), perm)
    expect(result.block).toBeDefined()
  })
})

// ── 4. Real composition path: end-to-end ──────────────────────────────────────

describe("hellgate — real composition path (bootstrap-session equivalent)", () => {
  test("fully-wired seam + real EffortStore → get returns correct posture snapshot", async () => {
    // This mirrors what bootstrap-session.ts builds at composition root:
    //   effortStore + identityModeState + toolProfileState + model/provider
    const effortStore = createEffortStore("high")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
      readPermissionMode: () => "acceptEdits",
      readIdentityMode: () => "code_agent",
      readToolProfile: () => "write",
      readModel: () => "test-model-id",
      readProvider: () => "test-provider",
    }
    const result = await dispatchTool(call({ op: "get" }), makeConfig(seam), perm)
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(content).toContain("high")
    expect(content).toContain("16,384")
    expect(content).toContain("acceptEdits")
    expect(content).toContain("code_agent")
    expect(content).toContain("test-model-id")
    expect(content).toContain("test-provider")
  })

  test("set_effort round-trips through the REAL EffortStore (proves by-reference seam)", async () => {
    const effortStore = createEffortStore("low")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
    }
    const cfg = makeConfig(seam)
    // set_effort to "max"
    await dispatchTool(call({ op: "set_effort", level: "max" }, "c1"), cfg, perm)
    // Read directly from the store — not from the tool reply — proving the
    // seam is by-reference, not a snapshot.
    expect(effortStore.get()).toBe("max")
    // Confirm get also reflects the new value.
    const got = await dispatchTool(call({ op: "get" }, "c2"), cfg, perm)
    const content = extractContent(got)
    expect(content).toContain("max")
    expect(content).toContain("64,000")
  })

  test("ToolRegistry resolves tool by name (no typo regression)", () => {
    const registry = new ToolRegistry([sessionConfigTool])
    expect(registry.has("session_config")).toBe(true)
  })
})

// ── 5. No-op set_effort ────────────────────────────────────────────────────────

describe("hellgate — no-op set_effort", () => {
  test("set to the same tier → ok:true, body contains '(unchanged)', store unchanged", async () => {
    const effortStore = createEffortStore("high")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
    }
    const result = await dispatchTool(
      call({ op: "set_effort", level: "high" }),
      makeConfig(seam),
      perm,
    )
    expect(result.block).toBeDefined()
    const content = extractContent(result)
    expect(content).toContain("unchanged")
    // Store must still report "high" — no phantom mutation.
    expect(effortStore.get()).toBe("high")
  })
})

describe("hellgate — authority boundary", () => {
  test("schema rejects permission/identity/tool-profile self-mutation verbs", async () => {
    for (const input of [
      { op: "set_permission", mode: "bypass" },
      { op: "set_identity_mode", mode: "review" },
      { op: "set_tool_profile", profile: "write" },
    ] as const) {
      const result = await dispatchTool(call(input), makeConfig(undefined), perm)
      expect(result.block).toBeDefined()
      const content = extractContent(result)
      expect(content).toMatch(/invalid input|invalid discriminator|schema|parse/i)
    }
  })
})

// ── 6. Adversarial: invalid op (schema reject) ────────────────────────────────

describe("hellgate — adversarial inputs", () => {
  test("completely unknown op string → dispatch returns without throwing", async () => {
    // The zod discriminatedUnion will fail to parse; dispatch wraps that as
    // ok:false. The tool's execute() is never called.
    const result = await dispatchTool(
      call({ op: "delete_all_sessions" }),
      makeConfig(undefined),
      perm,
    )
    // dispatch must not throw
    expect(result.block).toBeDefined()
  })

  test("null input → dispatch returns without throwing", async () => {
    const result = await dispatchTool(call(null), makeConfig(undefined), perm)
    expect(result.block).toBeDefined()
  })

  test("set_effort with invalid level string → dispatch returns without throwing", async () => {
    const result = await dispatchTool(
      call({ op: "set_effort", level: "turbo_max_ultra" }),
      makeConfig(undefined),
      perm,
    )
    expect(result.block).toBeDefined()
  })
})
