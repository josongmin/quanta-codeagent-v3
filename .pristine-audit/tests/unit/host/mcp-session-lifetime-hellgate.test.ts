/**
 * MCP client session-lifetime hellgate (jun-10 follow-up).
 *
 * The runtime host used to stop the session's MCP clients in `runRuntimeTurn`'s
 * finally — a one-shot relic that, under the per-turn `runAgent` architecture,
 * (a) killed the fleet at the END OF TURN 1 so every later turn's MCP tools hit
 * a stopped client, and (b) put a serial, potentially unbounded shutdown wait
 * on the turn-completion critical path (the "input blocked long after done"
 * symptom class).
 *
 * Pins:
 *   [M1] clients survive MULTIPLE turns untouched (red against the old
 *        per-turn finally: it stopped them after turn 1).
 *   [M2] session close stops every client exactly once, BEFORE the
 *        options.shutdown hook (bootstrap shutdown closes the egress proxy the
 *        clients' children ride — stop-then-proxy ordering must hold).
 *   [M3] double close stays idempotent (no second stop).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done" } satisfies StreamEvent
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {
    // discard
  }
}

const harness = async (root: string, order: string[], baseExtras: object = {}) => {
  const client = {
    stops: 0,
    stop: async (): Promise<void> => {
      client.stops += 1
      order.push("client.stop")
    },
  }
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm: new ScriptedLLM(),
      registry: new ToolRegistry(defaultTools),
      stream: new NullStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [],
      system: "test",
      cwd: root,
      maxTurns: 4,
      signal: new AbortController().signal,
      ...baseExtras,
    },
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const runtime = await runtimeContext.createRuntimeFacade({
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => {
      order.push("options.shutdown")
    },
    mcpClients: [client],
  })
  const session = await runtime.createSession({ cwd: root, permissionMode: "acceptEdits" })
  return { client, runtime, session }
}

describe("MCP clients are session-scoped, not per-turn", () => {
  test("[M1+M2] clients survive two full turns; close stops once, BEFORE options.shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-session-lifetime-"))
    const order: string[] = []
    const { client, runtime, session } = await harness(root, order)
    try {
      await session.input.append("turn one")
      await session.turn.run()
      // OLD behavior stopped the fleet right here (end of turn 1) — the
      // red-on-regression anchor for this whole file.
      expect(client.stops).toBe(0)

      await session.input.append("turn two")
      await session.turn.run()
      expect(client.stops).toBe(0)

      await session.close()
      expect(client.stops).toBe(1)
      // Stop-then-shutdown ordering: the bootstrap shutdown hook (which closes
      // the egress proxy the clients' children ride) runs AFTER the fleet stop.
      expect(order).toEqual(["client.stop", "options.shutdown"])
    } finally {
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[T1] teardown ordering: memory drain is AWAITED before sqlite dispose, fleet stop before shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-session-teardown-order-"))
    const order: string[] = []
    // An ASYNC drain that yields twice before recording — if close() fires
    // dispose without awaiting drain (the in-flight-distill-on-closed-handle
    // bug this ordering exists for), "dispose" lands first and the assert reds.
    const { runtime, session } = await harness(root, order, {
      memoryAutoDrain: async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push("memory.drain")
      },
      memoryAutoDispose: () => {
        order.push("memory.dispose")
      },
      dreamOnSessionEnd: async () => {
        order.push("dream")
      },
    })
    try {
      await session.input.append("one turn")
      await session.turn.run()
      await session.close()
      expect(order).toEqual([
        "memory.drain",
        "memory.dispose",
        "dream",
        "client.stop",
        "options.shutdown",
      ])
    } finally {
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[F1] two sessions from ONE facade: first close leaves the shared fleet alive; LAST close tears down once", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-session-fleet-share-"))
    const order: string[] = []
    const { client, runtime, session } = await harness(root, order)
    try {
      const sibling = await runtime.createSession({ cwd: root, permissionMode: "acceptEdits" })
      await session.input.append("session A turn")
      await session.turn.run()
      await session.close()
      // Session B still rides the shared fleet — A's close must NOT stop it.
      expect(client.stops).toBe(0)
      expect(order).toEqual([])

      await sibling.input.append("session B turn")
      await sibling.turn.run()
      await sibling.close()
      // Last close owns the shared teardown, exactly once.
      expect(client.stops).toBe(1)
      expect(order).toEqual(["client.stop", "options.shutdown"])
    } finally {
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[M3] double close is idempotent — exactly one stop, one shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-session-lifetime-idem-"))
    const order: string[] = []
    const { client, runtime, session } = await harness(root, order)
    try {
      await session.input.append("only turn")
      await session.turn.run()
      await session.close()
      await runtime.close()
      expect(client.stops).toBe(1)
      expect(order).toEqual(["client.stop", "options.shutdown"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
