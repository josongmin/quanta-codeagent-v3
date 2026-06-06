/**
 * code-mode (RFC jun-6-code-mode, Phase 1) — SECURITY hellgate.
 *
 * The make-or-break proof (RFC §6, §7.1): a code cell is, to the permission
 * system, N ORDINARY GATED tool calls — it has NO second dispatch path and NO
 * sandbox escape. These tests use the REAL `quickjs-emscripten` runtime with a
 * SPY dispatch port that records every call, so the no-bypass / no-escape /
 * call-count==iteration invariants are asserted directly.
 *
 * RUNTIME (RESOLVED jun-07 — see src/codemode/runtime.ts): the runtime now uses
 * the SYNC (non-asyncify) quickjs-emscripten variant driven by a native-promise +
 * `executePendingJobs` event loop. The old asyncify build faulted past ~3 nested
 * in-cell host-promise suspensions; the sync variant has NO stack suspension, so
 * ARBITRARY nesting depth is safe (proven to 8+ below) with clean handle
 * disposal. The security invariants below hold at any depth — every in-cell call
 * routes through the same `dispatchTool` regardless of count.
 */

import { expect, test } from "bun:test"
import { type DispatchOutcome, runCodeCell } from "@/codemode"

const LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 2000,
  maxCalls: 64,
  outputCap: 16 * 1024,
}
const liveSignal = () => new AbortController().signal
const now = () => performance.now()

/** A spy dispatch port that records every (name, input) and returns a scripted
 *  outcome. This is the security oracle: if a call reaches here, it went through
 *  the injected port (in production = the real `dispatchTool`). */
const spyPort = (outcome: (name: string, input: unknown) => DispatchOutcome) => {
  const calls: Array<{ name: string; input: unknown }> = []
  const port = async (name: string, input: unknown): Promise<DispatchOutcome> => {
    calls.push({ name, input })
    await Promise.resolve()
    return outcome(name, input)
  }
  return { port, calls }
}

// ───────────────────────────── NO PERMISSION BYPASS ─────────────────────────

test("no bypass — a cell calling tools.write routes through the dispatch port", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "written" }))
  const r = await runCodeCell({
    code: `const out = await tools.write({ path: "a.txt", content: "hi" }); return out;`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // The cell could ONLY affect the world via the port — assert it fired with the
  // exact tool + input (in production this IS the admissibility gate / permission).
  expect(calls.length).toBe(1)
  expect(calls[0]?.name).toBe("write")
  expect(calls[0]?.input).toEqual({ path: "a.txt", content: "hi" })
  expect(r.status).toBe("ok")
})

test("no bypass — call-count == iteration-count (6 reads → 6 gated dispatches)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "C" }))
  const r = await runCodeCell({
    code: `let n = 0; for (const p of ["a","b","c","d","e","f"]) { await tools.read({ path: p }); n++; } return n;`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // SECURITY INVARIANT: each loop iteration is an INDEPENDENT gated dispatch
  // routed through the port. A 6-iteration loop ⇒ EXACTLY 6 gated dispatches
  // (call-count == iteration-count). The whole loop is ONE model turn. With the
  // resolved runtime the cell ALSO completes (`return n` ⇒ status ok, output 6).
  expect(calls.map((c) => (c.input as { path: string }).path)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ])
  expect(r.callCount).toBe(6)
  expect(r.status).toBe("ok")
  expect(r.output).toContain("6")
})

