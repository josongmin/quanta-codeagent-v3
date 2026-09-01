/**
 * code-mode RUNTIME — POST-FAULT memory classification + VM-fault containment
 * hellgate (src/codemode/runtime.ts). Uses the REAL quickjs-emscripten runtime
 * (same setup as code-mode-hellgate.test.ts).
 *
 * STRUCTURAL FIX (jun-07): the old per-tick memory watchdog (a
 * `computeMemoryUsage()` probe in the interrupt handler firing at a 0.9 fraction
 * of the cap) was WRONG. An adversarial audit proved QuickJS invokes the
 * interrupt handler at backward-jumps/calls, NOT on allocation — so a BULK
 * allocation (`new Array(N).fill`, `JSON.parse(huge)`, `"x".repeat(N)`) fires the
 * handler ~once then hard-OOMs BEFORE the watchdog ever observes 90%, so those
 * (the common real OOM) were MISLABELLED `"error"`. The per-tick probe also taxed
 * every cell ~26%, and the 0.9 fraction was an unjustified magic number.
 *
 * The watchdog is REPLACED by a POST-FAULT classifier: when a cell ends in a
 * fault / uncaught throw the runtime classifies it `"memory"` iff the fault is
 * QuickJS's own out-of-memory exception (`InternalError: out of memory` — a
 * STRUCTURED error-type signal, not a substring guess on user text) OR a single
 * confirming heap probe shows usage reached the configured cap. ZERO per-tick
 * cost; covers ALL FOUR OOM shapes the old watchdog missed.
 *
 * Two areas:
 *
 *  (a) POST-FAULT memory classification. ALL FOUR over-allocation shapes
 *      (bulk-array, repeat, JSON.parse, incremental-loop) — picked BIG relative
 *      to a small injected `memoryBytes` cap so they reliably OOM — now report the
 *      dedicated status `"memory"` with a consistent "memory limit exceeded"
 *      message. RED-ON-INJECTION: without the post-fault classifier each comes
 *      back as `"error"` (QuickJS's OOM surfaced as a generic rejected promise). A
 *      plain `throw` stays `"error"` (no false-positive).
 *
 *  (b) VM-fault containment — a cell that blows the WASM stack / over-allocates
 *      must yield a CONTAINED typed-error result, never crash / reject into the
 *      host. The runtime's NO-THROW contract holds (runCodeCell never rejects).
 */

import { describe, expect, test } from "bun:test"
import { type DispatchOutcome, runCodeCell } from "@/codemode"

const liveSignal = () => new AbortController().signal
const now = () => performance.now()

const spyPort = (outcome: () => DispatchOutcome) => {
  const calls: number[] = []
  const port = async (): Promise<DispatchOutcome> => {
    calls.push(1)
    await Promise.resolve()
    return outcome()
  }
  return { port, calls }
}

const TINY_MEM_LIMITS = {
  memoryBytes: 256 * 1024, // 256 KiB — a modest allocation blows it
  // Keep the classification fixture's timeout well clear of a genuine OOM.
  // Under full-suite host pressure a 4s competing timer can win before the
  // bulk allocation runs, testing scheduler contention instead of post-fault
  // memory classification.
  timeoutMs: 15_000,
  maxCalls: 64,
  outputCap: 16 * 1024,
}

/** Run a cell against the tiny-memory caps with the no-op port. */
const runTiny = (code: string) =>
  runCodeCell({
    code,
    dispatch: spyPort(() => ({ ok: true, content: "" })).port,
    limits: TINY_MEM_LIMITS,
    signal: liveSignal(),
    now,
  })

