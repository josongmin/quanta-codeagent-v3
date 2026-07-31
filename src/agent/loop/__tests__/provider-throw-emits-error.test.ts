/**
 * FIX 5 (jul-2) — a throwing mention/context provider must be OBSERVABLE.
 *
 * `resolveContextEventsForTurn` (compaction-wire) and
 * `resolveMentionInjectionMessages` (context-assembler) both used to `catch { return [] }`
 * with NO event emitted — so a throwing provider was indistinguishable from
 * "nothing to inject" and a user's @file mention / IDE context could vanish
 * silently. The in-file sibling `resolveMemoryContext` emits `{type:"error", ...}`
 * on throw; these two now match that shape.
 *
 *   §1  context-events provider throws ⇒ ONE `error` event emitted, returns [].
 *   §2  mention injector throws ⇒ ONE `error` event emitted, returns [].
 *   §3  RED-on-injection: a NON-throwing provider emits NOTHING (success path
 *       byte-identical — the emit is only added on the catch path).
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { AgentConfig } from "../../types"
import { resolveContextEventsForTurn } from "../compaction-wire"
import { resolveMentionInjectionMessages } from "../context-assembler"

type Emitted = { type: string; message?: string }

const makeConfig = (over: Partial<AgentConfig>): { config: AgentConfig; events: Emitted[] } => {
  const events: Emitted[] = []
  const config = {
    system: "sys",
    stream: { emit: (e: Emitted) => events.push(e) },
    ...over,
  } as unknown as AgentConfig
  return { config, events }
}

describe("resolveContextEventsForTurn — throwing provider is observable (FIX 5)", () => {
  test("§1 provider throws ⇒ emits ONE error event and returns []", () => {
    const { config, events } = makeConfig({
      contextEventsForTurn: () => {
        throw new Error("boom-ctx")
      },
    })
    const out = resolveContextEventsForTurn(config)
    expect(out).toEqual([])
    const errs = events.filter((e) => e.type === "error")
    expect(errs.length).toBe(1)
    expect(errs[0]?.message).toContain("boom-ctx")
  })

  test("§3 provider succeeds ⇒ NO event (success path byte-identical)", () => {
    const { config, events } = makeConfig({
      contextEventsForTurn: () => [] as never,
    })
    const out = resolveContextEventsForTurn(config)
    expect(out).toEqual([])
    expect(events.length).toBe(0)
  })

  test("no provider wired ⇒ [] and no event", () => {
    const { config, events } = makeConfig({})
    expect(resolveContextEventsForTurn(config)).toEqual([])
    expect(events.length).toBe(0)
  })
})

const wmWithUser = () =>
  createWorkingMemory<Message>([
    { role: "user", content: [{ type: "text", text: "@file.ts explain" }] },
  ])

describe("resolveMentionInjectionMessages — throwing injector is observable (FIX 5)", () => {
  test("§2 injector throws ⇒ emits ONE error event and returns []", async () => {
    const { config, events } = makeConfig({
      mentionInjector: async () => {
        throw new Error("boom-mention")
      },
    })
    const out = await resolveMentionInjectionMessages(config, wmWithUser())
    expect(out).toEqual([])
    const errs = events.filter((e) => e.type === "error")
    expect(errs.length).toBe(1)
    expect(errs[0]?.message).toContain("boom-mention")
  })

  test("§3 injector succeeds ⇒ NO event (success path byte-identical)", async () => {
    const { config, events } = makeConfig({
      mentionInjector: async () => [],
    })
    const out = await resolveMentionInjectionMessages(config, wmWithUser())
    expect(out).toEqual([])
    expect(events.length).toBe(0)
  })

  test("no injector wired ⇒ [] and no event", async () => {
    const { config, events } = makeConfig({})
    expect(await resolveMentionInjectionMessages(config, wmWithUser())).toEqual([])
    expect(events.length).toBe(0)
  })
})
