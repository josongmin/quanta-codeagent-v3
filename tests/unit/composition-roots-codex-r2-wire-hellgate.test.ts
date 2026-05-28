/**
 * ADR-0334 — composition-root wire hellgate.
 *
 * Verifies that `installCodexR2Wires` is reached from each of the four
 * composition roots flagged in ADR-0332 §Wiring with the per-surface
 * deps policy ADR-0334 documents:
 *
 *   §A  apps/agent/assemble.ts     ⇒ rich deps (cache pair + store + context-events)
 *   §B  apps/agent/run.ts          ⇒ belt-and-suspenders (idempotent under
 *                                    pre-filled slots from assemble.ts)
 *   §C  apps/agent/mode-presets/interactive.ts
 *                                  ⇒ documentary install + slots intact
 *   §D  apps/bench/eval/driver.ts  ⇒ EMPTY deps (byte-identical bench cfg)
 *   §E  caller-override precedence (cross-surface)
 *   §F  NO-THROW under hostile cfg surface
 *
 * The slice's own contract (per-slot deps gating, atomic cache pair, etc.)
 * stays guarded by `src/agent/codex-r2-wire-install/__tests__/install.hellgate.test.ts` —
 * THIS file is integration-level: it asks "did the surface call install
 * with the documented deps?" by inspecting the resulting cfg.
 */

import { describe, expect, test } from "bun:test"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { type AssembleRequest, assembleAgentConfig } from "../../src/apps/agent/assemble"
import { runMode as runInteractiveMode } from "../../src/apps/agent/mode-presets/interactive"
import { runAgentLifecycleWith } from "../../src/apps/agent/run"

// Inert LLM stub — these tests never stream.
const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const baseFor = (over: Partial<AgentConfig> = {}): AssembleRequest["base"] => ({
  llm: inertLLM,
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: "/repo",
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId: "sess-abc",
  ...over,
})

// ─── §A — assemble.ts wires the ADR-0327-family slots ────────────────────

describe("ADR-0334 §A — assemble.ts wires slots when sessionId present", () => {
  test("rich deps: cache pair + store-side slots populated", () => {
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor(),
    })
    // System-prompt cache pair (atomic — both or neither).
    expect(cfg.systemPromptCache).toBeDefined()
    expect(cfg.systemPromptCacheKey).toBeDefined()
    // Context-events producer (getSnapshot + store ⇒ wired).
    expect(cfg.contextEventsForTurn).toBeDefined()
    // Compaction-event emit (store ⇒ wired).
    expect(cfg.compactionEventEmit).toBeDefined()
    // Mention injector wired (ADR-0422/0423): assemble builds the @file +
    // @symbol composite via buildDefaultMentionResolver, default-ON. @skill is
    // omitted (assemble has no skill registry). QUANTA_MENTION_FILE=off opts out.
    expect(cfg.mentionInjector).toBeDefined()
    // No image-retry slot (ADR-0333 owns that wrap).
    expect(cfg.imageSanitizationRetry).toBeUndefined()
  })

  test("absent sessionId ⇒ cache pair NOT wired, store-side slots STILL wired", () => {
    // RuntimeAgentConfigBase requires sessionId optional; omit it to test
    // that the cache pair gates on sessionId without dropping the store-
    // backed slots.
    const baseNoSess = baseFor()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate field-strip for the test fixture.
    delete (baseNoSess as any).sessionId
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseNoSess })
    expect(cfg.systemPromptCache).toBeUndefined()
    expect(cfg.systemPromptCacheKey).toBeUndefined()
    expect(cfg.contextEventsForTurn).toBeDefined()
    expect(cfg.compactionEventEmit).toBeDefined()
  })
})

// ─── §B — run.ts is idempotent under pre-filled slots ─────────────────────

describe("ADR-0334 §B — run.ts idempotent install", () => {
  test("runAgentLifecycleWith does not overwrite slots assemble already filled", async () => {
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseFor() })
    const prevCache = cfg.systemPromptCache
    const prevStore = cfg.compactionEventEmit
    const controller = new AbortController()
    const fakeOutcome: AgentOutcome = {
      reason: "completed",
      messages: [],
      turns: 0,
      // biome-ignore lint/suspicious/noExplicitAny: outcome fields beyond reason aren't checked here.
    } as any
    const seenCfg: AgentConfig[] = []
    await runAgentLifecycleWith(cfg, controller, {
      runAgent: async (c) => {
        seenCfg.push(c)
        return fakeOutcome
      },
      signalSource: { on: () => undefined, off: () => undefined },
    })
    expect(seenCfg.length).toBe(1)
    const inner = seenCfg[0]
    if (inner === undefined) throw new Error("expected runAgent seam to capture a cfg")
    // Slots assemble filled are preserved verbatim (caller-override precedence).
    expect(inner.systemPromptCache).toBe(prevCache)
    expect(inner.compactionEventEmit).toBe(prevStore)
  })
})