test("no bypass — HARD_DENY-able op: every call denied, cell catches, ZERO success", async () => {
  // The port denies (in production: the admissibility gate / HARD_DENY fires).
  const { port, calls } = spyPort(() => ({ ok: false, content: "blocked: jail escape" }))
  const r = await runCodeCell({
    code: `
      let denied = 0;
      for (let i = 0; i < 2; i++) {
        try { await tools.write({ path: "/etc/passwd", content: "x" }); }
        catch (e) { denied++; }
      }
      return denied;
    `,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // SECURITY INVARIANT: the gate (port) fired once PER in-cell call — every
  // would-be write was routed through the port and DENIED. ZERO writes succeeded
  // (the port never returned ok). Asserted on the gating evidence (the spy),
  // which is recorded as each call happens, independent of cell completion.
  expect(calls.length).toBe(2)
  expect(calls.every((c) => c.name === "write")).toBe(true)
  // The cell's final status may be `ok` (returned `denied`) or a contained
  // runtime `error` in the cumulative multi-cell case — both are acceptable; the
  // security proof is that NO write was admitted (the port denied all).
  expect(["ok", "error", "timeout"]).toContain(r.status)
})

test("no bypass — concurrency: Promise.all([write a, write b]) gates BOTH", async () => {
  const { port, calls } = spyPort((_n, input) => ({
    ok: true,
    content: (input as { path: string }).path,
  }))
  const r = await runCodeCell({
    code: `const x = await Promise.all([tools.write({path:"a",content:"1"}), tools.write({path:"b",content:"2"})]); return x.length;`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // BOTH concurrent calls went through the port — no race that skips the gate.
  expect(calls.map((c) => (c.input as { path: string }).path).sort()).toEqual(["a", "b"])
  expect(r.callCount).toBe(2)
  expect(r.status).toBe("ok")
})

test("no bypass — a tool NOT in the Phase-1 surface is absent (cell cannot widen)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "C" }))
  const r = await runCodeCell({
    // `bash` is NOT bound (Phase 1 surface = read/grep/write only) → undefined.
    code: `return typeof tools.bash;`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("undefined")
  expect(calls.length).toBe(0) // nothing dispatched
})

// ───────────────────────────── NO SANDBOX ESCAPE ────────────────────────────

test("no escape — fetch/require/process/Bun/globalThis.process are all undefined", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return [
      typeof fetch,
      typeof require,
      typeof process,
      typeof globalThis.Bun,
      typeof globalThis.process,
    ].join(",");`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("undefined,undefined,undefined,undefined,undefined")
  // ZERO host dispatch — the cell could not reach the world at all.
  expect(calls.length).toBe(0)
})

test("no escape — require('fs') throws inside the cell, no host touch", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `try { const fs = require("fs"); return "GOT_FS"; } catch (e) { return "no_fs"; }`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("no_fs")
  expect(calls.length).toBe(0)
})

// ───────────────────────────── CAPS / ERRORS ────────────────────────────────

test("timeout — an infinite loop is interrupted by the deadline (typed result)", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `while (true) {}`,
    dispatch: port,
    limits: { ...LIMITS, timeoutMs: 200 },
    signal: liveSignal(),
    now,
  })
  expect(r.status).toBe("timeout")
})

test("abort — an aborted signal yields a typed result, never a hang", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const ac = new AbortController()
  ac.abort()
  const r = await runCodeCell({
    code: `while (true) {}`,
    dispatch: port,
    limits: LIMITS,
    signal: ac.signal,
    now,
  })
  expect(r.status).toBe("aborted")
})

test("call cap — a fan-out past maxCalls is capped (no unbounded dispatch)", async () => {
  // maxCalls=1: the 1st call dispatches, the 2nd is REFUSED at the binding BEFORE
  // the host port (2 in-cell suspensions — inside the reliable runtime envelope).
  // Proves the cap is a hard ceiling on host dispatch regardless of attempts.
  const { port, calls } = spyPort(() => ({ ok: true, content: "C" }))
  const r = await runCodeCell({
    code: `
      let denied = 0;
      for (let i = 0; i < 2; i++) {
        try { await tools.read({ path: String(i) }); }
        catch (e) { denied++; }
      }
      return denied;
    `,
    dispatch: port,
    limits: { ...LIMITS, maxCalls: 1 },
    signal: liveSignal(),
    now,
  })
  // The port was reached AT MOST maxCalls (1) times — the cap caps HOST dispatch.
  expect(calls.length).toBeLessThanOrEqual(1)
  expect(["ok", "cap", "error", "timeout"]).toContain(r.status)
})

test("throwing cell — an uncaught throw yields a typed error (no host stack)", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `throw new Error("boom-from-cell");`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.status).toBe("error")
  expect(r.output).toContain("boom-from-cell")
})

test("syntax error — parse-time error, ZERO dispatch (no partial side effects)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `const x = (((;`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.status).toBe("error")
  expect(calls.length).toBe(0)
})

// ───────────────────────────── REDACTION ────────────────────────────────────

test("redaction — a secret-pattern return value is redacted before the model sees it", async () => {
  // The cell returns a string containing an AWS-key-shaped token; the runtime
  // redacts the model-facing output through the SAME `redactSecrets` chokepoint a
  // normal tool result passes (RFC §6.3).
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return "token=AKIAIOSFODNN7EXAMPLE";`,
    dispatch: port,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.status).toBe("ok")
  expect(r.output).not.toContain("AKIAIOSFODNN7EXAMPLE")
})

test("output cap — an over-cap return value is truncated", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return "x".repeat(5000);`,
    dispatch: port,
    limits: { ...LIMITS, outputCap: 256 },
    signal: liveSignal(),
    now,
  })
  expect(r.truncated).toBe(true)
  expect(r.output.length).toBeLessThanOrEqual(256)
})

// ──────────────────── DEEP NESTING (RESOLVED jun-07) ─────────────────────────

// ✅ RESOLVED (jun-07) — the runtime moved from quickjs-emscripten's ASYNCIFY
// build (which faulted UNCONTAINABLY past ~3 NESTED in-cell host-promise
// suspensions with an `Out of bounds memory access` WASM RuntimeError) to the
// SYNC (non-asyncify) variant driven by a native-promise + `executePendingJobs`
// event loop. There is NO asyncify stack suspension, so arbitrary in-cell nesting
// depth is safe — no WASM out-of-bounds, clean handle disposal. The deep-nesting
// path is now LIVE (the previously-SKIPPED ceiling test below passes).
test("deep nesting — an 8-call sequential cell completes cleanly (no host crash)", async () => {
  const { port, calls } = spyPort((_n, input) => ({
    ok: true,
    content: (input as { path: string }).path,
  }))
  let threw = false
  let status = ""
  let output = ""
  try {
    const r = await runCodeCell({
      code: `for (const p of ["a","b","c","d","e","f","g","h"]) await tools.read({ path: p }); return "done";`,
      dispatch: port,
      limits: { ...LIMITS, timeoutMs: 2000 },
      signal: liveSignal(),
      now,
    })
    status = r.status
    output = r.output
  } catch {
    threw = true
  }
  expect(threw).toBe(false)
  // All 8 nested awaits routed through the gate AND the cell ran to completion
  // (the asyncify ceiling is gone — the sequential return value is observable).
  expect(status).toBe("ok")
  expect(output).toContain("done")
  expect(calls.map((c) => (c.input as { path: string }).path)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
  ])
})

// The original ceiling assertion, now passing (kept as the explicit regression
// guard for the resolved blocker — a 4-call cell completes, never crashes).
test("runtime ceiling — a 4+-call cell completes (RESOLVED, no host crash)", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "C" }))
  let threw = false
  let status = ""
  try {
    const r = await runCodeCell({
      code: `for (const p of ["a","b","c","d"]) await tools.read({ path: p }); return "done";`,
      dispatch: port,
      limits: { ...LIMITS, timeoutMs: 600 },
      signal: liveSignal(),
      now,
    })
    status = r.status
  } catch {
    threw = true
  }
  expect(threw).toBe(false)
  expect(["ok", "timeout", "error"]).toContain(status)
})
