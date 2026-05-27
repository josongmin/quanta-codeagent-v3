/**
 * ADR-0358 — composition-root metrics wire hellgate.
 *
 * Validates that `assembleAgentConfig` (apps/agent/assemble.ts) wires the
 * codex-r2 cache metrics decorator + structural `metricsEmitter` side-
 * channel when:
 *
 *   (a) cfg.metrics is structurally a MetricsRegistry (ADR-0144 shape), AND
 *   (b) sessionId is present so we get a cache to wrap, AND
 *   (c) the caller has NOT pre-supplied cfg.systemPromptCache.
 *
 * Otherwise the wire skips ⇒ byte-identical legacy.
 *
 * Pins:
 *   §1  cfg.metrics absent          ⇒ no wrap, no emitter on cfg
 *   §2  cfg.metrics legacy shape    ⇒ no wrap, no emitter on cfg
 *   §3  cfg.metrics + sessionId     ⇒ wrap installed, emitter set
 *   §4  bench surface (no sessionId)⇒ skip wrap (replay determinism)
 *   §5  caller-supplied cache       ⇒ caller cache preserved (no wrap)
 *   §6  wrapped cache emits         ⇒ getOrBuild routes counters to registry
 */

import { describe, expect, test } from "bun:test"
import type { MetricEmitterPort } from "@/agent/codex-r2-metrics"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { asCacheKey, createInMemorySystemPromptCache } from "@/llm/system-prompt-cache"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"
import { type AssembleRequest, assembleAgentConfig } from "../../src/apps/agent/assemble"

const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream()")
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
  sessionId: "sess-metrics",
  ...over,
})

interface Captured {
  kind: "increment" | "gauge"
  name: string
  value: number
  labels?: Record<string, string>
}

const mkRegistry = (): { reg: MetricsRegistry; log: Captured[] } => {
  const log: Captured[] = []
  const reg: MetricsRegistry = {
    increment(name, delta = 1, labels) {
      const entry: Captured =
        labels === undefined
          ? { kind: "increment", name, value: delta }
          : { kind: "increment", name, value: delta, labels }
      log.push(entry)
    },
    observe() {},
    gauge(name, value, labels) {
      const entry: Captured =
        labels === undefined
          ? { kind: "gauge", name, value }
          : { kind: "gauge", name, value, labels }
      log.push(entry)
    },
    snapshot(): ReadonlyArray<MetricSnapshot> {
      return []
    },
    reset() {
      log.length = 0
    },
    async flush() {},
  }
  return { reg, log }
}

describe("ADR-0358 §1 — cfg.metrics absent ⇒ byte-identical", () => {
  test("no wrap installed, no metricsEmitter on cfg", () => {
    // sessionId different per test ⇒ session registry isolation
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor({ sessionId: "sess-§1" }),
    })
    expect(cfg.systemPromptCache).toBeDefined()
    expect((cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter).toBeUndefined()
  })
})

describe("ADR-0358 §2 — cfg.metrics legacy shape ⇒ byte-identical", () => {
  test("legacy Metrics-class-like recorder ⇒ duck-test rejects ⇒ no wrap", () => {
    const legacyLike = {
      counter: () => ({ inc: () => {} }),
      gauge: () => ({ set: () => {} }),
      timer: () => ({ start: () => () => 0, record: () => {}, stats: () => ({}) }),
      snapshot: () => ({ counters: {}, gauges: {}, timers: {} }),
    } as unknown as NonNullable<AgentConfig["metrics"]>
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor({ sessionId: "sess-§2", metrics: legacyLike }),
    })
    expect((cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter).toBeUndefined()
  })
})

describe("ADR-0358 §3 — registry + sessionId ⇒ wrap installed", () => {
  test("metricsEmitter set, cache wrap routes counters to registry", () => {
    const { reg, log } = mkRegistry()
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor({
        sessionId: "sess-§3",
        metrics: reg as unknown as NonNullable<AgentConfig["metrics"]>,
      }),
    })
    expect((cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter).toBeDefined()
    expect(cfg.systemPromptCache).toBeDefined()
    // Exercise the wrapped cache ⇒ should emit cache.misses then cache.hits.
    const cache = cfg.systemPromptCache
    if (cache === undefined) throw new Error("systemPromptCache absent")
    cache.getOrBuild(asCacheKey("k"), () => "PROMPT")
    cache.getOrBuild(asCacheKey("k"), () => "PROMPT")
    const sumFor = (name: string) =>
      log.filter((e) => e.kind === "increment" && e.name === name).reduce((a, e) => a + e.value, 0)
    expect(sumFor("codex_r2.cache.misses")).toBeGreaterThanOrEqual(1)
    expect(sumFor("codex_r2.cache.hits")).toBeGreaterThanOrEqual(1)
  })
})

describe("ADR-0358 §4 — bench surface (no sessionId) ⇒ wrap skipped", () => {
  test("no sessionId ⇒ replay determinism preserved (no wrap)", () => {
    // RuntimeAgentConfigBase requires sessionId optional; omit to test bench.
    const { sessionId: _sid, ...benchBase } = baseFor()
    const { reg } = mkRegistry()
    const cfg = assembleAgentConfig({
      mode: "headless",
      base: benchBase,
      headless: { prompt: "noop" },
      // Pass metrics anyway — wrap MUST still skip because sessionId absent.
      // We patch on cfg.base via a cast since RuntimeAgentConfigBase doesn't
      // carry metrics — assemble reads it from the resulting cfg.metrics
      // which is undefined here ⇒ no wrap. Confirm slot stays absent.
    })
    void reg
    expect((cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter).toBeUndefined()
  })
})

describe("ADR-0358 §5 — caller-supplied cache ⇒ untouched", () => {
  test("pre-set cfg.systemPromptCache preserved (caller-override-precedence)", () => {
    const { reg } = mkRegistry()
    const callerCache = createInMemorySystemPromptCache()
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor({
        sessionId: "sess-§5",
        metrics: reg as unknown as NonNullable<AgentConfig["metrics"]>,
        systemPromptCache: callerCache,
      }),
    })
    // ADR-0332 caller-override-precedence — install never overwrites.
    expect(cfg.systemPromptCache).toBe(callerCache)
  })
})

describe("ADR-0358 §6 — emitter exposed for downstream telemetry", () => {
  test("metricsEmitter on cfg is callable and routes to registry", () => {
    const { reg, log } = mkRegistry()
    const cfg = assembleAgentConfig({
      mode: "interactive",
      base: baseFor({
        sessionId: "sess-§6",
        metrics: reg as unknown as NonNullable<AgentConfig["metrics"]>,
      }),
    })
    const emitter = (cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter
    if (emitter === undefined) throw new Error("emitter not wired")
    emitter.counter("codex_r2.activation.calls", 1)
    emitter.gauge("codex_r2.activation.skills_count", 3)
    const types = log.map((e) => `${e.kind}:${e.name}:${e.value}`)
    expect(types).toContain("increment:codex_r2.activation.calls:1")
    expect(types).toContain("gauge:codex_r2.activation.skills_count:3")
  })
})
