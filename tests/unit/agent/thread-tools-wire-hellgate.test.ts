/**
 * ADR-0206 wire hellgate — `AgentConfig.threadToolRegistry` slot composition.
 *
 * The slot is helper-only (caller-side composition); these 3 invariants pin
 * the wire pattern the composition root is expected to follow when it
 * threads per-thread MCP tools through the global registry:
 *
 *   HELL-TTW-01  default-OFF byte-identical — when the slot is undefined on
 *                an AgentConfig-shaped object, `composeTools(global, [])`
 *                returns `global` (no allocation, frozen reference equal).
 *   HELL-TTW-02  wired slot + 1 per-thread tool: composeTools returns a
 *                FROZEN superset whose `find(name)` resolves the per-thread
 *                tool when its name does not collide with a global.
 *   HELL-TTW-03  wired slot + COLLIDING name: per-thread tool wins (Codex
 *                MCP override semantic); the original global is REPLACED
 *                in place, not appended.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  composeTools,
  type DynamicToolSpec,
  inMemoryThreadToolStore,
  type ThreadToolRegistry,
} from "@/agent/thread-tools"
import type { AgentConfig } from "@/agent/types"
import type { Tool, ToolEvent } from "@/tool"

// ----------------------------------------------------------------------------
// harness
// ----------------------------------------------------------------------------

const mkTool = (name: string, marker?: string): Tool => {
  const m = marker ?? name
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: `${m}-ran` } }
    },
  } as Tool
}

const mkSpec = (name: string, marker?: string): DynamicToolSpec => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
  deferLoading: false,
  factory: () => mkTool(name, marker),
})

// Drive a Tool to its first result event (the marker proves WHICH variant ran).
const firstResult = async (tool: Tool): Promise<string> => {
  for await (const ev of tool.execute({} as never, {
    cwd: process.cwd(),
    signal: new AbortController().signal,
  })) {
    if (ev.type === "result" && ev.result.ok) return ev.result.output ?? ""
  }
  throw new Error("no result event")
}

// Caller-side composition the wire spec documents. Helper-only — extracted
// so the test asserts the pattern verbatim.
const composeWithThreadRegistry = (
  global: readonly Tool[],
  reg: ThreadToolRegistry | undefined,
  threadId: string,
): readonly Tool[] => {
  if (reg === undefined) return composeTools(global, [])
  const perThread: Tool[] = []
  for (const spec of reg.list(threadId)) {
    const r = reg.resolve(threadId, spec.name)
    if (r.ok) perThread.push(r.value)
  }
  return composeTools(global, perThread)
}

// ----------------------------------------------------------------------------
// HELL-TTW-01 default-OFF byte-identical
// ----------------------------------------------------------------------------

describe("HELL-TTW-01 default-OFF byte-identical", () => {
  test("undefined slot ⇒ composeTools returns the global array verbatim", () => {
    const global = Object.freeze([mkTool("g_one"), mkTool("g_two")])
    const cfg: { threadToolRegistry?: AgentConfig["threadToolRegistry"] } = {}
    const merged = composeWithThreadRegistry(global, cfg.threadToolRegistry, "T1")
    // Frozen-equal reference: composeTools short-circuits on empty perThread.
    expect(merged).toBe(global)
    expect(merged.length).toBe(2)
  })
})

// ----------------------------------------------------------------------------
// HELL-TTW-02 wire + per-thread tool resolves on dispatch
// ----------------------------------------------------------------------------

describe("HELL-TTW-02 per-thread tool resolves through composer", () => {
  test("per-thread spec is appended; find(name) returns the per-thread tool", async () => {
    const global = [mkTool("g_one")]
    const registry = inMemoryThreadToolStore()
    const reg = registry.register("T1", mkSpec("t_per_thread", "per-thread-A"))
    expect(reg.ok).toBe(true)
    const cfg: Pick<AgentConfig, "threadToolRegistry"> = { threadToolRegistry: registry }
    const merged = composeWithThreadRegistry(global, cfg.threadToolRegistry, "T1")
    expect(merged.length).toBe(2)
    expect(Object.isFrozen(merged)).toBe(true)
    const found = merged.find((t) => t.name === "t_per_thread")
    expect(found).toBeDefined()
    if (!found) throw new Error()
    expect(await firstResult(found)).toBe("per-thread-A-ran")
  })

  test("unrelated threadId sees only globals (cross-thread isolation)", () => {
    const global = [mkTool("g_one")]
    const registry = inMemoryThreadToolStore()
    registry.register("T_other", mkSpec("only_for_other"))
    const merged = composeWithThreadRegistry(global, registry, "T_main")
    expect(merged.length).toBe(1)
    expect(merged[0]?.name).toBe("g_one")
  })
})

// ----------------------------------------------------------------------------
// HELL-TTW-03 collision: per-thread wins
// ----------------------------------------------------------------------------

describe("HELL-TTW-03 collision per-thread overrides global in place", () => {
  test("per-thread tool with same name REPLACES global; merged length unchanged", async () => {
    const global = [mkTool("collide", "GLOBAL"), mkTool("untouched", "G")]
    const registry = inMemoryThreadToolStore()
    registry.register("T1", mkSpec("collide", "THREAD"))
    const merged = composeWithThreadRegistry(global, registry, "T1")
    expect(merged.length).toBe(2)
    const found = merged.find((t) => t.name === "collide")
    if (!found) throw new Error("collide tool missing")
    expect(await firstResult(found)).toBe("THREAD-ran")
  })
})
