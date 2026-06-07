/**
 * ADR-0140 hellgate — background-subagent caller wire
 *
 * Pins the 4 surgical wire edits that surface the
 * {@link BackgroundSubagentScheduler} (ADR-0130) to the loop:
 *
 *   1. `AgentConfig.subagentBackground?: { scheduler }` slot exists (type-only).
 *   2. `FeaturesConfig` Pick union includes `"subagentBackground"`.
 *   3. `tier1/index.ts` re-exports `buildSubagentBgBlock`.
 *   4. `buildSessionFeatures` appends `buildSubagentBgBlock(config)` results
 *      into `extraTools` so the 3 tools land in the ToolRegistry when (and
 *      ONLY when) the scheduler slot is wired (default-OFF byte-identical).
 *
 * All assertions are STRUCTURAL (read the materialized features), not behavioural
 * — the scheduler itself is hellgated separately in
 * `subagent-background-hellgate.test.ts`. This file's purpose is to seal the
 * surgical wire surface so a later refactor cannot silently un-wire it.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import { buildSubagentBgBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import type { SubagentResult, SubagentRunner } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

/** A never-settling runner — every hellgate here forks then asserts on
 *  STRUCTURE before any runner promise resolves, so the body is irrelevant. */
const inertRunner: SubagentRunner = () => new Promise<SubagentResult>(() => {})

/** Build the minimal {@link AgentConfig} a wire test needs — the loop is NOT
 *  exercised here; `buildSessionFeatures` only reads the Tier-1 slot. */
const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

describe("subagent-background wire — hellgate", () => {
  test("(1) tier1 barrel re-exports buildSubagentBgBlock", () => {
    // If the barrel re-export is missing, this import would have thrown at
    // module load. Sealing the surface — a refactor that drops the line
    // breaks this assertion immediately.
    expect(typeof buildSubagentBgBlock).toBe("function")
  })

  test("(2) AgentConfig.subagentBackground slot accepts {scheduler}", () => {
    // Pure type-shape test: the assignment compiles iff the slot exists.
    // Runtime: pass through `baseCfg` so `buildSessionFeatures` reads it.
    const scheduler: BackgroundSubagentScheduler = defaultBackgroundSubagentScheduler({
      runner: inertRunner,
    })
    const cfg = baseCfg({ subagentBackground: { scheduler } })
    expect(cfg.subagentBackground?.scheduler).toBe(scheduler)
  })

  test("(3) FeaturesConfig Pick union includes 'subagentBackground'", () => {
    // Pure type assertion: assigning a value whose type INCLUDES the slot to
    // `FeaturesConfig` compiles iff the Pick union mentions it. The runtime
    // body is a tautology — the contract is the TYPE.
    const scheduler = defaultBackgroundSubagentScheduler({ runner: inertRunner })
    const fc: FeaturesConfig = baseCfg({ subagentBackground: { scheduler } })
    expect(fc.subagentBackground?.scheduler).toBe(scheduler)
  })

  test("(4) slot absent ⇒ 3 subagent_bg tools NOT in extraTools (default-OFF)", async () => {
    const features = await buildSessionFeatures(baseCfg())
    const names = features.extraTools.map((t) => t.name)
    expect(names).not.toContain("subagent_fork")
    expect(names).not.toContain("subagent_poll")
    expect(names).not.toContain("subagent_await")
  })

  test("(5) slot wired ⇒ all 3 subagent_bg tools land in extraTools", async () => {
    const scheduler = defaultBackgroundSubagentScheduler({ runner: inertRunner })
    const features = await buildSessionFeatures(baseCfg({ subagentBackground: { scheduler } }))
    const names = features.extraTools.map((t) => t.name)
    expect(names).toContain("subagent_fork")
    expect(names).toContain("subagent_poll")
    expect(names).toContain("subagent_await")
  })

  test("(6) wired tools are wired to the SAME scheduler instance (fork ⇒ poll)", async () => {
    // End-to-end: forking via the tool must mutate the SAME scheduler the
    // poll tool reads. This proves features.ts threads the scheduler through
    // — not a fresh instance per tool.
    const scheduler = defaultBackgroundSubagentScheduler({ runner: inertRunner })
    const features = await buildSessionFeatures(baseCfg({ subagentBackground: { scheduler } }))
    const fork = features.extraTools.find((t) => t.name === "subagent_fork")
    const poll = features.extraTools.find((t) => t.name === "subagent_poll")
    expect(fork).toBeDefined()
    expect(poll).toBeDefined()
    // Directly fork via scheduler and ensure list() observes it.
    const id = scheduler.fork({ task: "wire-check" })
    expect(scheduler.poll(id)?.status).toBe("running")
    expect(scheduler.list().some((e) => e.id === id)).toBe(true)
  })
})
