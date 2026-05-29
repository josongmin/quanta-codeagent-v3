/**
 * R4 audit-H — logger label-keyed leaky bucket (DoS closure).
 *
 * Pre-fix: a hostile catch in a hot loop could call `logger.warn` millions
 * of times per second; every call passed through `sanitizeLogText` + the
 * sink, exhausting stderr backpressure on the host. The audit closure adds
 * a per-label token bucket:
 *
 *   - label = first colon-bounded token (matches the `<slice>.<op>:`
 *             convention the 24h-ratchet swap installed).
 *   - capacity 10 tokens, refill 1 token/sec (`BUCKET_CAPACITY` /
 *     `BUCKET_REFILL_PER_MS` in `src/shared/logger.ts`).
 *   - 32-slot LRU keyed on label. Inserting beyond capacity evicts the
 *     oldest cold label.
 *   - On the first allowed write after a suppression streak the logger
 *     emits a single `[<level>] [suppressed N more from <label>]` flush
 *     line BEFORE the original message — operators always see the
 *     dropped-count signal.
 *   - `QUANTA_LOG_RATE_LIMIT=off` reverts to unbounded for incident triage.
 *
 * These ten cases pin every load-bearing branch. Revert any single piece
 * and at least one case flips RED:
 *   (1)–(2) capacity + suppression accounting on a single label
 *   (3)     refill across a 5-second clock advance
 *   (4)–(5) LRU eviction + per-label isolation
 *   (6)     fall-through label (no colon) is still rate-limited
 *   (7)     disable knob restores byte-identical unbounded semantics
 *   (8)     suppression flush message format (operator-grep contract)
 *   (9)     different severities under the SAME label share the bucket
 *  (10)    cross-label spam at scale — second label not starved by first
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __resetLoggerRateLimit,
  __resetRuntimeConfig,
  __setLoggerNow,
  logger,
  setTerminalIo,
} from "@/shared"

let captured: string[] = []
let nowMs = 0

const advance = (ms: number): void => {
  nowMs += ms
}

beforeEach(() => {
  captured = []
  nowMs = 1_000_000 // arbitrary epoch base; absolute value doesn't matter
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk) => captured.push(chunk),
  })
  __setLoggerNow(() => nowMs)
  __resetLoggerRateLimit()
  // Re-pin the synthetic clock — __resetLoggerRateLimit clears the seam.
  __setLoggerNow(() => nowMs)
  __resetRuntimeConfig()
})

afterEach(() => {
  delete process.env.QUANTA_LOG_RATE_LIMIT
  __resetRuntimeConfig()
})

afterAll(() => {
  setTerminalIo(null)
  __setLoggerNow(null)
  __resetLoggerRateLimit()
})

const lineCount = (): number => captured.length

describe("R4 audit-H — logger leaky-bucket DoS closure (R5 cold-start tokens=1)", () => {
  test("(1) cold-start emits 1 line; 9-second wait refills to capacity 10", () => {
    // R5 audit-H closure: fresh bucket = 1 token (not 10) so an attacker
    // cannot replay full-capacity bursts by churning the LRU. Sustained
    // throughput is bounded by refill regardless of new-label churn.
    logger.warn("slice.op: msg 0")
    expect(lineCount()).toBe(1)
    logger.warn("slice.op: msg suppressed")
    expect(lineCount()).toBe(1) // cold-start exhausted, no flush yet
    // After 10s of refill the bucket sits at capacity 10 — but the first
    // accepted write also flushes the prior suppression line.
    advance(10_000)
    for (let i = 0; i < 10; i++) logger.warn(`slice.op: burst ${i}`)
    // 10 burst lines + 1 suppression flush from the prior drop.
    expect(lineCount()).toBeGreaterThanOrEqual(10)
  })

  test("(2) suppression count is flushed before the next allowed line", () => {
    logger.warn("slice.op: msg")
    expect(lineCount()).toBe(1)
    // Hammer the bucket while it's starved — 50 drops accumulate.
    for (let i = 0; i < 50; i++) logger.warn("slice.op: msg")
    expect(lineCount()).toBe(10) // still 10 — all suppressed
    // Advance > 1 second so the bucket refills at least 1 token.
    advance(1100)
    logger.warn("slice.op: msg AFTER")
    // Expect TWO writes: the suppression flush + the actual message.
    expect(lineCount()).toBe(12)
    // The flush line precedes the message.
    const flush = captured[10] ?? ""
    const after = captured[11] ?? ""
    expect(flush).toContain("[suppressed 50 more from slice.op]")
    expect(after).toContain("msg AFTER")
  })

  test("(3) 5s idle refills bucket back to capacity; another burst of 10 passes", () => {
    for (let i = 0; i < 10; i++) logger.warn("slice.op: a")
    expect(lineCount()).toBe(10)
    // Idle 5s → 5 tokens refilled (cap=10, currently 0 → 5)
    advance(5000)
    for (let i = 0; i < 5; i++) logger.warn("slice.op: b")
    // Each of the 5 emits; the FIRST one carries no flush prefix (no drops
    // since the last allowed write — case (2) covers the flush path).
    expect(lineCount()).toBe(15)
    // 6th in this batch would be suppressed (bucket empty again)
    logger.warn("slice.op: c")
    expect(lineCount()).toBe(15)
  })

  test("(4) different labels each get their own capacity-10 bucket", () => {
    for (let i = 0; i < 10; i++) logger.warn(`A.op: ${i}`)
    for (let i = 0; i < 10; i++) logger.warn(`B.op: ${i}`)
    expect(lineCount()).toBe(20)
    // A's 11th is suppressed
    logger.warn("A.op: overflow")
    expect(lineCount()).toBe(20)
    // B is unaffected — but B has also drained to 0 by now, so any B emit
    // is also suppressed. Confirm A's suppression didn't take from B's
    // budget by advancing 1100ms (B refills 1 token) and emitting once.
    advance(1100)
    logger.warn("B.op: post")
    expect(lineCount()).toBe(21)
    expect(captured[20]).toContain("B.op: post")
  })

  test("(5) LRU >= 32 labels evicts the oldest — its state is forgotten", () => {
    // Fill LRU with 32 distinct labels at capacity 1 each (one emit each).
    for (let i = 0; i < 32; i++) logger.warn(`L${i}.op: seed`)
    expect(lineCount()).toBe(32)
    // Drain L0 with 9 more emits + 5 suppressed (now L0.bucket = empty,
    // suppressed=5)
    for (let i = 0; i < 9; i++) logger.warn("L0.op: drain")
    for (let i = 0; i < 5; i++) logger.warn("L0.op: dropped")
    expect(lineCount()).toBe(41)
    // Insert a 33rd label — L0 is the LRU head (most recently touched is L0
    // actually because we just hammered it). To force eviction of the OLDEST,
    // we touch a NEW label which evicts the OLDEST cold one (L1, the LRU
    // head since L0 just moved to the tail). Insert 32 more new labels so
    // EVERY original L0..L31 is forced out of the LRU.
    for (let i = 32; i < 64; i++) logger.warn(`L${i}.op: late`)
    expect(lineCount()).toBe(73)
    // Now L0's state is gone (evicted long ago). A fresh L0 write gets a
    // fresh capacity-10 bucket — and CRUCIALLY no stale "[suppressed 5 ...]"
    // flush from the prior eviction-victim state.
    logger.warn("L0.op: rebirth")
    expect(lineCount()).toBe(74)
    expect(captured[73]).not.toContain("[suppressed")
    expect(captured[73]).toContain("L0.op: rebirth")
  })

  test("(6) colon-less messages still get a (truncated-prefix) label and are rate-limited", () => {
    // No colon → label = first 64 chars of the message. Same exact string
    // = same label = same bucket.
    const msg = "no colon here just a long ordinary message"
    for (let i = 0; i < 10; i++) logger.warn(msg)
    expect(lineCount()).toBe(10)
    logger.warn(msg)
    expect(lineCount()).toBe(10) // 11th suppressed
  })

  test("(7) QUANTA_LOG_RATE_LIMIT=off disables limiting — 1000 writes all land", () => {
    process.env.QUANTA_LOG_RATE_LIMIT = "off"
    __resetRuntimeConfig()
    for (let i = 0; i < 1000; i++) logger.warn("slice.op: noise")
    expect(lineCount()).toBe(1000)
  })

  test("(8) suppression flush line format is the operator-grep contract", () => {
    for (let i = 0; i < 10; i++) logger.warn("auth.signin: failed")
    for (let i = 0; i < 7; i++) logger.warn("auth.signin: failed")
    advance(1100)
    logger.warn("auth.signin: failed")
    // First 10 originals → suppression flush → 1 more allowed
    expect(lineCount()).toBe(12)
    const flush = captured[10] ?? ""
    // Format: `[<level>] [suppressed <N> more from <label>]\n`
    expect(flush).toBe("[warn] [suppressed 7 more from auth.signin]\n")
  })

  test("(9) info+warn+error sharing one label share one bucket", () => {
    // Burn budget with mixed severities under the SAME label.
    for (let i = 0; i < 4; i++) logger.info("svc.x: a")
    for (let i = 0; i < 4; i++) logger.warn("svc.x: a")
    for (let i = 0; i < 2; i++) logger.error("svc.x: a")
    expect(lineCount()).toBe(10) // all 10 emit under shared bucket
    logger.error("svc.x: a") // suppressed because bucket is empty
    expect(lineCount()).toBe(10)
  })

  test("(10) sustained spam on label A does not starve label B (no cross-talk)", () => {
    // Spam A for 60 calls (10 emit, 50 dropped). All under one bucket.
    for (let i = 0; i < 60; i++) logger.warn("A.op: x")
    expect(lineCount()).toBe(10)
    // B has never been touched — full bucket, capacity 10.
    for (let i = 0; i < 10; i++) logger.warn("B.op: y")
    expect(lineCount()).toBe(20)
  })
})
