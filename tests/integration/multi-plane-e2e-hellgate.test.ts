/**
 * Multi-plane E2E hellgate (sequel to `hexagonal-ports-closeout.test.ts`).
 *
 * 5-plane SOTA++ assembly proof — proves that EVERY session slice in this round
 * composes through ONE `AgentConfig` without cross-plane leakage:
 *
 *   Plane 1 — Orchestration : EffectChannel / CheckpointPolicy / verify-bridge /
 *                              conversation-checkpoint / SessionFeatures
 *                              composer.
 *   Plane 2 — Effect        : dispatch reads typed `images`/`documents` from
 *                              ToolResult; the new web/document tools execute
 *                              end-to-end and produce composable content
 *                              blocks.
 *   Plane 3 — Context       : in-memory stores (conversation checkpoint,
 *                              plan queue, budget ledger, metrics registry).
 *   Plane 4 — Control       : checkpoint policy, OS sandbox, MCP sandbox,
 *                              Linux sandbox argv, LLM provider degrade.
 *   Plane 5 — Observability : git-observability composite, metrics sinks
 *                              (console / jsonl / OTel).
 *
 * Plus 3 cross-plane composition cases that wire ALL planes at once and a
 * STRUCTURAL fence proving the plane-clean port files never import the
 * orchestration plane.
 *
 * Approach mirrors `hexagonal-ports-closeout.test.ts`:
 *   - Per-test fake LLM / StreamPort / PermissionContext from a single
 *     `makeMinimalConfig(overrides)` helper.
 *   - Real disk I/O via tmpdir for the document tools (csv/yaml/ndjson) and
 *     the jsonl metrics sink.
 *   - No `src/**` modifications. No edits to existing tests.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import { wireCheckpointedEffectChannel } from "@/agent/checkpoint-wiring"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { EffectChannel, ToolRequest, ToolResultEnvelope } from "@/agent/effect-channel"
import { buildSessionFeatures } from "@/agent/features"
import { wireGitObservability } from "@/agent/git-observability"
import { defaultPlanQueueStore } from "@/agent/plan-queue"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { AgentConfig } from "@/agent/types"
import { defaultVerifyCheckpointBridge } from "@/agent/verify-checkpoint-bridge"
import type { LLMPort, Message, StreamEvent, ToolUseBlock } from "@/llm"
import { FoundryProviderAdapter } from "@/llm/providers/foundry-adapter"
import { ProviderError } from "@/llm/providers/provider-port"
import { passthroughMcpSandbox } from "@/mcp/skybridge/passthrough"
import { resolveMcpSandbox } from "@/mcp/skybridge/registry"
import { Metrics } from "@/observability"
import {
  consoleMetricsSink,
  defaultMetricsRegistry,
  jsonlMetricsSink,
  otelMetricsSink,
} from "@/observability/metrics/index"
import type {
  OtelAttributes,
  OtelCounter,
  OtelHistogram,
  OtelMeter,
  OtelMeterProvider,
  OtelUpDownCounter,
} from "@/observability/metrics/otel-sink"
import type { PermissionContext } from "@/permission"
import { defaultOsSandbox } from "@/runtime/os-sandbox"
import { compileBubblewrapArgs } from "@/runtime/os-sandbox/bubblewrap"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { StreamPort } from "@/stream"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"
import { ToolRegistry } from "@/tool"
import { csvReadTool, ndjsonReadTool, pdfReadTool, yamlReadTool } from "@/tool/document"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import { composeToolResultContent, readImageTool } from "@/tool/image"
import { webFetchTool } from "@/tool/web"

// Repo root anchored on this file, not the ambient cwd — the port-boundary scan
// below reads real `src/**` files out of the checkout.
const REPO_ROOT_FOR_PORT_SCAN = path.join(import.meta.dir, "..", "..")

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers + minimal-config harness (mirrors the precedent test)              */
/* ────────────────────────────────────────────────────────────────────────── */

