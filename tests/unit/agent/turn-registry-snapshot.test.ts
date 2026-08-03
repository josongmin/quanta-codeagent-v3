/**
 * RFC04-0 — turn registry snapshot pin.
 *
 * Proves the structural invariant: model-visible specs and the dispatch
 * registry are ALWAYS the same generation, a pinned snapshot survives a
 * pointer swap, and the fingerprint distinguishes an origin change at equal
 * tool names. Red-on-injection: if a snapshot let specs come from a different
 * registry than `registry`, the "specs derived from same registry" assertion
 * fails.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  __resetTurnRegistrySnapshotId,
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
  fingerprintRegistry,
  NO_MCP_PROTOCOL_VERSION,
  type TurnRegistrySnapshot,
} from "@/agent/turn-registry-snapshot"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

const fakeTool = (name: string): Tool => ({
  name,
  description: `desc:${name}`,
  inputSchema: z.object({ x: z.string() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  // biome-ignore lint/correctness/useYield: minimal stub, never executed here
  execute: async function* () {
    throw new Error("not executed in snapshot unit")
  },
})

const registryOf = (names: string[], origins?: Record<string, "builtin" | "mcp">): ToolRegistry =>
  new ToolRegistry(names.map(fakeTool), origins ? new Map(Object.entries(origins)) : undefined)

describe("RFC04-0 buildTurnRegistrySnapshot", () => {
  beforeEach(() => __resetTurnRegistrySnapshotId())

  test("specs are derived from the SAME registry the snapshot dispatches against", () => {
    const registry = registryOf(["read", "write"])
    const snap = buildTurnRegistrySnapshot(registry)
    // The snapshot's advertised specs must be EXACTLY the specs of its own
    // registry — no divergence possible. If a snapshot could carry an
    // out-of-band spec list, this deep-equal would fail.
    expect(snap.registry).toBe(registry)
    expect([...snap.specs]).toEqual(registry.specs())
    expect(snap.specs.map((s) => s.name)).toEqual(["read", "write"])
    // registry.get must resolve every advertised tool (dispatch parity).
    for (const s of snap.specs) expect(snap.registry.get(s.name)).toBeDefined()
  })

  test("generation id is monotonic and unique per snapshot", () => {
    const a = buildTurnRegistrySnapshot(registryOf(["read"]))
    const b = buildTurnRegistrySnapshot(registryOf(["read"]))
    expect(a.id).toBe(0)
    expect(b.id).toBe(1)
    expect(a.id).not.toBe(b.id)
  })

  test("protocolVersion defaults to the no-mcp sentinel and is carried when given", () => {
    const dflt = buildTurnRegistrySnapshot(registryOf(["read"]))
    expect(dflt.protocolVersion).toBe(NO_MCP_PROTOCOL_VERSION)
    const pinned = buildTurnRegistrySnapshot(registryOf(["read"]), {
      protocolVersion: "2025-06-18",
    })
    expect(pinned.protocolVersion).toBe("2025-06-18")
  })
})

describe("RFC04-0 fingerprintRegistry", () => {
  test("equal names + equal origins ⇒ equal fingerprint", () => {
    expect(fingerprintRegistry(registryOf(["a", "b"]))).toBe(
      fingerprintRegistry(registryOf(["a", "b"])),
    )
  })

  test("SAME names but DIFFERENT origin ⇒ different fingerprint (trust-visible)", () => {
    const builtin = registryOf(["run"], { run: "builtin" })
    const mcp = registryOf(["run"], { run: "mcp" })
    // A malicious server shadowing a builtin name with an mcp tool changes the
    // dispatchable/trust surface even though the advertised NAME is identical.
    expect(fingerprintRegistry(builtin)).not.toBe(fingerprintRegistry(mcp))
  })

  test("name set change ⇒ different fingerprint", () => {
    expect(fingerprintRegistry(registryOf(["a"]))).not.toBe(
      fingerprintRegistry(registryOf(["a", "b"])),
    )
  })
})

describe("RFC04-0 createTurnRegistrySnapshotRef atomic pin", () => {
  test("a pinned current() survives a publish (turn keeps its generation)", () => {
    const gen0 = buildTurnRegistrySnapshot(registryOf(["read"]))
    const { ref, publish } = createTurnRegistrySnapshotRef(gen0)
    const pinnedByTurn: TurnRegistrySnapshot = ref.current()
    expect(pinnedByTurn).toBe(gen0)

    // Mid-turn a reload publishes gen1.
    const gen1 = buildTurnRegistrySnapshot(registryOf(["read", "write"]))
    publish(gen1)

    // The turn's PINNED reference is unchanged (advertise/dispatch continuity);
    // a NEW read sees gen1 (next turn picks it up).
    expect(pinnedByTurn.id).toBe(gen0.id)
    expect(pinnedByTurn.specs.map((s) => s.name)).toEqual(["read"])
    expect(ref.current()).toBe(gen1)
    expect(ref.current().specs.map((s) => s.name)).toEqual(["read", "write"])
  })

  test("ref exposes only a read handle (no setter leak)", () => {
    const { ref } = createTurnRegistrySnapshotRef(buildTurnRegistrySnapshot(registryOf(["read"])))
    expect(Object.keys(ref)).toEqual(["current"])
  })
})
