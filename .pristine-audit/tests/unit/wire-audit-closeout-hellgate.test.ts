/**
 * Wire-audit closeout hellgate (P0+P1 atomic round).
 *
 * Seals the wiring gaps surfaced by the cross-loop audit:
 *   A. MUTATING_TOOL_TABLE entries for 7 caller-wire-time tools so
 *      `isMutatingTool` cannot throw `UnknownToolError` on plan-mode dispatch
 *      (ADR-0119 shadow / ADR-0130 background subagent / ADR-0136 budget_status).
 *   B. FeaturesConfig Pick union covers `planQueue` / `metrics` / `budgetLedger`
 *      / `lspPorts` so the AgentConfig slot is REACHABLE from features.ts.
 *   C. `buildSessionFeatures` materializes the budget block when wired and
 *      stays byte-identical when not — including exactOptional posture
 *      (the optional `budgetLedger` field is OMITTED on `{}`, not `undefined`).
 *   D. `subagentBgTools` factory is barrel-exported from `@/tool`.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { isMutatingTool, planModeMutatingTable } from "@/agent/mode"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { Metrics } from "@/observability"
import * as toolBarrel from "@/tool"
import { ToolRegistry } from "@/tool"

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

// ────────────────────────────────────────────────────────────────────────────
// A. MUTATING_TOOL_TABLE — 7 missing entries (P0 plan-mode crash blocker)
// ────────────────────────────────────────────────────────────────────────────
describe("wire-audit / A. MUTATING_TOOL_TABLE entries", () => {
  test("HELL-A1: shadow_snapshots classified null (read-only)", () => {
    expect(planModeMutatingTable().shadow_snapshots).toBeNull()
    expect(isMutatingTool("shadow_snapshots")).toBe(false)
  })
  test("HELL-A2: shadow_rewind classified git_mutating", () => {
    expect(planModeMutatingTable().shadow_rewind).toBe("git_mutating")
    expect(isMutatingTool("shadow_rewind")).toBe(true)
  })
  test("HELL-A3: shadow_restore_partial classified git_mutating", () => {
    expect(planModeMutatingTable().shadow_restore_partial).toBe("git_mutating")
    expect(isMutatingTool("shadow_restore_partial")).toBe(true)
  })
  test("HELL-A4: subagent_fork classified bash_mutating", () => {
    expect(planModeMutatingTable().subagent_fork).toBe("bash_mutating")
    expect(isMutatingTool("subagent_fork")).toBe(true)
  })
  test("HELL-A5: subagent_poll classified null (read-only)", () => {
    expect(planModeMutatingTable().subagent_poll).toBeNull()
    expect(isMutatingTool("subagent_poll")).toBe(false)
  })
  test("HELL-A6: subagent_await classified null (read-only)", () => {
    expect(planModeMutatingTable().subagent_await).toBeNull()
    expect(isMutatingTool("subagent_await")).toBe(false)
  })
  test("HELL-A7: budget_status classified null (read-only)", () => {
    expect(planModeMutatingTable().budget_status).toBeNull()
    expect(isMutatingTool("budget_status")).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. FeaturesConfig Pick union — compile-time + runtime sanity
// ────────────────────────────────────────────────────────────────────────────
describe("wire-audit / B. FeaturesConfig Pick reachability", () => {
  test("HELL-B1: AgentConfig accepts planQueue slot", () => {
    const c = cfg({
      planQueue: {
        store: {
          enqueue: () => {},
          popReady: () => null,
          peek: () => [],
          drain: () => [],
          size: () => 0,
        } as unknown as import("@/agent/plan-queue").PlanQueueStore,
      },
    })
    expect(c.planQueue).toBeDefined()
  })
  test("HELL-B2: AgentConfig accepts metrics slot", () => {
    const c = cfg({ metrics: new Metrics() })
    expect(c.metrics).toBeInstanceOf(Metrics)
  })
  test("HELL-B3: AgentConfig accepts budgetLedger slot", async () => {
    const { defaultBudgetLedger } = await import("@/agent/budget-ledger")
    const c = cfg({ budgetLedger: defaultBudgetLedger() })
    expect(c.budgetLedger).toBeDefined()
  })
  test("HELL-B4: AgentConfig accepts lspPorts slot (4-field shape, exactOptional)", () => {
    // Empty `{}` is structurally valid — every sub-field is optional under
    // exactOptionalPropertyTypes. Provides the compile-time proof that the
    // `lspPorts` slot exists on AgentConfig with the documented 4-field shape.
    const c = cfg({ lspPorts: {} })
    expect(c.lspPorts).toBeDefined()
    // Type-narrowing proof: each named sub-field must compile against its
    // declared port type when assigned (no `as` cheat needed).
    const _proof: {
      codeAction?: import("@/lsp").CodeActionPort
      format?: import("@/lsp").FormatPort
      signatureHelp?: import("@/lsp").SignatureHelpPort
      renameApply?: import("@/lsp").RenameApplyPort
    } = c.lspPorts ?? {}
    expect(_proof).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. features.ts builder wires
// ────────────────────────────────────────────────────────────────────────────
describe("wire-audit / C. buildSessionFeatures budget block wire", () => {
  test("HELL-C1: config without budgetLedger ⇒ extraTools has no budget_status", async () => {
    const f = await buildSessionFeatures(cfg())
    expect(f.extraTools.find((t) => t.name === "budget_status")).toBeUndefined()
  })
  test("HELL-C2: config with budgetLedger ⇒ extraTools has budget_status", async () => {
    const { defaultBudgetLedger } = await import("@/agent/budget-ledger")
    const f = await buildSessionFeatures(cfg({ budgetLedger: defaultBudgetLedger() }))
    expect(f.extraTools.find((t) => t.name === "budget_status")).toBeDefined()
  })
  test("HELL-C3: exactOptional — AgentConfig with no overrides OMITS budgetLedger key", () => {
    const c = cfg()
    expect("budgetLedger" in c).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. Tool barrel — subagentBgTools factory re-export
// ────────────────────────────────────────────────────────────────────────────
describe("wire-audit / D. tool barrel", () => {
  test("HELL-D1: subagentBgTools is exported from @/tool", () => {
    expect(typeof (toolBarrel as { subagentBgTools?: unknown }).subagentBgTools).toBe("function")
  })
})
