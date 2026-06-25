/**
 * Hellgate — jun-26 (REPORT-jun26-tool-impl-vs-frontier §2/§4.5): the bench
 * surface registers the CHEAP / index-backed LSP-nav tier DEFAULT-ON, while the
 * two MEASURED-intractable members (`lsp_references` / `lsp_implementation`,
 * jun-19 sympy 15s+60s timeout) stay opt-in behind the full `QUANTA_BENCH_LSP`
 * gate.
 *
 * This is a GATED DEFAULT-FLIP. The safety contract is pinned two ways:
 *   1. red-on-injection — with the feature live, the default (all-unset) bench
 *      registry now CONTAINS the cheap nav tools (e.g. `lsp_workspace_symbol`,
 *      `lsp_incoming_calls`) but NOT the two expensive members. Revert the
 *      driver's `opt.lspNavCheap` branch (so the default registers no nav) and
 *      the "cheap tools present by default" assertions go RED.
 *   2. byte-identity OFF — `QUANTA_BENCH_LSP_CHEAP=0` (the kill-switch /
 *      A-arm baseline) drops EVERY `lsp_*` tool, so the nav surface is identical
 *      to the legacy default-OFF posture (zero nav tools). This proves the flip
 *      is reversible to the prior bytes.
 *
 * All assertions read the REAL `buildConfig`→`buildBenchRegistry` path through
 * the production `apps/bench/eval/driver` re-export (same seam as
 * bench-opt-in.test.ts), so a wiring regression in either layer is caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { LSP_NAV_EXPENSIVE_TOOL_NAMES } from "@/tool"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_LSP_CHEAP",
  "QUANTA_LSP_TOOLS",
] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = {
  emit() {
    // no-op
  },
}
const instance: Instance = {
  id: "test-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true",
}
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }

const navToolNames = (): string[] => {
  const ac = new AbortController()
  const cfg = buildConfig(instance, baseDeps, "/tmp/sb", ac.signal, stubStream)
  return cfg.registry
    .specs()
    .map((s) => s.name)
    .filter((n) => n.startsWith("lsp_"))
    .sort()
}

describe("bench LSP-nav cheap-tier (default-ON gated flip)", () => {
  test("DEFAULT (all unset) registers the cheap nav tier — red-on-injection", () => {
    const nav = navToolNames()
    // The above-frontier index-backed / call-graph members appear out-of-box.
    expect(nav).toContain("lsp_workspace_symbol")
    expect(nav).toContain("lsp_document_symbol")
    expect(nav).toContain("lsp_incoming_calls")
    expect(nav).toContain("lsp_outgoing_calls")
    expect(nav).toContain("lsp_definition")
    // Non-empty: the default bench model now sees nav (the whole point).
    expect(nav.length).toBeGreaterThan(0)
  })

  test("DEFAULT cheap tier EXCLUDES the two measured-intractable members", () => {
    const nav = navToolNames()
    for (const expensive of LSP_NAV_EXPENSIVE_TOOL_NAMES) {
      expect(nav).not.toContain(expensive)
    }
    // Belt-and-suspenders: also excludes the MUTATING rename_apply (never auto-on).
    expect(nav).not.toContain("lsp_rename_apply")
  })

  test("QUANTA_BENCH_LSP_CHEAP=0 → ZERO lsp_* tools (byte-identical legacy OFF)", () => {
    process.env.QUANTA_BENCH_LSP_CHEAP = "0"
    expect(navToolNames()).toEqual([])
    // off / false tokens are the same kill-switch.
    process.env.QUANTA_BENCH_LSP_CHEAP = "off"
    expect(navToolNames()).toEqual([])
    process.env.QUANTA_BENCH_LSP_CHEAP = "false"
    expect(navToolNames()).toEqual([])
  })

  test("full opt-in (QUANTA_BENCH_LSP=1) SUPERSETS the cheap tier with the expensive members", () => {
    process.env.QUANTA_BENCH_LSP_CHEAP = "0" // prove the full gate, not cheap, supplies them
    process.env.QUANTA_BENCH_LSP = "1"
    const nav = navToolNames()
    for (const expensive of LSP_NAV_EXPENSIVE_TOOL_NAMES) {
      expect(nav).toContain(expensive)
    }
    // The cheap members are also present (full ⊋ cheap).
    expect(nav).toContain("lsp_workspace_symbol")
    expect(nav).toContain("lsp_incoming_calls")
  })

  test("full opt-in registers strictly MORE nav tools than the cheap default", () => {
    const cheapDefault = navToolNames() // all unset ⇒ cheap tier
    process.env.QUANTA_BENCH_LSP = "1"
    const full = navToolNames()
    expect(full.length).toBeGreaterThan(cheapDefault.length)
    // Every cheap member survives into the full surface (cheap ⊆ full).
    for (const t of cheapDefault) expect(full).toContain(t)
  })

  test("cheap kill-switch suppresses ONLY the cheap default, not a full lsp:1 preset", () => {
    // `agentless-v1` declares `lsp:1` (the full opt-in). The cheap kill-switch
    // governs the CHEAP TIER, not the explicit full gate — so the full nav
    // (including the expensive members) still wins. This pins the precedence:
    // full opt-in ⊋ cheap, and the kill-switch never strips a full opt-in.
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LSP_CHEAP = "off"
    const nav = navToolNames()
    for (const expensive of LSP_NAV_EXPENSIVE_TOOL_NAMES) expect(nav).toContain(expensive)
    expect(nav).toContain("lsp_workspace_symbol")
  })

  test("cheap kill-switch DOES strip the cheap default for a preset WITHOUT lsp:1", () => {
    // A preset that does not opt into the full `lsp` gate: the cheap default is
    // the only nav source, so the kill-switch returns the legacy empty surface.
    process.env.QUANTA_BENCH_LSP_CHEAP = "0"
    expect(navToolNames()).toEqual([])
  })

  test("explicit full-off (QUANTA_BENCH_LSP=off) ALSO suppresses the cheap default", () => {
    // The existing "I want NO LSP nav" kill-switch must strip the new cheap
    // tier too — operator intent is no nav, not just no references.
    process.env.QUANTA_BENCH_LSP = "off"
    expect(navToolNames()).toEqual([])
    process.env.QUANTA_BENCH_LSP = "0"
    expect(navToolNames()).toEqual([])
  })

  test("explicit QUANTA_BENCH_LSP_CHEAP=1 re-enables the cheap tier even under full-off", () => {
    // Precedence: an explicit cheap=1 wins over the full-off suppression, so an
    // operator can run "cheap nav but never references/implementation".
    process.env.QUANTA_BENCH_LSP = "off"
    process.env.QUANTA_BENCH_LSP_CHEAP = "1"
    const nav = navToolNames()
    expect(nav).toContain("lsp_workspace_symbol")
    for (const expensive of LSP_NAV_EXPENSIVE_TOOL_NAMES) expect(nav).not.toContain(expensive)
  })
})