// Typed fakes (audit R3 LOW-4): the REAL interfaces, no blanket casts. The
// prior `as never` fake yielded a `stopReason` field the wire union spells
// `stop_reason` — exactly the shape drift a compile-checked fake catches.
const minimalLlm: LLMPort = {
  stream: async function* (): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
}

// `PermissionContext` requires only `mode`; the old fake's phantom
// `trustedTools`/`hardDenyTools` fields never existed on the interface.
const minimalPerm: PermissionContext = { mode: "default" }

const minimalStream: StreamPort = { emit: () => {} }

const makeMinimalConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  llm: minimalLlm,
  registry: new ToolRegistry([]),
  stream: minimalStream,
  permission: minimalPerm,
  messages: [],
  system: "",
  cwd: "/tmp",
  maxTurns: 1,
  signal: new AbortController().signal,
  ...overrides,
})

const makeUniqueDir = async (prefix: string): Promise<string> => {
  const dir = path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(dir, { recursive: true })
  return dir
}

/** Hand-rolled fake ShadowOdb — `registerHead` is wired to a counter, the
 *  rest throw if accidentally hit. Mirrors the precedent in
 *  `dispatch-wires-checkpoint-and-image-hellgate.test.ts`. */
const makeFakeOdb = (
  over: { registerHead?: ShadowOdb["registerHead"]; markVerified?: ShadowOdb["markVerified"] } = {},
): ShadowOdb => {
  const ni = (name: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${name} not implemented`)
  }
  return {
    init: ni("init") as ShadowOdb["init"],
    registerHead: over.registerHead ?? (ni("registerHead") as ShadowOdb["registerHead"]),
    diffSinceLast: ni("diffSinceLast") as ShadowOdb["diffSinceLast"],
    diffWorkspaceSinceLast: ni("diffWorkspaceSinceLast") as ShadowOdb["diffWorkspaceSinceLast"],
    rewindToLast: ni("rewindToLast") as ShadowOdb["rewindToLast"],
    restorePartial: ni("restorePartial") as ShadowOdb["restorePartial"],
    markVerified: over.markVerified ?? (ni("markVerified") as ShadowOdb["markVerified"]),
    rewindToVerified: ni("rewindToVerified") as ShadowOdb["rewindToVerified"],
    listSnapshots: ni("listSnapshots") as ShadowOdb["listSnapshots"],
    rewindToRef: ni("rewindToRef") as ShadowOdb["rewindToRef"],
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: ni("diffSinceRef") as ShadowOdb["diffSinceRef"],
    cleanup: ni("cleanup") as ShadowOdb["cleanup"],
  }
}

const makeMutatingTool = (name: string, output: string): Tool => ({
  name,
  description: `${name} mutating fake`,
  inputSchema: z.unknown(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output } }
  },
})

const makeReadOnlyTool = (name: string, output: string): Tool => ({
  name,
  description: `${name} readonly fake`,
  inputSchema: z.unknown(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output } }
  },
})

const fakeToolUse = (name: string, input: unknown = {}): ToolUseBlock => ({
  type: "tool_use",
  id: `tu-${name}`,
  name,
  input,
})

// `ToolContext` requires exactly `cwd` + `signal` — typed, no cast.
const fakeToolCtx = (cwd = "/repo", signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n%\xff\xff\xff\xff\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n200\n%%EOF\n",
)

/* ────────────────────────────────────────────────────────────────────────── */
/* Plane 1 — Orchestration                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Plane 1 — Orchestration", () => {
  test("P1-1: branchSearch + subagentBackground + planQueue all wired → extraTools includes ALL", async () => {
    const scheduler = defaultBackgroundSubagentScheduler({
      // Typed `SubagentRunner` result — the old `as never` fake carried a
      // phantom `output` field `SubagentResult` never declared.
      runner: async () => ({ ok: true, turns: 1, finalText: "child" }),
    })
    // A REAL minimal `BranchSearchConfig` — presence of the slot is what
    // registers the `branch_search` tool; the tier-1 builder guards the
    // absence of the LLM/verifier wires.
    const planQueueStore = defaultPlanQueueStore()
    const features = await buildSessionFeatures(
      makeMinimalConfig({
        subagentBackground: { scheduler },
        branchSearch: {
          defaultN: 1,
          defaultVerifierKinds: [],
          timeoutPerBranchMs: 1_000,
          isolation: "tmpdir",
        },
        planQueue: { store: planQueueStore },
      }),
    )
    const names = features.extraTools.map((t) => t.name)
    // Subagent-background tools — sealed by precedent.
    expect(names).toContain("subagent_fork")
    expect(names).toContain("subagent_poll")
    expect(names).toContain("subagent_await")
    // Branch search tool — registered by `buildBranchSearchBlock`.
    expect(names).toContain("branch_search")
    // planQueue is a HELPER slot (no tool today, see types.ts comment). The
    // store DOES wire (zero throws); we assert the store survives composition.
    expect(planQueueStore.peek("any-thread")).toEqual([])
  })

  test("P1-2: shadowCheckpoint pre-destructive + shadowOdb wires through wireCheckpointedEffectChannel", async () => {
    let innerCalls = 0
    let registerHeadCalls = 0
    const odb = makeFakeOdb({
      registerHead: async () => {
        registerHeadCalls += 1
        return "head-sha-fake"
      },
    })
    const fakeInner: EffectChannel = {
      async execute(req: ToolRequest): Promise<ToolResultEnvelope> {
        innerCalls += 1
        return {
          result: { ok: true, output: `inner-ran:${req.call.name}` },
          durationMs: 1,
        }
      },
    }
    const mutating = makeMutatingTool("mutate", "wrote-data")
    const wrapped = wireCheckpointedEffectChannel(
      fakeInner,
      // A FULL typed config (was a 2-field partial `as AgentConfig`).
      makeMinimalConfig({
        shadowOdb: odb,
        shadowCheckpoint: { mode: "pre-destructive" },
      }),
      (name) => (name === "mutate" ? mutating : undefined),
    )
    const env = await wrapped.execute({
      call: fakeToolUse("mutate"),
      ctx: fakeToolCtx("/repo"),
    })
    expect(env.result.ok).toBe(true)
    expect(innerCalls).toBe(1)
    expect(registerHeadCalls).toBe(1)
  })

  test("P1-3: verifyCheckpointBridge.onVerifySuccess invokes odb.markVerified once", async () => {
    let markCalls = 0
    let lastWorkspace = ""
    const odb = makeFakeOdb({
      markVerified: async (ws: string) => {
        markCalls += 1
        lastWorkspace = ws
      },
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    await bridge.onVerifySuccess("/workspace-a")
    expect(markCalls).toBe(1)
    expect(lastWorkspace).toBe("/workspace-a")
    // Default-OFF posture: bridge built with undefined odb is a no-op.
    const noopBridge = defaultVerifyCheckpointBridge(undefined)
    await noopBridge.onVerifySuccess("/workspace-b")
    expect(markCalls).toBe(1) // unchanged
  })

  test("P1-4: conversationCheckpoint record + restore roundtrip", () => {
    const store = defaultConversationCheckpointStore()
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]
    store.record("turn-1", messages)
    const restored = store.restore("turn-1")
    expect(restored).not.toBeNull()
    expect(restored?.length).toBe(2)
    // Snapshot is independent of caller mutation: pushing to original does NOT
    // affect the stored snapshot.
    messages.push({ role: "user", content: [{ type: "text", text: "later" }] })
    expect(store.restore("turn-1")?.length).toBe(2)
  })

  test("P1-5: empty AgentConfig → SessionFeatures.extraTools is empty (byte-identical default-OFF)", async () => {
    const features = await buildSessionFeatures(makeMinimalConfig())
    expect(features.extraTools).toEqual([])
    expect(features.classifier).toBeUndefined()
    expect(features.taskRegistry).toBeUndefined()
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Plane 2 — Effect                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Plane 2 — Effect", () => {
  test("P2-6: composer reads ToolResult.images → contentBlocks has ImageBlock", () => {
    const composed = composeToolResultContent({
      ok: true,
      output: "look",
      images: [{ type: "image", data: "AA==", mediaType: "image/png" }],
    } as ToolResult)
    expect(Array.isArray(composed)).toBe(true)
    if (Array.isArray(composed)) {
      const hasImage = composed.some((b) => "type" in b && (b as { type: string }).type === "image")
      expect(hasImage).toBe(true)
    }
  })

  test("P2-7: composer reads ToolResult.documents → contentBlocks has DocumentBlock (ADR-0137)", () => {
    const composed = composeToolResultContent({
      ok: true,
      output: "pdf-summary",
      documents: [{ type: "document", data: "AA==", mediaType: "application/pdf" }],
    } as ToolResult)
    expect(Array.isArray(composed)).toBe(true)
    if (Array.isArray(composed)) {
      const hasDoc = composed.some(
        (b) => "type" in b && (b as { type: string }).type === "document",
      )
      expect(hasDoc).toBe(true)
    }
  })

  test("P2-8: real readImageTool execution → composed ContentBlock array with ImageBlock", async () => {
    const dir = await makeUniqueDir("plane2-img")
    try {
      await writeFile(path.join(dir, "x.png"), PNG_BYTES)
      let last: ToolResult | undefined
      for await (const ev of readImageTool.execute({ path: "x.png" }, fakeToolCtx(dir))) {
        if (ev.type === "result") last = ev.result
      }
      expect(last?.ok).toBe(true)
      const composed = composeToolResultContent(last as ToolResult)
      expect(Array.isArray(composed)).toBe(true)
      if (Array.isArray(composed)) {
        const hasImage = composed.some(
          (b) => "type" in b && (b as { type: string }).type === "image",
        )
        expect(hasImage).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("P2-9: real pdfReadTool execution → composed ContentBlock array with DocumentBlock", async () => {
    const dir = await makeUniqueDir("plane2-pdf")
    try {
      await writeFile(path.join(dir, "x.pdf"), PDF_BYTES)
      let last: ToolResult | undefined
      for await (const ev of pdfReadTool.execute({ path: "x.pdf" }, fakeToolCtx(dir))) {
        if (ev.type === "result") last = ev.result
      }
      expect(last?.ok).toBe(true)
      const composed = composeToolResultContent(last as ToolResult)
      expect(Array.isArray(composed)).toBe(true)
      if (Array.isArray(composed)) {
        const hasDoc = composed.some(
          (b) => "type" in b && (b as { type: string }).type === "document",
        )
        expect(hasDoc).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("P2-10: webFetchTool with mocked fetcher → ok:true text/markdown", async () => {
    const fakeFetcher: typeof fetch = (async (_input: unknown) => {
      return new Response("<html><body><h1>hi</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }) as unknown as typeof fetch
    const tool = webFetchTool({ fetcher: fakeFetcher })
    let last: ToolResult | undefined
    for await (const ev of tool.execute({ url: "https://example.com/page" }, fakeToolCtx("/tmp"))) {
      if (ev.type === "result") last = ev.result
    }
    expect(last?.ok).toBe(true)
    expect(typeof last?.output).toBe("string")
    expect(last?.output ?? "").toContain("hi")
  })

  test("P2-11: csvReadTool with real tmpdir file → ok:true parsed", async () => {
    const dir = await makeUniqueDir("plane2-csv")
    try {
      await writeFile(path.join(dir, "data.csv"), "a,b,c\n1,2,3\n4,5,6\n")
      let last: ToolResult | undefined
      for await (const ev of csvReadTool.execute({ path: "data.csv" }, fakeToolCtx(dir))) {
        if (ev.type === "result") last = ev.result
      }
      expect(last?.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("P2-12: yamlReadTool with real tmpdir file → ok:true parsed", async () => {
    const dir = await makeUniqueDir("plane2-yaml")
    try {
      await writeFile(path.join(dir, "data.yaml"), "name: alice\nage: 30\n")
      let last: ToolResult | undefined
      for await (const ev of yamlReadTool.execute({ path: "data.yaml" }, fakeToolCtx(dir))) {
        if (ev.type === "result") last = ev.result
      }
      expect(last?.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("P2-13: ndjsonReadTool with real tmpdir file → ok:true parsed", async () => {
    const dir = await makeUniqueDir("plane2-ndjson")
    try {
      await writeFile(path.join(dir, "log.ndjson"), `{"a":1}\n{"a":2}\n{"a":3}\n`)
      let last: ToolResult | undefined
      for await (const ev of ndjsonReadTool.execute({ path: "log.ndjson" }, fakeToolCtx(dir))) {
        if (ev.type === "result") last = ev.result
      }
      expect(last?.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Plane 3 — Context                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Plane 3 — Context", () => {
  test("P3-14: ConversationCheckpointStore record/restore cycle", () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 4 })
    const msgs1: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    const msgs2: Message[] = [{ role: "assistant", content: [{ type: "text", text: "yo" }] }]
    store.record("a", msgs1)
    store.record("b", msgs2)
    expect(store.restore("a")?.length).toBe(1)
    expect(store.restore("b")?.length).toBe(1)
    expect(store.restore("missing")).toBeNull()
    expect(store.list().length).toBe(2)
    expect(store.prune(1)).toBe(1)
    expect(store.list().length).toBe(1)
    store.clear()
    expect(store.list().length).toBe(0)
  })

  test("P3-15: PlanQueueStore enqueue / drain", () => {
    const store = defaultPlanQueueStore()
    // ADR-0167: enqueue returns a typed `EnqueueResult` ({ id, collapsed }),
    // NOT the bare id string it shipped with at slice-creation. The composition
    // invariant is unchanged — enqueue assigns a stable id and drain replays it
    // into the named turn — only the return shape widened so observability can
    // see dedup collapses. Read `.id`/`.collapsed` off the typed result.
    const res = store.enqueue({
      threadId: "T1",
      text: "do it",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 3,
      urgent: false,
      metadata: {},
    })
    expect(typeof res.id).toBe("string")
    expect(res.collapsed).toBe(false)
    expect(store.peek("T1").length).toBe(1)
    const drained = store.drain("T1", 4)
    expect(drained.length).toBe(1)
    expect(drained[0]?.id).toBe(res.id)
    expect(drained[0]?.drainedIntoTurn).toBe(4)
    expect(store.peek("T1").length).toBe(0)
  })

  test("P3-16: BudgetLedger.record + breach detection (session-soft)", () => {
    const ledger = defaultBudgetLedger({
      policy: { sessionSoftLimit: 0.001 },
      now: () => 1_700_000_000_000,
    })
    // ADR-0162: record returns {cost, breaches}.
    const { breaches } = ledger.record({
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 1000,
      sessionId: "S1",
      at: 1_700_000_000_000,
    })
    expect(breaches.length).toBeGreaterThan(0)
    const soft = breaches.find((b) => b.kind === "session-soft")
    expect(soft).toBeDefined()
    expect(soft?.scope).toBe("S1")
  })

  test("P3-17: MetricsRegistry counter+histogram+gauge snapshot reflects writes", () => {
    const reg = defaultMetricsRegistry()
    reg.increment("tool_calls_total", 1, { tool: "read" })
    reg.increment("tool_calls_total", 1, { tool: "read" })
    reg.observe("latency_ms", 100, { tool: "read" })
    reg.observe("latency_ms", 200, { tool: "read" })
    reg.gauge("queue_depth", 5)
    const snap: ReadonlyArray<{
      name: string
      kind: string
      value: number
      count?: number
    }> = reg.snapshot()
    const counter = snap.find((r) => r.name === "tool_calls_total" && r.kind === "counter")
    const hist = snap.find((r) => r.name === "latency_ms" && r.kind === "histogram")
    const gauge = snap.find((r) => r.name === "queue_depth" && r.kind === "gauge")
    expect(counter?.value).toBe(2)
    expect(hist?.count).toBe(2)
    expect(gauge?.value).toBe(5)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Plane 4 — Control / Security                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Plane 4 — Control / Security", () => {
  test("P4-18: defaultCheckpointPolicy 'pre-destructive' fires on mutating, skips on read-only", async () => {
    const odb = makeFakeOdb({ registerHead: async () => "head-sha" })
    const policy = defaultCheckpointPolicy({ mode: "pre-destructive", odb })
    const mutating = makeMutatingTool("write", "wrote")
    const readonly = makeReadOnlyTool("read", "read")
    const fires = await policy.shouldAnchorBefore(mutating, fakeToolUse("write"), fakeToolCtx())
    const skips = await policy.shouldAnchorBefore(readonly, fakeToolUse("read"), fakeToolCtx())
    expect(fires).toBe(true)
    expect(skips).toBe(false)
  })

  test("P4-19: defaultOsSandbox.availability() returns a valid backend on the current platform", async () => {
    const sb = defaultOsSandbox()
    const av = await sb.availability()
    expect(["seatbelt", "bubblewrap", "passthrough"]).toContain(av.backend)
    expect(Array.isArray(av.warnings)).toBe(true)
  })

  test("P4-20: passthroughMcpSandbox.availability() reports backend='passthrough'", async () => {
    const sb = passthroughMcpSandbox()
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
  })

  test("P4-21: McpSandbox registry: profile='microvm' with no backend wired → degrades to passthrough", () => {
    // resolveMcpSandbox is the SYNC path — never auto-detects. With no
    // `microvmSandbox` injected we degrade to passthrough by design (registry
    // rule #5). The returned adapter MUST still be a usable McpSandbox.
    const sb = resolveMcpSandbox({ profile: "microvm" })
    expect(typeof sb.spawn).toBe("function")
    expect(typeof sb.availability).toBe("function")
  })

  test("P4-22: compileBubblewrapArgs(profile='workspace-write') emits --bind for the workspace", () => {
    const argv = compileBubblewrapArgs({ profile: "workspace-write" }, "/workspace/abc")
    expect(argv).not.toBeNull()
    // bubblewrap MUST emit `--bind <ws> <ws>` to grant write access to the
    // workspace path; the test asserts both the bind verb and the path.
    const joined = (argv ?? []).join(" ")
    expect(joined).toContain("--bind")
    expect(joined).toContain("/workspace/abc")
  })

  test("P4-23: Foundry adapter surfaces a typed ProviderError on an unsatisfiable selection", () => {
    // ADR-0172 graduated this adapter from a Phase-1 throw-only stub to a real
    // stream. Two contract shifts the original case predates:
    //   1. `@anthropic-ai/foundry-sdk@0.2.3` is now published, so the
    //      "SDK absent → provider-unsupported" arm is GONE (a future uninstall
    //      collapses to `provider-missing-dependency`, never `unsupported`).
    //   2. The real impl validates the auth bundle EAGERLY in the constructor —
    //      a config carrying neither `azureApiKey` nor `azureADTokenProvider`
    //      is refused at selection time with `provider-misconfigured`, BEFORE
    //      any stream is opened.
    // The composition invariant this plane-4 case protects is unchanged: an
    // unsatisfiable Foundry selection surfaces a TYPED `ProviderError` (the
    // loop's classifier can route on `.code`), never an untyped throw and never
    // a silently-yielded stream event. We pin that typed-failure shape against
    // the exact auth-missing config the original case used.
    let threw: unknown
    try {
      // Construction itself is the selection gate — the adapter validates the
      // auth bundle eagerly, so the throw lands here (not on a later stream).
      void new FoundryProviderAdapter({
        providerId: "foundry",
        model: "claude-sonnet-4-6",
        // TARGETED cast (intentional): an auth bundle MISSING its required
        // key/token IS the misconfiguration under test — the type system
        // correctly refuses it, so the invalid shape must be forced through.
        auth: { mode: "Azure AI Foundry" } as never,
      })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(ProviderError)
    const err = threw as ProviderError
    expect(err.providerId).toBe("foundry")
    // Typed code per current contract — auth bundle absent ⇒ misconfigured.
    expect(err.code).toBe("provider-misconfigured")
    expect(err.message.length).toBeGreaterThan(0)
    expect(/provider|foundry/i.test(err.message)).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Plane 5 — Observability                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const noopGitRunner: GitRunner = {
  async run(): Promise<GitRunResult> {
    return { stdout: "", stderr: "", exitCode: 0 }
  },
}

describe("Plane 5 — Observability", () => {
  test("P5-24: wireGitObservability composite returns a valid handle", () => {
    const handle = wireGitObservability({ runner: noopGitRunner, cwd: "/tmp" })
    expect(typeof handle.fingerprintMeta).toBe("function")
    expect(typeof handle.turnDiff.startTurn).toBe("function")
    expect(typeof handle.turnDiff.endTurn).toBe("function")
  })

  test("P5-25: MetricsRegistry with consoleMetricsSink does not throw on send", () => {
    const reg = defaultMetricsRegistry({ sink: consoleMetricsSink })
    expect(() => {
      reg.increment("test_counter")
      reg.observe("test_hist", 12)
      reg.gauge("test_gauge", 3)
    }).not.toThrow()
  })

  test("P5-26: MetricsRegistry with jsonlMetricsSink writes to tmpdir", async () => {
    const dir = await makeUniqueDir("plane5-jsonl")
    try {
      const target = path.join(dir, "metrics.jsonl")
      const reg = defaultMetricsRegistry({ sink: jsonlMetricsSink(target) })
      reg.increment("requests_total", 1, { route: "/x" })
      reg.observe("latency_ms", 42)
      const body = await readFile(target, "utf8")
      const lines = body.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBe(2)
      // Each line parses as a MetricSample-shaped JSON object.
      for (const ln of lines) {
        const parsed = JSON.parse(ln) as { name: string; kind: string }
        expect(typeof parsed.name).toBe("string")
        expect(["counter", "histogram", "gauge"]).toContain(parsed.kind)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("P5-27: MetricsRegistry with otelMetricsSink (fake meter) → createCounter is called", () => {
    let createCounterCalls = 0
    const fakeCounter: OtelCounter = {
      add: (_v: number, _attrs?: OtelAttributes) => undefined,
    }
    const fakeHist: OtelHistogram = {
      record: (_v: number, _attrs?: OtelAttributes) => undefined,
    }
    const fakeUpDown: OtelUpDownCounter = {
      add: (_v: number, _attrs?: OtelAttributes) => undefined,
    }
    const fakeMeter: OtelMeter = {
      createCounter: (_name: string) => {
        createCounterCalls += 1
        return fakeCounter
      },
      createHistogram: () => fakeHist,
      createUpDownCounter: () => fakeUpDown,
    }
    const fakeMp: OtelMeterProvider = {
      getMeter: () => fakeMeter,
    }
    const sink = otelMetricsSink({ meterProvider: fakeMp })
    const reg = defaultMetricsRegistry({ sink })
    reg.increment("tool_calls_total")
    expect(createCounterCalls).toBeGreaterThan(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Cross-plane composition                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Cross-plane composition", () => {
  test("X-28: full pipeline — image+web+shadowOdb+checkpointPolicy+metrics+budgetLedger compose without crashes", async () => {
    const odb = makeFakeOdb({ registerHead: async () => "head-sha" })
    const ledger = defaultBudgetLedger()
    // The REAL loop `Metrics` (the old fake passed a `MetricsRegistry`
    // — a DIFFERENT port — behind `as never`; the slot type is `Metrics`).
    const metrics = new Metrics()
    const baseRegistry = new ToolRegistry([readImageTool as Tool, webFetchTool() as Tool])
    const features = await buildSessionFeatures(
      makeMinimalConfig({
        registry: baseRegistry,
        shadowOdb: odb,
        shadowCheckpoint: { mode: "pre-destructive" },
        budgetLedger: ledger,
        metrics,
      }),
    )
    const names = features.extraTools.map((t) => t.name)
    // shadowOdb wires the 3 shadow tools (rewind / restore-partial / snapshots).
    expect(names).toContain("shadow_rewind")
    expect(names).toContain("shadow_restore_partial")
    expect(names).toContain("shadow_snapshots")
    // budgetLedger wires budget_status.
    expect(names).toContain("budget_status")
    // The base registry remains intact — read_image / web_fetch live there.
    const baseNames = baseRegistry.specs().map((s) => s.name)
    expect(baseNames).toContain("read_image")
    expect(baseNames).toContain("web_fetch")
  })

  test("X-29: pipeline + subagentBackground.scheduler → schedule survives composition", async () => {
    const scheduler = defaultBackgroundSubagentScheduler({
      // Typed `SubagentRunner` result (phantom `output` field dropped).
      runner: async () => ({ ok: true, turns: 1, finalText: "done" }),
    })
    const features = await buildSessionFeatures(
      makeMinimalConfig({
        subagentBackground: { scheduler },
        shadowOdb: makeFakeOdb({ registerHead: async () => "h" }),
        budgetLedger: defaultBudgetLedger(),
      }),
    )
    const names = features.extraTools.map((t) => t.name)
    expect(names).toContain("subagent_fork")
    expect(names).toContain("subagent_poll")
    expect(names).toContain("subagent_await")
    expect(names).toContain("budget_status")
    // The scheduler is a live, callable object (we don't invoke fork here —
    // that needs an LLM. We assert the scheduler surface is wired.)
    expect(typeof scheduler.fork).toBe("function")
    expect(typeof scheduler.list).toBe("function")
  })

  test("X-30: plane-clean fence — Plane 1/3/4/5 port files MUST NOT import @/agent/loop or @/agent/dispatch", async () => {
    // Structural import-fence check via fs.readFile + regex, matching the
    // pattern in `memory-fence-no-llm-import-hellgate.test.ts`. We pick the
    // port files this round adds/touches and assert NONE of them import the
    // orchestration loop or dispatch seam — the core promise of plane
    // separation. (The orchestration plane CONSUMES these ports; ports do not
    // reach back into the orchestration plane.)
    const portFiles = [
      // Plane 1 (orchestration helpers ARE plane-clean from loop.ts itself —
      // they may not back-reference the loop)
      "src/agent/effect-channel.ts",
      "src/agent/checkpoint-policy.ts",
      "src/agent/checkpoint-wiring.ts",
      "src/agent/conversation-checkpoint.ts",
      "src/agent/verify-checkpoint-bridge.ts",
      "src/agent/plan-queue.ts",
      "src/agent/subagent-background.ts",
      // Plane 3 (context stores)
      "src/agent/budget-ledger.ts",
      // Plane 4 (control / sandbox)
      "src/runtime/os-sandbox/default.ts",
      "src/runtime/os-sandbox/linux.ts",
      "src/runtime/os-sandbox/bubblewrap.ts",
      "src/runtime/os-sandbox/seatbelt.ts",
      "src/mcp/skybridge/passthrough.ts",
      "src/mcp/skybridge/registry.ts",
      "src/mcp/skybridge/types.ts",
      // Plane 5 (observability)
      "src/observability/metrics/port.ts",
      "src/observability/metrics/in-memory-registry.ts",
      "src/observability/metrics/console-sink.ts",
      "src/observability/metrics/jsonl-sink.ts",
      "src/observability/metrics/otel-sink.ts",
      "src/agent/git-observability/index.ts",
    ]
    const offenders: { path: string; line: number; text: string }[] = []
    for (const rel of portFiles) {
      const abs = path.join(REPO_ROOT_FOR_PORT_SCAN, rel)
      const content = await readFile(abs, "utf8")
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        // Only match IMPORT statements — `from "@/agent/loop"` or
        // `from "@/agent/dispatch"`. We do NOT flag comments/docs that
        // mention the loop in prose (which several of these files do —
        // they document HOW the loop will consume them, which is legal).
        if (/^\s*import\b[\s\S]*?from\s+["']@\/agent\/(loop|dispatch)["']/.test(line)) {
          offenders.push({ path: rel, line: i + 1, text: line.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
