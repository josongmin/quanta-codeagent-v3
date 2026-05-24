/**
 * Wire-Closeout FINAL hellgate (2026-05-24).
 *
 * Seals the two wire gaps surfaced by the cross-loop audit of ADR 0121-0163:
 *
 *   1. ADR-0127 / 0148 — `buildWebSearchBlock` was exported from
 *      `src/agent/tier1/index.ts` but NEVER CALLED in `buildSessionFeatures`.
 *      A host wiring `config.webSearch.provider` would NOT see `web_search` in
 *      `extraTools`. CLOSED: features.ts now appends `buildWebSearchBlock(config)`.
 *
 *   2. ADR-0132 / 0146 — `readImageUrlTool` was defined in
 *      `src/tool/image/from-url.ts` but NOT exported from `image/index.ts`,
 *      NOT exported from `@/tool` barrel, and NOT in `buildDefaultTools()` — a
 *      true orphan (although the mode-mutating-table HAD `read_image_url: null`).
 *      CLOSED: tool is now (a) re-exported from `src/tool/image/index.ts`,
 *      (b) re-exported from `src/tool/index.ts`, (c) included in
 *      `buildDefaultTools()` (parallel to `read_image` / `web_fetch`).
 *
 * Negative invariants this hellgate guards (each failure mode is at least one
 * test case here):
 *   - features.ts re-omits `buildWebSearchBlock` call ⇒ `web_search` invisible
 *     even when `webSearch.provider` is wired (re-orphan regression).
 *   - features.ts wires it but a hostless config (no webSearch) gains
 *     `web_search` anyway (default-OFF byte-identical break).
 *   - `readImageUrlTool` factory drops out of the barrel chain (regression).
 *   - `buildDefaultTools()` regresses to omit `read_image_url`.
 *   - MUTATING_TOOL_TABLE drift on either tool name.
 *
 * Mirrors the discipline of `wire-audit-closeout-hellgate.test.ts` (sibling),
 * which sealed ADR-0119 / 0130 / 0136. This file is the FINAL atomic round
 * for the 0121-0163 session — every tier1 block reachable from
 * `buildSessionFeatures` is verified, and every shipped tool reachable from
 * `buildDefaultTools` is verified.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { isMutatingTool, planModeMutatingTable } from "@/agent/mode"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import * as toolBarrel from "@/tool"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { readImageUrlTool, type WebSearchProvider } from "@/tool"
import * as imageBarrel from "@/tool/image"

// Inert LLM stub — features composer never streams.
const inertLLM: LLMPort = {
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const baseRegistry = (): ToolRegistry => new ToolRegistry([])

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: baseRegistry(),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 10,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const fakeWebSearchProvider: WebSearchProvider = {
  // biome-ignore lint/suspicious/useAwait: fake — no IO
  async search() {
    return []
  },
}

// ────────────────────────────────────────────────────────────────────────────
// E. ADR-0127 / 0148 — buildWebSearchBlock features.ts wire
// ────────────────────────────────────────────────────────────────────────────
describe("wire-closeout / E. buildSessionFeatures web_search wire", () => {
  test("HELL-E1: config WITHOUT webSearch ⇒ no web_search in extraTools (default-OFF)", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(f.extraTools.find((t) => t.name === "web_search")).toBeUndefined()
  })

  test("HELL-E2: config WITH webSearch.provider ⇒ web_search IS in extraTools", async () => {
    const f = await buildSessionFeatures(cfg({ webSearch: { provider: fakeWebSearchProvider } }))
    const ws = f.extraTools.find((t) => t.name === "web_search")
    expect(ws).toBeDefined()
    expect(ws?.isReadOnly()).toBe(true)
  })

  test("HELL-E3: AgentConfig accepts webSearch slot (compile-time)", () => {
    const c = cfg({ webSearch: { provider: fakeWebSearchProvider } })
    expect(c.webSearch?.provider).toBe(fakeWebSearchProvider)
  })

  test("HELL-E4: exactOptional — empty cfg OMITS webSearch key", () => {
    const c = cfg()
    expect("webSearch" in c).toBe(false)
  })

  test("HELL-E5: buildWebSearchBlock is exported from tier1 barrel (reachability)", async () => {
    const tier1 = await import("@/agent/tier1")
    expect(typeof tier1.buildWebSearchBlock).toBe("function")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. ADR-0132 / 0146 — read_image_url barrel + defaults wire
// ────────────────────────────────────────────────────────────────────────────
describe("wire-closeout / F. read_image_url defaults wire", () => {
  test("HELL-F1: readImageUrlTool is exported from @/tool/image barrel", () => {
    expect(typeof (imageBarrel as { readImageUrlTool?: unknown }).readImageUrlTool).toBe("function")
  })

  test("HELL-F2: readImageUrlTool is exported from @/tool barrel", () => {
    expect(typeof (toolBarrel as { readImageUrlTool?: unknown }).readImageUrlTool).toBe("function")
  })

  test("HELL-F3: buildDefaultTools() includes read_image_url", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("read_image_url")
  })

  test("HELL-F4: read_image_url in defaults reports isReadOnly()===true", () => {
    const tool = buildDefaultTools().find((t) => t.name === "read_image_url")
    expect(tool).toBeDefined()
    expect(tool?.isReadOnly()).toBe(true)
  })

  test("HELL-F5: factory takes no args (always-on, no port to inject)", () => {
    // Direct factory smoke — produces a tool with the expected name.
    const t = readImageUrlTool()
    expect(t.name).toBe("read_image_url")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// G. MUTATING_TOOL_TABLE parity (no drift on the closed-out names)
// ────────────────────────────────────────────────────────────────────────────
describe("wire-closeout / G. mode-table parity", () => {
  test("HELL-G1: web_search classified null (read-only)", () => {
    expect(planModeMutatingTable().web_search).toBeNull()
    expect(isMutatingTool("web_search")).toBe(false)
  })

  test("HELL-G2: read_image_url classified null (read-only)", () => {
    expect(planModeMutatingTable().read_image_url).toBeNull()
    expect(isMutatingTool("read_image_url")).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// H. Cross-config — multi-block wires don't interfere
// ────────────────────────────────────────────────────────────────────────────
describe("wire-closeout / H. composition non-interference", () => {
  test("HELL-H1: webSearch + budgetLedger together both surface in extraTools", async () => {
    const { defaultBudgetLedger } = await import("@/agent/budget-ledger")
    const f = await buildSessionFeatures(
      cfg({
        webSearch: { provider: fakeWebSearchProvider },
        budgetLedger: defaultBudgetLedger(),
      }),
    )
    expect(f.extraTools.find((t) => t.name === "web_search")).toBeDefined()
    expect(f.extraTools.find((t) => t.name === "budget_status")).toBeDefined()
  })

  test("HELL-H2: empty config ⇒ empty extraTools (byte-identical default-OFF)", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(f.extraTools).toEqual([])
  })
})
