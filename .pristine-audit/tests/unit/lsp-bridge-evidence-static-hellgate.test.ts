/**
 * F-lsp silent-failure hellgate (audit jun-10 findings #22/#23) — the
 * PRODUCTION `evidenceLspStatic` port for collect_evidence:
 *
 *  - #23: the ContentModified retry must branch on the TYPED JSON-RPC code
 *    (`LspRequestError` -32801 ContentModified / -32802 ServerCancelled), not
 *    a `String(e)` regex. rust-analyzer's real -32801 message never says
 *    "content modified", so the regex aborted the retry budget instantly and
 *    static evidence silently nulled.
 *  - #22: the port threads the turn AbortSignal — post-abort the 500ms retry
 *    sleeps must not keep querying a live LSP child for the full budget
 *    (abort-aware sleep from src/agent/loop/sleep.ts).
 *  - port contract: `buildEvidence` / `collect_evidence` hand the signal to
 *    `lspStatic` exactly like the `runtime` (DAP) sibling source.
 *
 * red-on-injection: regex text-classification fails the typed -32801 test
 * (and its paired untyped-"content modified" control); bare
 * `new Promise(setTimeout)` sleeps fail the abort elapsed bound; a dropped
 * 4th argument fails the threading tests.
 */
import { describe, expect, test } from "bun:test"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { LspRequestError } from "@/lsp"
import type { FileSystemPort } from "@/storage"
import type { LspNavProvider, LspNavSession, NavHover } from "@/tool"
import { buildEvidence } from "@/tool/evidence/builder"
import { makeCollectEvidenceTool } from "@/tool/evidence/tool"
import type { TestRunResult, Toolchain } from "@/tool/testrun"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const HOVER: NavHover = { contents: "fn add(a: i32, b: i32) -> i32" }

interface FakeStats {
  hoverCalls: number
  stopped: boolean
}

/** Fake provider whose session answers hover via `hover(callNumber)` (1-based)
 *  and records call/stop counts — the seam injected into evidenceLspStatic. */
