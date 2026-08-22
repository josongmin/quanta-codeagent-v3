/**
 * lsp-bridge-clock hellgate — the PRODUCTION `evidenceLspStatic` budget-polling
 * loop must drive its deadline off an INJECTED clock, not the global one, so the
 * timeout path is deterministically testable without real wall-time.
 *
 * Structural fix under test: `evidenceLspStatic(budgetMs, provider, now)` threads
 * `now: () => number = Date.now` and the loop reads `now()` for BOTH the deadline
 * computation and the per-iteration `while (now() < deadline)` guard.
 *
 * red-on-injection:
 *  - if the loop reverts to the global clock, advancing the injected clock past
 *    the deadline has NO effect — the loop would enter, query the provider, and
 *    (since hover always throws a retryable error) ride out the real 500ms
 *    abort-aware sleeps for the full budget. The bounded wall-time assertion and
 *    the zero-query assertion both fail.
 *  - this does NOT undo lane F's abort work: the existing abort-during-evidence
 *    test (lsp-bridge-evidence-static-hellgate.test.ts) stays green; here we
 *    additionally prove the clock-driven exit needs no signal at all.
 */
import { describe, expect, test } from "bun:test"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { LspRequestError } from "@/lsp"
import type { LspNavProvider, LspNavSession, NavHover } from "@/tool"

interface FakeStats {
  hoverCalls: number
  stopped: boolean
}

/** Provider whose hover always raises the retryable -32801 — i.e. the loop is
 *  forced down the retry/sleep branch and can only ever exit by the deadline. */
const alwaysIndexingProvider = (stats: FakeStats): LspNavProvider => ({
  unavailableReason: () => "n/a (fake)",
  open: async (): Promise<LspNavSession> => ({
    definition: async () => [],
    references: async () => [],
    hover: async (): Promise<NavHover | null> => {
      stats.hoverCalls += 1
      throw new LspRequestError("textDocument/hover", {
        code: -32801,
        message: "waiting for cargo metadata or cargo check",
      })
    },
    typeDefinition: async () => null,
    implementation: async () => null,
    documentSymbol: async () => null,
    workspaceSymbol: async () => null,
    prepareRename: async () => null,
    incomingCalls: async () => null,
    outgoingCalls: async () => null,
    stop: async () => {
      stats.stopped = true
    },
  }),
})

describe("evidenceLspStatic — injected clock drives the budget deadline", () => {
  test("clock past the deadline on the first guard ⇒ exits immediately, no query, no real sleep", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = alwaysIndexingProvider(stats)
    // First read (deadline = now() + budgetMs) sees t=0 ⇒ deadline = 1000.
    // Every subsequent read jumps WAY past the deadline, so `while (now() <
    // deadline)` is false on its first evaluation — loop body never runs.
    let ticks = 0
    const now = (): number => {
      const v = ticks === 0 ? 0 : 10_000_000
      ticks += 1
      return v
    }
    const t0 = Date.now()
    const ev = await evidenceLspStatic(1_000, provider, now)("/p/src/lib.rs", 6, "/p")
    const wall = Date.now() - t0

    // Budget-exhaustion path returns the empty-but-non-null static packet.
    expect(ev).not.toBeNull()
    expect(ev?.type_info).toBeNull()
    expect(ev?.definition_chain).toEqual([])
    expect(ev?.references).toEqual([])
    // The injected clock — not the global one — gated the loop: zero LSP queries.
    expect(stats.hoverCalls).toBe(0)
    expect(stats.stopped).toBe(true) // torn down in finally
    // No real 500ms abort-aware sleep was ever reached.
    expect(wall).toBeLessThan(200)
  })

  test("clock advances across iterations ⇒ a bounded number of sweeps then deadline exit", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = alwaysIndexingProvider(stats)
    // Deadline read = 0 ⇒ deadline = 600. Each later `now()` advances by 250,
    // so the guard is true at 250 and 500 (2 sweeps) then false at 750. The
    // sleep between sweeps is abort-aware; with no signal it really waits 500ms
    // — but only TWICE, bounded by the injected clock, never the global one.
    let ticks = 0
    const now = (): number => {
      const v = ticks === 0 ? 0 : 250 * ticks
      ticks += 1
      return v
    }
    const ev = await evidenceLspStatic(600, provider, now)("/p/src/lib.rs", 6, "/p")
    expect(ev).not.toBeNull()
    expect(ev?.type_info).toBeNull()
    // 80-col sweep raises retryable each call; exactly 2 sweeps entered.
    // (40 columns scanned per sweep at ch += 2 → 0..78 → 40 hover calls each.)
    expect(stats.hoverCalls).toBe(80)
    expect(stats.stopped).toBe(true)
  })

  test("default clock (no 3rd arg) is still wired: the existing 2-arg call shape works", async () => {
    // Backwards-compat guard: the production caller invokes `evidenceLspStatic()`
    // / `evidenceLspStatic(budget, provider)` with NO clock; the bare `= Date.now`
    // default must keep that path alive. A tiny budget exits via the real clock.
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = alwaysIndexingProvider(stats)
    const ev = await evidenceLspStatic(0, provider)("/p/src/lib.rs", 6, "/p")
    expect(ev).not.toBeNull()
    expect(ev?.type_info).toBeNull()
    expect(stats.hoverCalls).toBe(0) // budget 0 ⇒ deadline already past, no query
  })
})