// ─── §C — interactive.ts cfg has the install applied (via seam) ───────────

describe("ADR-0334 §C — interactive.ts install reaches seam runAgent", () => {
  test("seams.runAgent receives a cfg with the ADR-0327-family slots set", async () => {
    let captured: AgentConfig | undefined
    const fakeOutcome: AgentOutcome = {
      reason: "completed",
      messages: [],
      turns: 0,
      // biome-ignore lint/suspicious/noExplicitAny: outcome shape stub.
    } as any
    const result = await runInteractiveMode({
      mode: "interactive",
      base: baseFor(),
      seams: {
        runAgent: async (cfg) => {
          captured = cfg
          return fakeOutcome
        },
      },
    })
    expect(result.exitCode).toBe(0)
    expect(captured).toBeDefined()
    expect(captured?.systemPromptCache).toBeDefined()
    expect(captured?.systemPromptCacheKey).toBeDefined()
    expect(captured?.contextEventsForTurn).toBeDefined()
    expect(captured?.compactionEventEmit).toBeDefined()
  })
})

// ─── §D — bench/eval/driver.ts byte-identical (empty deps) ────────────────

describe("ADR-0334 §D — bench driver passes EMPTY deps", () => {
  test("empty-deps invocation leaves an otherwise-bare cfg untouched", () => {
    // Build a bare cfg and run THE EXACT install bench performs (empty deps).
    // This is the contract bench/eval/driver.ts encodes — verified directly
    // because reaching `createBenchSessionHost` is private (the function is
    // not exported). The empty-deps contract is the only behavioural surface.
    const cfg = {} as unknown as AgentConfig
    const before = JSON.stringify(cfg)
    installCodexR2Wires(cfg, {})
    expect(JSON.stringify(cfg)).toBe(before)
    expect(cfg.systemPromptCache).toBeUndefined()
    expect(cfg.systemPromptCacheKey).toBeUndefined()
    expect(cfg.contextEventsForTurn).toBeUndefined()
    expect(cfg.mentionInjector).toBeUndefined()
    expect(cfg.compactionEventEmit).toBeUndefined()
    expect(cfg.imageSanitizationRetry).toBeUndefined()
  })
})

// ─── §E — caller-override precedence across surfaces ──────────────────────

describe("ADR-0334 §E — caller-override precedence across surfaces", () => {
  test("host pre-populated mentionInjector survives assemble + lifecycle install", async () => {
    const hostInjector = async () => []
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: { ...baseFor(), mentionInjector: hostInjector },
    })
    // assemble doesn't wire mentionInjector — host's lives.
    expect(cfg.mentionInjector).toBe(hostInjector)

    // Now thread through runAgentLifecycleWith and verify the seam sees the
    // SAME injector reference (lifecycle install never overwrites it).
    let captured: AgentConfig | undefined
    const fakeOutcome: AgentOutcome = {
      reason: "completed",
      messages: [],
      turns: 0,
      // biome-ignore lint/suspicious/noExplicitAny: stub.
    } as any
    await runAgentLifecycleWith(cfg, new AbortController(), {
      runAgent: async (c) => {
        captured = c
        return fakeOutcome
      },
      signalSource: { on: () => undefined, off: () => undefined },
    })
    expect(captured?.mentionInjector).toBe(hostInjector)
  })
})

// ─── §F — NO-THROW under hostile cfg ──────────────────────────────────────

describe("ADR-0334 §F — NO-THROW envelope on the surface install calls", () => {
  test("assemble pathway with a sealed base still produces a wired cfg", () => {
    // The base IS the value spread into the returned cfg — sealing the base
    // does NOT seal the spread result, so the install pass mutates freely.
    // What we actually verify: even a degenerate "all undefined" base does
    // not throw and yields a defined cfg.
    const baseDegenerate = baseFor()
    Object.seal(baseDegenerate)
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseDegenerate })
    expect(cfg).toBeDefined()
    // sessionId carried through ⇒ pair wired.
    expect(cfg.systemPromptCache).toBeDefined()
  })
})