const fakeProvider = (
  hover: (call: number) => Promise<NavHover | null>,
  stats: FakeStats,
): LspNavProvider => ({
  unavailableReason: () => "n/a (fake)",
  open: async (): Promise<LspNavSession> => ({
    definition: async () => [],
    references: async () => [],
    hover: async () => {
      stats.hoverCalls += 1
      return hover(stats.hoverCalls)
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

const contentModified = (): LspRequestError =>
  // rust-analyzer's REAL -32801 payload — note: no "content modified" text in
  // any form the old regex matched. The typed code is the only reliable signal.
  new LspRequestError("textDocument/hover", {
    code: -32801,
    message: "waiting for cargo metadata or cargo check",
  })

describe("evidenceLspStatic — typed ContentModified retry (#23)", () => {
  test("typed -32801 with rust-analyzer's REAL message is RETRIED and evidence lands", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = fakeProvider(async (call) => {
      if (call === 1) throw contentModified()
      return HOVER
    }, stats)
    const port = evidenceLspStatic(5_000, provider)
    const ev = await port("/p/src/lib.rs", 6, "/p")
    expect(ev).not.toBeNull()
    expect(ev?.type_info).toBe(HOVER.contents)
    expect(stats.hoverCalls).toBeGreaterThanOrEqual(2) // retried past the typed error
    expect(stats.stopped).toBe(true) // session torn down (finally)
  })

  test("typed -32802 (ServerCancelled) is retried too", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = fakeProvider(async (call) => {
      if (call === 1)
        throw new LspRequestError("textDocument/hover", {
          code: -32802,
          message: "server cancelled the request",
        })
      return HOVER
    }, stats)
    const ev = await evidenceLspStatic(5_000, provider)("/p/src/lib.rs", 6, "/p")
    expect(ev?.type_info).toBe(HOVER.contents)
    expect(stats.hoverCalls).toBeGreaterThanOrEqual(2)
  })

  test("a non-retryable typed error gives up after ONE call (no budget burn)", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = fakeProvider(async () => {
      throw new LspRequestError("textDocument/hover", { code: -32603, message: "internal error" })
    }, stats)
    const t0 = Date.now()
    const ev = await evidenceLspStatic(5_000, provider)("/p/src/lib.rs", 6, "/p")
    expect(ev).toBeNull()
    expect(stats.hoverCalls).toBe(1) // not retried
    expect(Date.now() - t0).toBeLessThan(1_000) // and not slept against the budget
    expect(stats.stopped).toBe(true)
  })

  test("paired control: an UNTYPED error whose text says 'content modified' is NOT retried (String(e) regex deleted)", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = fakeProvider(async () => {
      throw new Error("content modified") // the old regex matched exactly this
    }, stats)
    const t0 = Date.now()
    const ev = await evidenceLspStatic(5_000, provider)("/p/src/lib.rs", 6, "/p")
    expect(ev).toBeNull()
    expect(stats.hoverCalls).toBe(1)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe("evidenceLspStatic — abort threading (#22)", () => {
  test("abort during the retry budget bails promptly: no un-cancellable 500ms sleeps, no straggler queries", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    // Always ContentModified ⇒ forces the sleep+retry path for the whole budget.
    const provider = fakeProvider(async () => {
      throw contentModified()
    }, stats)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 120)
    const t0 = Date.now()
    const ev = await evidenceLspStatic(4_000, provider)("/p/src/lib.rs", 6, "/p", ctrl.signal)
    const elapsed = Date.now() - t0
    clearTimeout(timer)
    expect(ev).toBeNull()
    expect(elapsed).toBeLessThan(1_500) // bailed at the abort, not the 4s budget
    expect(stats.stopped).toBe(true) // server session torn down on the bail path
    const callsAtReturn = stats.hoverCalls
    await new Promise((r) => setTimeout(r, 300))
    expect(stats.hoverCalls).toBe(callsAtReturn) // nothing keeps querying the child
  })

  test("an already-aborted signal returns null without a single LSP query", async () => {
    const stats: FakeStats = { hoverCalls: 0, stopped: false }
    const provider = fakeProvider(async () => HOVER, stats)
    const ctrl = new AbortController()
    ctrl.abort()
    const ev = await evidenceLspStatic(4_000, provider)("/p/src/lib.rs", 6, "/p", ctrl.signal)
    expect(ev).toBeNull()
    expect(stats.hoverCalls).toBe(0)
    expect(stats.stopped).toBe(true)
  })
})

const RUST: Toolchain = { kind: "rust", command: ["cargo", "test"], parser: "cargo" }
const failing: TestRunResult = {
  runner: "cargo",
  passed: 0,
  ok: false,
  failed: [{ name: "t", file: "src/lib.rs", line: 6 }],
}

describe("lspStatic port contract — signal threaded like the runtime sibling (#22)", () => {
  test("buildEvidence hands opts.signal to the lspStatic source", async () => {
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    await buildEvidence(
      "/repo",
      {
        detect: async () => RUST,
        runTests: async () => failing,
        lspStatic: async (_f, _l, _c, signal) => {
          seen = signal
          return null
        },
      },
      { signal: ctrl.signal },
    )
    expect(seen).toBe(ctrl.signal) // same signal object, not a copy / undefined
  })

  test("collect_evidence threads ctx.signal end-to-end into the lspStatic dep", async () => {
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    const cargoFail = [
      "test tests::fail_test ... FAILED",
      "",
      "---- tests::fail_test stdout ----",
      "thread 'tests::fail_test' panicked at src/lib.rs:6:29:",
      "assertion `left == right` failed",
      "",
      "test result: FAILED. 0 passed; 1 failed",
    ].join("\n")
    const tool = makeCollectEvidenceTool({
      fs: { fileExists: async (n: string) => n === "Cargo.toml" } as unknown as FileSystemPort,
      testPort: { run: async () => ({ stdout: cargoFail, stderr: "", exitCode: 101 }) },
      lspStatic: async (_f, _l, _c, signal) => {
        seen = signal
        return null
      },
      changedFiles: async () => [],
    })
    const ctx = { cwd: "/p", signal: ctrl.signal } as ToolContext
    let r: ToolResult | undefined
    for await (const ev of tool.execute(
      { includeRuntime: false } as never,
      ctx,
    ) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") r = ev.result
    expect(r?.ok).toBe(false) // suite is red — packet built (wiring proof, not vacuous)
    expect(seen).toBe(ctrl.signal)
  })
})
