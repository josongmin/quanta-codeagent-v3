/**
 * R9 hellgate — multi-tenant `caller` namespace seam on the leaky-bucket
 * label of the `@/shared` line logger.
 *
 * Closes R6 audit Agent2 #4: `labelFor` (in `log-rate-limit.ts`) keyed the
 * rate-limit bucket on the message prefix alone, so an adversarial slice
 * spamming a popular prefix (`slice.op:`) drained a sibling's quota even
 * though they share nothing else. The fix adds an optional `caller`
 * argument that is folded into the bucket label as `${caller}::${prefix}`
 * — distinct callers get distinct buckets, while the visible OUTPUT line
 * is byte-identical regardless of caller (back-compat).
 *
 * Adversarial axes pinned (~16 cases):
 *
 *   - back-compat (2): legacy framing preserved when the third arg is
 *     omitted; meta-only call shape identical too.
 *   - namespace separation (2): same prefix + different caller →
 *     independent buckets, so spamming one caller does NOT starve another.
 *   - `::` injection (2): a malicious caller embedding `tenantB::` cannot
 *     forge a sibling's bucket — `sanitizeCaller` strips the layer-owned
 *     separator before the label is assembled.
 *   - whitespace caller → no-caller bucket (back-compat shape).
 *   - 64-char length cap: a 10KB caller cannot dominate the bucket key.
 *   - threshold pre-emption: a hostile caller cannot smuggle a debug-level
 *     line past the configured threshold; level gating runs FIRST.
 *   - `sanitizeCaller` purity (7): explicit invariants on the exported
 *     helper so call-site code can rely on its shape without re-deriving
 *     the contract from the logger.
 *
 * Sink discipline: we override the terminal-io sink (the only port `write`
 * reaches) so the test is sink-deterministic and never touches real stderr.
 * Clock is pinned via `__setLoggerNow` so refill / suppression order is
 * deterministic without `setTimeout`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __resetLoggerRateLimit,
  __resetRuntimeConfig,
  __setLoggerNow,
  logger,
  sanitizeCaller,
  setTerminalIo,
} from "@/shared"

let captured: string[] = []
let nowMs = 0

beforeEach(() => {
  captured = []
  nowMs = 2_000_000 // arbitrary epoch base
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk) => captured.push(chunk),
  })
  __setLoggerNow(() => nowMs)
  __resetLoggerRateLimit()
  __setLoggerNow(() => nowMs) // __reset clears the seam — re-pin
  __resetRuntimeConfig()
})

afterEach(() => {
  delete process.env.QUANTA_LOG_LEVEL
  __resetRuntimeConfig()
})

afterAll(() => {
  setTerminalIo(null)
  __setLoggerNow(null)
  __resetLoggerRateLimit()
})

describe("R9 multi-tenant caller seam — output back-compat", () => {
  test("(1) omitting caller is byte-identical to legacy single-prefix output", () => {
    logger.warn("slice.op: budget exceeded")
    // Pre-seam shape: `[warn] slice.op: budget exceeded\n`
    expect(captured).toEqual(["[warn] slice.op: budget exceeded\n"])
  })

  test("(2) meta + no caller preserves legacy framing exactly", () => {
    logger.info("slice.op: hit", { count: 3 })
    // Pre-seam shape: `[info] slice.op: hit {"count":3}\n`
    expect(captured).toEqual(['[info] slice.op: hit {"count":3}\n'])
  })
})

describe("R9 multi-tenant caller seam — bucket namespace separation", () => {
  test("(3) same prefix + different callers → distinct buckets (no cross-talk)", () => {
    // Adversarial slice A spams 60 lines on `slice.op:` under caller A.
    // Cold-start = 1 token → 1 emit + 59 suppressed on A's bucket.
    for (let i = 0; i < 60; i++) {
      logger.warn("slice.op: budget exceeded", undefined, { caller: "tenant-A" })
    }
    expect(captured.length).toBe(1)
    // Benign slice B emits ONCE under caller B with the SAME prefix. If
    // labels were prefix-only, B would land on A's empty bucket and be
    // suppressed (quota starvation). With the namespace separator, B has
    // its own cold-start = 1 token bucket and emits.
    logger.warn("slice.op: budget exceeded", undefined, { caller: "tenant-B" })
    expect(captured.length).toBe(2)
    // Both lines have IDENTICAL visible framing — caller is bucket-only,
    // not in the output. This is the back-compat invariant under the seam.
    expect(captured[0]).toBe("[warn] slice.op: budget exceeded\n")
    expect(captured[1]).toBe("[warn] slice.op: budget exceeded\n")
  })

  test("(4) caller-less and caller-A on the same prefix are distinct buckets", () => {
    // Two legacy (caller-less) writes share one bucket → 1 emit + 1 drop.
    logger.warn("svc.x: msg")
    logger.warn("svc.x: msg")
    expect(captured.length).toBe(1)
    // A caller-A write on the same prefix lands on a separate bucket —
    // its OWN cold-start token emits regardless of the legacy bucket state.
    logger.warn("svc.x: msg", undefined, { caller: "tenant-A" })
    expect(captured.length).toBe(2)
  })
})

describe("R9 multi-tenant caller seam — `::` injection defence", () => {
  test("(5) caller embedding `::` cannot forge a sibling bucket", () => {
    // Tenant B fills its bucket by emitting + suppressing.
    logger.warn("slice.op: msg", undefined, { caller: "tenant-B" })
    logger.warn("slice.op: msg", undefined, { caller: "tenant-B" })
    expect(captured.length).toBe(1) // 1 emit + 1 drop on B's bucket
    // Adversarial caller embeds `::tenant-B` hoping to land on B's bucket
    // and inherit its suppression accounting (or, worse, ride B's quota
    // refill). After sanitizeCaller the `::` is stripped → the effective
    // caller is `tenant-Atenant-B` (a fused id, not tenant-B). Its bucket
    // is fresh: cold-start = 1 token → emits.
    logger.warn("slice.op: msg", undefined, { caller: "tenant-A::tenant-B" })
    expect(captured.length).toBe(2)
    // Pinning the fused-caller bucket distinctness: a SECOND write under
    // the same fused caller hits its own (now-empty) bucket → suppressed.
    logger.warn("slice.op: msg", undefined, { caller: "tenant-A::tenant-B" })
    expect(captured.length).toBe(2)
  })

  test("(6) nested `::::` chain collapses; bucket identity is the fused id", () => {
    // Caller `a::::b::::c` → after strip → `abc`. Two writes share one
    // bucket → 1 emit + 1 drop, irrespective of how many `::` were nested
    // in the raw input.
    logger.warn("nest.op: msg", undefined, { caller: "a::::b::::c" })
    logger.warn("nest.op: msg", undefined, { caller: "a::::b::::c" })
    expect(captured.length).toBe(1)
    // A different fusion (`abc` vs `ab` + `c`) MUST land on a different
    // bucket. We pick `ab::c` → after strip → `abc` (same fused id, so
    // SAME bucket — this is the deterministic property of strip-then-trim).
    logger.warn("nest.op: msg", undefined, { caller: "ab::c" })
    expect(captured.length).toBe(1) // suppressed: same fused bucket
    // But a distinct fused id `abd` lands on its own bucket → emits.
    logger.warn("nest.op: msg", undefined, { caller: "ab::d" })
    expect(captured.length).toBe(2)
  })
})

describe("R9 multi-tenant caller seam — sanitize edge cases", () => {
  test("(7) whitespace-only caller falls back to legacy (no-caller) bucket", () => {
    // Legacy write fills the no-caller bucket.
    logger.warn("blank.op: msg")
    expect(captured.length).toBe(1)
    // Whitespace caller → sanitize → undefined → same no-caller bucket.
    // The bucket is exhausted → suppressed.
    logger.warn("blank.op: msg", undefined, { caller: "   " })
    expect(captured.length).toBe(1)
  })

  test("(8) 64-char caller cap — a 10KB caller cannot exhaust bucket-key memory", () => {
    const giant = "x".repeat(10_000)
    // First write under the giant caller — sanitize caps at 64 chars,
    // bucket key = `${"x".repeat(64)}::cap.op`. Cold-start = 1 → emits.
    logger.warn("cap.op: msg", undefined, { caller: giant })
    expect(captured.length).toBe(1)
    // A DIFFERENT giant that AGREES on the first 64 chars must land on
    // the same bucket (proves the cap is enforced; otherwise per-call
    // distinct bucket = unbounded LRU growth from one hostile slice).
    logger.warn("cap.op: msg", undefined, { caller: `${"x".repeat(64)}-different-suffix` })
    expect(captured.length).toBe(1) // suppressed: same capped bucket
  })

  test("(9) threshold pre-emption — caller cannot smuggle debug past warn threshold", () => {
    process.env.QUANTA_LOG_LEVEL = "warn"
    __resetRuntimeConfig()
    // A hostile caller might hope that "fresh bucket = fresh quota" lets a
    // debug line slip through. But threshold gating runs FIRST (before the
    // caller is even read), so the line is dropped before any bucket
    // accounting happens.
    logger.debug("smuggle.op: msg", undefined, { caller: "tenant-A" })
    expect(captured.length).toBe(0)
  })
})

describe("R9 sanitizeCaller — exported pure helper", () => {
  test("(s1) undefined → undefined (legacy back-compat shape)", () => {
    expect(sanitizeCaller(undefined)).toBeUndefined()
  })

  test("(s2) plain id → trimmed", () => {
    expect(sanitizeCaller("  tenant-A  ")).toBe("tenant-A")
  })

  test("(s3) embedded `::` removed", () => {
    expect(sanitizeCaller("a::b")).toBe("ab")
  })

  test("(s4) single `:` preserved (common in slice ids)", () => {
    expect(sanitizeCaller("slice.op:phase")).toBe("slice.op:phase")
  })

  test("(s5) empty / whitespace / pure-`::` → undefined (no forged bucket)", () => {
    expect(sanitizeCaller("")).toBeUndefined()
    expect(sanitizeCaller("   ")).toBeUndefined()
    expect(sanitizeCaller("::")).toBeUndefined()
    expect(sanitizeCaller("::::")).toBeUndefined()
  })

  test("(s6) 64-char cap on long ids", () => {
    const id = "x".repeat(100)
    const out = sanitizeCaller(id)
    expect(out).toBeDefined()
    expect((out as string).length).toBe(64)
  })

  test("(s7) exact 64-char id is preserved (boundary)", () => {
    const id = "x".repeat(64)
    expect(sanitizeCaller(id)).toBe(id)
  })
})
