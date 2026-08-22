/**
 * RFC04-2/3 — session-bootstrap `registrySnapshotRef` read (gate-OFF byte-identity
 * + gate-ON ref-read) hellgate.
 *
 * The reload feeder publishes a new turn capability snapshot BETWEEN turns via a
 * `TurnRegistrySnapshotRef`. `createRunAgentContext` must:
 *  - GATE-OFF (no ref): build the snapshot from `cfg.registry` EXACTLY as before
 *    (byte-identical — `session.specs === cfg.registry.specs()` content, a fresh
 *    generation each context). The ref slot is unrepresentable when absent.
 *  - GATE-ON (ref present): READ `ref.current()` at the boundary instead of
 *    building one — so a snapshot the controller published is the one the turn
 *    pins (proving the feeder actually reaches the loop). RED-on-injection: if
 *    the read fell back to `buildTurnRegistrySnapshot(cfg.registry)` the pinned
 *    identity would differ from the seeded ref.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createRunAgentContext } from "@/agent/loop/session-bootstrap"
import {
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
} from "@/agent/turn-registry-snapshot"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

const inertLLM: LLMPort = {
  // biome-ignore lint/correctness/useYield: inert stub throws if streamed and never yields
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const baseCfg = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 2,
    signal: new AbortController().signal,
    ...overrides,
  }) as AgentConfig

describe("session-bootstrap registrySnapshotRef", () => {
  test("GATE-OFF (no ref): snapshot is built from cfg.registry (byte-identical specs)", async () => {
    const registry = new ToolRegistry([fakeTool("read"), fakeTool("write")])
    const ctx = await createRunAgentContext(baseCfg({ registry }))
    // The pinned snapshot's registry IS cfg.registry, and its specs are exactly
    // `registry.specs()` — the prior expression, byte-identical.
    const snapshot = ctx.session.registrySnapshot
    if (snapshot === undefined) throw new Error("expected a pinned registry snapshot")
    expect(snapshot.registry).toBe(registry)
    expect(ctx.session.specs.map((s) => s.name)).toEqual(registry.specs().map((s) => s.name))
    // No ref was consulted — the slot is absent.
    expect(ctx.cfg.registrySnapshotRef).toBeUndefined()
  })

  test("GATE-ON (ref present): the boundary READS ref.current(), not a fresh build", async () => {
    // Seed a ref, then PUBLISH a distinct 'beta' generation into it (as the
    // reload controller would between turns). The bootstrap must pin the
    // published generation — proving the read, not a rebuild from cfg.registry.
    const seedRegistry = new ToolRegistry([fakeTool("read")])
    const { ref, publish } = createTurnRegistrySnapshotRef(buildTurnRegistrySnapshot(seedRegistry))
    const nextRegistry = new ToolRegistry([fakeTool("read"), fakeTool("beta")])
    const published = buildTurnRegistrySnapshot(nextRegistry)
    publish(published)

    // cfg.registry deliberately DIFFERS from the ref's published registry, so a
    // fallback-to-build would pin the wrong (cfg.registry) surface.
    const cfgRegistry = new ToolRegistry([fakeTool("read"), fakeTool("write")])
    const ctx = await createRunAgentContext(
      baseCfg({ registry: cfgRegistry, registrySnapshotRef: ref }),
    )

    // Pinned the PUBLISHED generation (identity + id), NOT a fresh build.
    expect(ctx.session.registrySnapshot).toBe(published)
    const snapshot = ctx.session.registrySnapshot
    if (snapshot === undefined) throw new Error("expected a pinned registry snapshot")
    expect(snapshot.registry).toBe(nextRegistry)
    expect(ctx.session.specs.map((s) => s.name)).toContain("beta")
    // Proof it did NOT fall back to cfg.registry (which has 'write', not 'beta').
    expect(ctx.session.specs.map((s) => s.name)).not.toContain("write")
  })
})
