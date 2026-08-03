/**
 * RFC04-2 + RFC04-3 — MCP tool hot-reload controller hellgate.
 *
 * Drives the REAL `createMcpToolReloadController` over a real
 * `TurnRegistrySnapshotRef` and a fake "server" whose tool list evolves. Each
 * scenario is a RED-on-injection rail: break the controller's transactional /
 * coalescing / LKG rule and exactly one assertion flips.
 *
 * Covered:
 *  - all-source relist rebuilds the snapshot + atomic next-turn publish;
 *  - burst coalescing bounds concurrent signals to one-inflight + one replay;
 *  - malformed/failed rebuild retains last-known-good (no partial/empty publish);
 *  - a no-change rebuild does NOT churn the generation;
 *  - a turn that pinned `current()` keeps its generation across a publish.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  __resetTurnRegistrySnapshotId,
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
} from "@/agent/turn-registry-snapshot"
import { createMcpToolReloadController } from "@/host/runtime/mcp-tool-reload"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

const fakeTool = (name: string): Tool => ({
  name,
  description: `d:${name}`,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  // biome-ignore lint/correctness/useYield: stub never executed
  execute: async function* () {
    throw new Error("unused")
  },
})

/** A fake MCP source whose tool NAME list can be swapped between reloads. The
 *  rebuild port relists ALL current names (full-list semantics), disambiguates
 *  is unnecessary here (single source), and builds one snapshot. */
const makeFakeSource = (initial: string[]) => {
  let names = [...initial]
  let failNext = false
  let listCalls = 0
  return {
    setNames: (n: string[]) => {
      names = [...n]
    },
    failOnce: () => {
      failNext = true
    },
    listCalls: () => listCalls,
    rebuild: async (): Promise<ReturnType<typeof buildTurnRegistrySnapshot>> => {
      listCalls += 1
      if (failNext) {
        failNext = false
        throw new Error("relist failed (malformed page)")
      }
      // All-source relist: build the FULL registry from the current names.
      const registry = new ToolRegistry(
        names.map(fakeTool),
        new Map(names.map((n) => [n, "mcp" as const])),
      )
      return buildTurnRegistrySnapshot(registry, { protocolVersion: "2025-06-18" })
    },
  }
}

const seedRef = () => {
  const gen0 = buildTurnRegistrySnapshot(new ToolRegistry([fakeTool("base")]))
  return createTurnRegistrySnapshotRef(gen0)
}

describe("RFC04-2/3 hot-reload controller", () => {
  beforeEach(() => __resetTurnRegistrySnapshotId())

  test("relist + atomic publish replaces the snapshot with the new surface", async () => {
    const { ref, publish } = seedRef()
    const src = makeFakeSource(["alpha", "beta"])
    const published: { from: number; to: number }[] = []
    const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild, {
      onPublished: (i) => published.push(i),
    })

    expect(ref.current().registry.toolNames()).toEqual(["base"])
    await ctl.requestReload()

    // The published snapshot advertises AND dispatches the new tool set.
    expect(ref.current().registry.toolNames()).toEqual(["alpha", "beta"])
    expect(ref.current().specs.map((s) => s.name)).toEqual(["alpha", "beta"])
    expect(published).toHaveLength(1)
  })

  test("a rebuild with an UNCHANGED surface does not churn the generation", async () => {
    const { ref, publish } = seedRef()
    const src = makeFakeSource(["alpha"])
    let noChange = 0
    const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild, {
      onNoChange: () => noChange++,
    })
    await ctl.requestReload() // base → alpha (publish)
    const genAfterFirst = ref.current().id
    await ctl.requestReload() // alpha → alpha (no change)
    expect(ref.current().id).toBe(genAfterFirst)
    expect(noChange).toBe(1)
  })

  test("malformed/failed rebuild RETAINS last-known-good (no partial/empty publish)", async () => {
    const { ref, publish } = seedRef()
    const src = makeFakeSource(["alpha", "beta"])
    await ctl0Publish(ref, publish, src) // establish LKG = [alpha, beta]
    const lkg = ref.current()

    const aborts: string[] = []
    const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild, {
      onAbort: (i) => aborts.push(i.error),
    })
    src.setNames(["gamma"]) // the server WOULD change...
    src.failOnce() // ...but the relist fails
    await ctl.requestReload()

    // Fail-closed: the surface is STILL the last-known-good, never emptied.
    expect(ref.current()).toBe(lkg)
    expect(ref.current().registry.toolNames()).toEqual(["alpha", "beta"])
    expect(aborts).toHaveLength(1)
  })

  test("burst coalesces to one-inflight + one replay (bounded relist)", async () => {
    const { ref, publish } = seedRef()
    const src = makeFakeSource(["alpha"])
    const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild)

    // Fire many signals synchronously (a burst). They must NOT each spawn a
    // rebuild: at most one in-flight + one dirty replay.
    const burst = [
      ctl.requestReload(),
      ctl.requestReload(),
      ctl.requestReload(),
      ctl.requestReload(),
    ]
    // While the burst is settling, change the surface so the replay observes it.
    src.setNames(["alpha", "omega"])
    await Promise.all(burst)

    // Bounded: the initial rebuild + at most ONE dirty replay ⇒ ≤ 2 relists,
    // never 4. The final surface reflects the latest names (replay ran).
    expect(src.listCalls()).toBeLessThanOrEqual(2)
    expect(ref.current().registry.toolNames()).toEqual(["alpha", "omega"])
  })

  test("a turn that pinned current() keeps its generation across a publish", async () => {
    const { ref, publish } = seedRef()
    const src = makeFakeSource(["alpha"])
    const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild)
    const pinnedByTurn = ref.current() // turn boundary pin
    await ctl.requestReload()
    // The reload published a new generation, but the pinned reference is intact
    // (current-turn dispatch continuity); a fresh read sees the new one.
    expect(pinnedByTurn.registry.toolNames()).toEqual(["base"])
    expect(ref.current().registry.toolNames()).toEqual(["alpha"])
    expect(pinnedByTurn).not.toBe(ref.current())
  })
})

/** Establish a first publish so LKG is a non-seed snapshot. */
const ctl0Publish = async (
  ref: ReturnType<typeof seedRef>["ref"],
  publish: ReturnType<typeof seedRef>["publish"],
  src: ReturnType<typeof makeFakeSource>,
): Promise<void> => {
  const ctl = createMcpToolReloadController({ current: ref.current, publish }, src.rebuild)
  await ctl.requestReload()
}
