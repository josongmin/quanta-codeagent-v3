/**
 * End-to-end integration test for `session_config` through the real
 * dispatch path. Unlike `session-config.test.ts` (which calls the tool
 * factory directly), this exercise PROVES that:
 *
 *   1. `AgentConfig.sessionConfigPort` flows through `buildToolContext` →
 *      `ToolContext.sessionConfig` (the seam wire works end-to-end).
 *   2. The tool is reachable via its NAME through `ToolRegistry` +
 *      `dispatchTool` (no name typo, no registry omission).
 *   3. `set_effort` actually mutates the same EffortStore the agent loop
 *      will re-read next turn (proves the seam is by-reference, not a
 *      snapshot — would-be regression if the bootstrap wire ever swapped
 *      `effortStore.get()` for a frozen copy).
 *   4. Calling without a wired seam returns the typed `not_wired` failure
 *      (proves the default-OFF graceful degrade in the dispatch path).
 *
 * This is the "actually works" proof the unit suite alone cannot give —
 * the seam-wire change spans 4 files (tool/types.ts → tool/session_config.ts
 * → agent/dispatch.ts → host/bootstrap-session.ts), and unit tests of the
 * tool factory pass even if the dispatch wire is missing.
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

const call = (input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "session_config",
  input,
})

describe("session_config — dispatch integration", () => {
  test("get: AgentConfig.sessionConfigPort flows through to ctx.sessionConfig", async () => {
    // Use the REAL EffortStore (not a hand-rolled mock) — this is what
    // bootstrap-session builds. Proves the production path renders correctly.
    const effortStore = createEffortStore("high")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
      readPermissionMode: () => "acceptEdits",
      readIdentityMode: () => "code_agent",
      readToolProfile: () => "write",
      readModel: () => "gpt-5-mini",
      readProvider: () => "chatgpt-oauth",
    }
    const result = await dispatchTool(call({ op: "get" }), makeConfig(seam), perm)
    expect(result.ok).toBe(true)
    // `result.block` is the tool_result block the LLM will receive.
    const block = result.block
    expect(block).toBeDefined()
    expect(block?.type).toBe("tool_result")
    const content = block?.content
    if (typeof content === "string") {
      expect(content).toContain("session_config")
      expect(content).toContain("high")
      expect(content).toContain("16,384")
      expect(content).toContain("acceptEdits")
      expect(content).toContain("code_agent")
      expect(content).toContain("gpt-5-mini")
      expect(content).toContain("chatgpt-oauth")
    } else {
      // Some dispatch paths wrap output in a structured block — accept that too.
      expect(JSON.stringify(content)).toContain("high")
    }
  })

  test("set_effort: mutates the SAME EffortStore the agent loop reads", async () => {
    // The headline integration claim — if the seam ever swapped to a snapshot
    // copy of the store, this test would fail (the post-call `store.get()`
    // would still report "medium" instead of "max").
    const effortStore = createEffortStore("medium")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
    }
    expect(effortStore.get()).toBe("medium")
    const result = await dispatchTool(
      call({ op: "set_effort", level: "max" }),
      makeConfig(seam),
      perm,
    )
    expect(result.ok).toBe(true)
    // Authoritative — read directly from the store (not the tool's reply).
    expect(effortStore.get()).toBe("max")
    // And the tool reply reflects the transition for the LLM.
    const block = result.block
    const content = block?.content
    if (typeof content === "string") {
      expect(content).toContain("medium  →  max")
      expect(content).toContain("64,000")
      expect(content).toContain("applies from the next turn")
    }
  })

  test("set_effort then get on the SAME seam returns the new value", async () => {
    // Round-trip: set → get must observe the write. This catches a subtle
    // wiring bug where set_effort writes to one store and get reads from
    // another (a danger if the bootstrap ever changes from a single store
    // to per-call closures).
    const effortStore = createEffortStore("low")
    const seam: SessionConfigSeam = {
      readEffort: () => effortStore.get(),
      writeEffort: (next) => effortStore.set(next),
    }
    const cfg = makeConfig(seam)
    await dispatchTool(call({ op: "set_effort", level: "high" }, "c1"), cfg, perm)
    const got = await dispatchTool(call({ op: "get" }, "c2"), cfg, perm)
    const content = got.block?.content
    if (typeof content === "string") {
      expect(content).toContain("effort  high")
      expect(content).toContain("16,384")
    }
  })

  test("unwired seam: dispatch returns ok with typed not_wired failure in the block", async () => {
    // AgentConfig.sessionConfigPort absent ⇒ ctx.sessionConfig undefined ⇒
    // the tool yields ok:false with reason:"not_wired". Dispatch wraps that
    // into a tool_result so the LLM sees a coherent reply (does NOT throw).
    const result = await dispatchTool(call({ op: "get" }), makeConfig(undefined), perm)
    // dispatchTool returns ok:true at the dispatch level when the tool ran
    // (even if the tool itself reported ok:false) — the inner ok:false is
    // surfaced in the block content.
    const block = result.block
    const content = block?.content
    if (typeof content === "string") {
      expect(content).toContain("not wire")
    } else {
      expect(JSON.stringify(content)).toContain("not wire")
    }
  })

  test("registry resolves the tool by name (no typo regression)", () => {
    const registry = new ToolRegistry([sessionConfigTool])
    expect(registry.has("session_config")).toBe(true)
    expect(registry.isReadOnly("session_config")).toBe(false)
  })
})
