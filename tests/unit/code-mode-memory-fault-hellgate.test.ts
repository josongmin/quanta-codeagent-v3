/**
 * code-mode RUNTIME — memory-limit status + VM-fault containment hellgate
 * (src/codemode/runtime.ts). Uses the REAL quickjs-emscripten runtime (same
 * setup as code-mode-hellgate.test.ts).
 *
 * Two round-1 suspects:
 *
 *  (a) `status === "memory"` is set NOWHERE. The `AbnormalReason = "memory"`
 *      enum + `CodeCellStatus = "memory"` exist, and `abnormalMessage("memory")`
 *      has a branch — but no code path ever assigns `drive.abnormal = "memory"`.
 *      `runtime.setMemoryLimit` makes QuickJS THROW an "out of memory" /
 *      "string too long" JS error INSIDE the cell, which the drive loop collects
 *      as an ordinary REJECTED promise ⇒ status `"error"`, never `"memory"`.
 *      => see the `test.todo` below + the REPORT. The companion PASSING test pins
 *      the ACTUAL behavior (status `error`) so it is a real regression guard.
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
  timeoutMs: 4000,
  maxCalls: 64,
  outputCap: 16 * 1024,
}

describe("memory limit — observed status (a)", () => {
  test("allocating past a tiny memoryBytes limit yields a CONTAINED non-ok result (never hangs)", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    // Grow an array without bound — QuickJS hits the 256 KiB heap cap.
    const r = await runCodeCell({
      code: `const a = []; for (let i = 0; i < 1e7; i++) { a.push({ x: i, pad: "padding-" + i }); } return a.length;`,
      dispatch: port,
      limits: TINY_MEM_LIMITS,
      signal: liveSignal(),
      now,
    })
    // The make-or-break property: it TERMINATES with a typed non-ok result
    // (no hang, no host throw). The status is `error` in the current runtime.
    expect(r.status).not.toBe("ok")
    // Documented current behavior — the OOM surfaces as a generic `error`.
    expect(r.status).toBe("error")
    expect(r.output.toLowerCase()).toContain("memory") // "out of memory"
  }, 15000)

  test("a huge-string allocation past the heap cap is ALSO contained as a non-ok result", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    const r = await runCodeCell({
      code: `let s = "x"; for (let i = 0; i < 40; i++) { s = s + s; } return s.length;`,
      dispatch: port,
      limits: { ...TINY_MEM_LIMITS, memoryBytes: 512 * 1024 },
      signal: liveSignal(),
      now,
    })
    expect(r.status).not.toBe("ok")
    expect(r.status).toBe("error") // "string too long" — again NOT "memory"
  }, 15000)

  // ───────────────────────────────────────────────────────────────────────────
  // ⛔ REAL BUG (round-1 confirmed): the dedicated `"memory"` status is DEAD.
  // OBSERVED vs EXPECTED: an over-allocating cell comes back with status
  // `"error"` (message "out of memory"), NOT the dedicated `"memory"` status.
  // `drive.abnormal = "memory"` is assigned NOWHERE in src/codemode/runtime.ts —
  // `runtime.setMemoryLimit` makes QuickJS throw a normal in-VM JS error, which
  // the drive loop collects as a rejected promise ⇒ finalize() maps it to
  // `"error"`. The `"memory"` arm of CodeCellStatus / AbnormalReason /
  // abnormalMessage is unreachable. A user who wired
  // `QUANTA_CODE_MODE_MEM_BYTES` cannot tell an OOM apart from any other cell
  // error (the model-facing message + the `code_cell_<status>` tag both say
  // `error`). This test is the EXPECTED-behavior assertion; flip it to a `test`
  // once the runtime distinguishes the memory-limit interrupt.
  // ───────────────────────────────────────────────────────────────────────────
  test.todo(
    "REAL BUG — an OOM cell SHOULD report status 'memory' (currently 'error'); see REPORT",
    async () => {
      const { port } = spyPort(() => ({ ok: true, content: "" }))
      const r = await runCodeCell({
        code: `const a = []; for (let i = 0; i < 1e7; i++) { a.push(new Array(1000).fill(i)); } return a.length;`,
        dispatch: port,
        limits: TINY_MEM_LIMITS,
        signal: liveSignal(),
        now,
      })
      // EXPECTED (once fixed): the dedicated memory status + its message.
      expect(r.status).toBe("memory")
      expect(r.output).toContain("memory limit exceeded")
    },
  )
})

describe("VM-fault containment (b)", () => {
  test("a stack-blowing cell is CONTAINED as a typed error — runCodeCell never throws into the host", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    let threw = false
    let status = ""
    let output = ""
    try {
      const r = await runCodeCell({
        // Unbounded recursion ⇒ QuickJS "Maximum call stack size exceeded".
        code: `function f() { return f() + 1; } return f();`,
        dispatch: port,
        limits: { memoryBytes: 16 * 1024 * 1024, timeoutMs: 3000, maxCalls: 64, outputCap: 16 * 1024 },
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
  }, 15000)

  test("a cell that throws a non-Error value is still contained (no host crash)", async () => {
    const { port } = spyPort(() => ({ ok: true, content: "" }))
    let threw = false
    let r:
      | Awaited<ReturnType<typeof runCodeCell>>
      | undefined
    try {
      r = await runCodeCell({
        code: `throw { weird: "not-an-error-object" };`,
        dispatch: port,
        limits: { memoryBytes: 16 * 1024 * 1024, timeoutMs: 2000, maxCalls: 64, outputCap: 16 * 1024 },
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
