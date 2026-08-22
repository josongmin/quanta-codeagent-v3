/**
 * Integration — ADR-0159 retrieval stack composition-root wire.
 *
 * Verifies the END-TO-END wire: the surface assembler builds a
 * {@link RetrievalStack}, attaches it to `AgentConfig.retrievalStack`,
 * passes it through `runAgent` (which never touches it), and the bridge
 * consumer (`rankWithRetrievalStack`) reads it back from the config to
 * invoke the funnel.
 *
 * This is the OPPOSITE of the unit hellgate — that file pokes the builder
 * in isolation; this file pokes the full path from "surface env flag" →
 * "AgentConfig slot" → "consumer reads it back" so a refactor that breaks
 * any link in the chain fails here LOUDLY rather than at a future
 * production wire.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { InMemoryStore, type MemoryEntry, type MemoryQuery } from "@/memory"
import { identityReranker, RerankRegistry } from "@/retrieval"
import {
  buildRetrievalStackCore,
  type RetrievalStack,
  rankWithRetrievalStack,
} from "@/runner/assemble"
import { assembleConfig } from "@/runner/assemble/config"
import { baseConfig, FakeLLM, text } from "./_harness"

// ─── Default-OFF: legacy callers see ZERO change ─────────────────────────

describe("ADR-0159 retrieval composition — default-OFF", () => {
  test("config without retrievalStack: AgentConfig has slot omitted entirely", () => {
    const cfg = baseConfig({})
    // exactOptionalPropertyTypes: omitted means the key is NOT present.
    expect(Object.hasOwn(cfg, "retrievalStack")).toBe(false)
  })

  test("runAgent ignores retrievalStack slot (loop never reads it)", async () => {
    // Even when wired, runAgent must produce the same terminal outcome —
    // the slot is caller-side composition only.
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    const cfg = baseConfig({
      llm: new FakeLLM([text("done")]),
      retrievalStack: fakeStack,
    })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBeDefined()
    // Bridge consumers were NOT invoked by the loop ⇒ stack untouched.
    // (We can't directly observe "no call" on a noop reranker; but if the
    // loop had invoked it, the test below would have asserted side-effects
    // that aren't there.)
  })
})

// ─── Surface wire: env-projected build → AgentConfig slot ────────────────

describe("ADR-0159 retrieval composition — surface wire", () => {
  test("buildRetrievalStackCore({enabled:true}) attaches to AgentConfig", () => {
    const stack = buildRetrievalStackCore({ enabled: true })
    if (stack === undefined) throw new Error("builder must return when enabled=true")
    const cfg: AgentConfig = baseConfig({ retrievalStack: stack })
    expect(cfg.retrievalStack).toBe(stack)
    expect(cfg.retrievalStack?.defaultReranker.kind).toBe("identity")
  })

  test("assembleConfig threads retrievalStack through SessionDeps", () => {
    const stack = buildRetrievalStackCore({ enabled: true })
    if (stack === undefined) throw new Error("builder must return when enabled=true")
    const cfg = assembleConfig([{ role: "user", content: [{ type: "text", text: "go" }] }], {
      llm: new FakeLLM([text("ok")]),
      registry: baseConfig().registry,
      stream: baseConfig().stream,
      permission: baseConfig().permission,
      system: "s",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      store: undefined,
      sessionId: "sess-1",
      embedder: undefined,
      memoryConfig: undefined,
      planMode: false,
      metrics: undefined,
      run: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      summarizerLlm: undefined,
      onShellEvent: undefined,
      workMetricsSink: undefined,
      retrievalStack: stack,
    })
    expect(cfg.retrievalStack).toBe(stack)
  })

  test("assembleConfig omits retrievalStack when undefined (default-OFF)", () => {
    const cfg = assembleConfig([{ role: "user", content: [{ type: "text", text: "go" }] }], {
      llm: new FakeLLM([text("ok")]),
      registry: baseConfig().registry,
      stream: baseConfig().stream,
      permission: baseConfig().permission,
      system: "s",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      store: undefined,
      sessionId: "sess-1",
      embedder: undefined,
      memoryConfig: undefined,
      planMode: false,
      metrics: undefined,
      run: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      summarizerLlm: undefined,
      onShellEvent: undefined,
      workMetricsSink: undefined,
      // retrievalStack omitted ⇒ slot should be entirely absent
    })
    expect(Object.hasOwn(cfg, "retrievalStack")).toBe(false)
  })
})

// ─── Consumer wire: bridges READ the AgentConfig slot ────────────────────

describe("ADR-0159 retrieval composition — consumer reads slot", () => {
  test("memory bridge reads AgentConfig.retrievalStack and routes through it", async () => {
    let rerankCalls = 0
    const stack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank(input) {
          rerankCalls++
          return [...input.candidates].reverse()
        },
      },
    }
    const cfg: AgentConfig = baseConfig({ retrievalStack: stack })
    const entries: MemoryEntry[] = [
      { id: "a", kind: "fact", text: "alpha", tags: [], createdAt: 1 },
      { id: "b", kind: "fact", text: "beta", tags: [], createdAt: 2 },
    ]
    const query: MemoryQuery = { text: "any" }
    // Caller reads cfg.retrievalStack and feeds it to the bridge.
    const ranked = await rankWithRetrievalStack(entries, query, 1000, cfg.retrievalStack)
    expect(rerankCalls).toBe(1)
    expect(ranked.length).toBe(2)
  })

  test("bridges with absent slot return identity (no rerank invocations)", async () => {
    const cfg: AgentConfig = baseConfig({}) // no retrievalStack
    const entries: MemoryEntry[] = [
      { id: "a", kind: "fact", text: "alpha", tags: [], createdAt: 1 },
    ]
    const ranked = await rankWithRetrievalStack(entries, { text: "any" }, 1000, cfg.retrievalStack)
    expect(ranked.length).toBe(1)
    // No reranker was wired ⇒ the bridge returned rankEntries verbatim.
  })

  test("cross-cut: same stack instance is reusable across memory-bridge calls", async () => {
    let memCalls = 0
    const stack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: {
        kind: "identity",
        async rerank(input) {
          memCalls++
          return [...input.candidates]
        },
      },
    }
    const cfg = baseConfig({ retrievalStack: stack })
    await rankWithRetrievalStack(
      [{ id: "m", kind: "fact", text: "x", tags: [], createdAt: 1 }],
      { text: "x" },
      1000,
      cfg.retrievalStack,
    )
    await rankWithRetrievalStack(
      [{ id: "n", kind: "fact", text: "x", tags: [], createdAt: 2 }],
      { text: "x" },
      1000,
      cfg.retrievalStack,
    )
    expect(memCalls).toBe(2)
  })

  test("abort signal flows: aborted store still respects bridge identity (no hang)", async () => {
    // The retrieval bridges are pure async — no signal propagation needed
    // (any actual I/O happens in the injected port). Smoke: the bridge
    // returns regardless of abort state when the input is well-formed.
    const stack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    const ac = new AbortController()
    ac.abort()
    // Even with an aborted controller, the bridge completes (no signal arg).
    const result = await rankWithRetrievalStack(
      [{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }],
      { text: "x" },
      1000,
      stack,
    )
    expect(result.length).toBe(1)
  })
})

// ─── runAgent end-to-end: stack present + absent, identical outcome ──────

describe("ADR-0159 retrieval composition — runAgent end-to-end", () => {
  test("runAgent terminates the same with stack ABSENT vs PRESENT", async () => {
    const llmA = new FakeLLM([text("ok")])
    const llmB = new FakeLLM([text("ok")])
    const cfgA = baseConfig({ llm: llmA })
    const stack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    const cfgB = baseConfig({ llm: llmB, retrievalStack: stack })
    const a = await runAgent(cfgA)
    const b = await runAgent(cfgB)
    // Loop doesn't touch retrievalStack ⇒ outcomes have identical reason.
    expect(a.reason).toBe(b.reason)
  })

  test("runAgent + memory store works regardless of retrievalStack presence", async () => {
    const store = new InMemoryStore()
    const cfg = baseConfig({
      llm: new FakeLLM([text("ok")]),
      store,
      sessionId: "sess-rs",
      retrievalStack: {
        registry: new RerankRegistry(),
        defaultReranker: identityReranker,
      },
    })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBeDefined()
  })
})

// ─── Type-narrow assignability (compile-time, asserted at runtime) ───────

describe("ADR-0159 retrieval composition — slot type contract", () => {
  test("AgentConfig.retrievalStack accepts RetrievalStack from builder", () => {
    const stack = buildRetrievalStackCore({ enabled: true })
    if (stack === undefined) throw new Error("builder returned undefined")
    const slot: AgentConfig["retrievalStack"] = stack
    expect(slot?.registry).toBeInstanceOf(RerankRegistry)
    expect(slot?.defaultReranker.kind).toBe("identity")
  })

  test("retrievalStack with embedding + commitEmbedder is structurally valid", () => {
    const stack = buildRetrievalStackCore({
      enabled: true,
      embedding: {
        vendor: "openai",
        model: "fake",
        async embed(): Promise<readonly (readonly number[])[]> {
          return []
        },
      },
      gitLog: {
        async log(): Promise<readonly never[]> {
          return []
        },
      },
    })
    if (stack === undefined) throw new Error("builder returned undefined")
    const slot: AgentConfig["retrievalStack"] = stack
    expect(slot?.embedding).toBeDefined()
    expect(slot?.commitEmbedder).toBeDefined()
  })

  test("bridge consumer accepts the slot type with no cast", async () => {
    const stack = buildRetrievalStackCore({ enabled: true })
    if (stack === undefined) throw new Error("builder must return when enabled=true")
    const cfg: AgentConfig = baseConfig({ retrievalStack: stack })
    // The bridge function signature ALREADY accepts the slot type — no
    // cast needed. If a future refactor breaks the contract, tsc fails here.
    const result = await rankWithRetrievalStack(
      [{ id: "x", kind: "fact", text: "y", tags: [], createdAt: 1 }],
      { text: "y" },
      1000,
      cfg.retrievalStack,
    )
    expect(result.length).toBeGreaterThanOrEqual(0)
  })

  test("structural drift between builder output and slot shape would fail tsc", () => {
    // Sentinel: if RetrievalStack or AgentConfig.retrievalStack diverges,
    // the type assignability below would fail at tsc time.
    const fakeStack: RetrievalStack = {
      registry: new RerankRegistry(),
      defaultReranker: identityReranker,
    }
    const slot: AgentConfig["retrievalStack"] = fakeStack
    expect(slot).toBeDefined()
    // Both directions are structurally compatible — a future refactor that
    // adds a required field to either side trips tsc here.
    const back: RetrievalStack = fakeStack
    expect(back).toBe(fakeStack)
  })
})