describe("memory limit — POST-FAULT classification (a)", () => {
  // Every OOM SHAPE below is BIG relative to the 256 KiB cap, so it reliably
  // exhausts the heap. RED-ON-INJECTION: without the post-fault classifier each
  // returns `"error"` (QuickJS's `InternalError: out of memory` surfaced as a
  // generic rejected promise) — the classifier relabels it the dedicated
  // `"memory"` status. The per-tick watchdog the audit removed could NOT catch the
  // bulk shapes (it fires ~once before the hard-OOM, never observing the breach).
  const OOM_SHAPES: ReadonlyArray<readonly [string, string]> = [
    // Bulk array — a single huge allocation the interrupt handler never sees grow.
    ["bulk-array", `const a = new Array(1000000).fill(0); return a.length;`],
    // String repeat — a single huge string allocation past the cap.
    ["repeat", `const s = "x".repeat(5000000); return s.length;`],
    // JSON.parse of a huge array literal — bulk allocation inside the parser.
    ["JSON.parse-huge", `return JSON.parse("[" + "0,".repeat(1000000) + "0]").length;`],
    // Incremental loop — the heap genuinely climbs past the cap over many ticks.
    [
      "incremental-loop",
      `const a = []; for (let i = 0; i < 1e7; i++) { a.push({ x: i, pad: "padding-" + i }); } return a.length;`,
    ],
  ]

  for (const [label, code] of OOM_SHAPES) {
    test(`OOM shape '${label}' classifies as status 'memory' (red-on-injection)`, async () => {
      const r = await runTiny(code)
      // The dedicated memory status — NOT the generic "error" it would be without
      // the post-fault classifier.
      expect(r.status).toBe("memory")
      // CONSISTENCY: status "memory" ⇒ the model-visible message says so (the old
      // code had a status="memory"/message="runtime fault" divergence; this path
      // now flows BOTH from `drive.abnormal`).
      expect(r.output).toContain("memory limit exceeded")
      expect(r.status).not.toBe("ok")
    }, 15000)
  }

  test("a plain `throw` stays 'error' (no memory false-positive)", async () => {
    const r = await runTiny(`throw new Error("boom");`)
    expect(r.status).toBe("error")
    expect(r.output).not.toContain("memory limit exceeded")
    expect(r.output).toContain("boom")
  }, 15000)

  // KNOWN + ACCEPTED, cosmetic-only (see the BEST-EFFORT note on `isQuickJsOom`):
  // a cell can FORGE QuickJS's OOM identity to self-label its failure "memory".
  // `status` only selects the model-visible diagnostic tag — BOTH code_cell_memory
  // and code_cell_error are ok:false; the forged label escapes no sandbox/cap/
  // surface and is shown back to the same model. Pinned so the behavior is
  // documented (not a surprise) and a future change to it is noticed. There is no
  // clean counter-measure: a post-OOM heap probe reads low for both a real and a
  // forged fault, so it cannot distinguish them.
  test("KNOWN cosmetic spoof: a forged InternalError('out of memory') self-labels 'memory'", async () => {
    const r = await runTiny(
      `throw Object.assign(new Error("out of memory"), { name: "InternalError" });`,
    )
    expect(r.status).toBe("memory") // documented best-effort: the label is forgeable
  }, 15000)

  test("a forged InternalError with a NON-OOM message stays 'error' (message identity required)", async () => {
    const r = await runTiny(
      `throw Object.assign(new Error("just a normal error"), { name: "InternalError" });`,
    )
    expect(r.status).toBe("error")
  }, 15000)

  test("a normal compute cell is 'ok' (the classifier never fires on success)", async () => {
    const r = await runTiny(`let s = 0; for (let i = 0; i < 100; i++) s += i; return s;`)
    expect(r.status).toBe("ok")
    expect(r.output).toContain("4950")
  }, 15000)

  test("CONSISTENCY: every status 'memory' result carries the 'memory limit exceeded' message", async () => {
    // Cross-shape invariant: there is NO path that yields status "memory" with a
    // divergent (e.g. "runtime fault") message.
    for (const [, code] of OOM_SHAPES) {
      const r = await runTiny(code)
      if (r.status === "memory") {
        expect(r.output).toContain("memory limit exceeded")
        expect(r.output.toLowerCase()).toContain("memory")
      }
    }
  }, 30000)
})

describe("VM-fault containment (b)", () => {
  test("a stack-blowing cell is CONTAINED as a typed error — runCodeCell never throws into the host", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    let threw = false
    let status = ""
    let output = ""
    try {
      const r = await runCodeCell({
        // Unbounded recursion ⇒ QuickJS "Maximum call stack size exceeded" — a
        // RangeError, NOT an OOM, so it must stay "error" (no memory mislabel).
        code: `function f() { return f() + 1; } return f();`,
        dispatch: port,
        limits: {
          memoryBytes: 16 * 1024 * 1024,
          timeoutMs: 3000,
          maxCalls: 64,
          outputCap: 16 * 1024,
        },
        signal: liveSignal(),
        now,
      })
      status = r.status
      output = r.output
    } catch {
      threw = true
    }
    // NO-THROW contract: the host got a typed result, not a rejection/crash.
    expect(threw).toBe(false)
    expect(status).toBe("error")
    expect(output.length).toBeGreaterThan(0)
    expect(output).not.toContain("memory limit exceeded")
  }, 15000)

  test("a cell that throws a non-Error value is still contained (no host crash)", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    let threw = false
    let r: Awaited<ReturnType<typeof runCodeCell>> | undefined
    try {
      r = await runCodeCell({
        code: `throw { weird: "not-an-error-object" };`,
        dispatch: port,
        limits: {
          memoryBytes: 16 * 1024 * 1024,
          timeoutMs: 2000,
          maxCalls: 64,
          outputCap: 16 * 1024,
        },
        signal: liveSignal(),
        now,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(r?.status).toBe("error")
  }, 15000)
})
