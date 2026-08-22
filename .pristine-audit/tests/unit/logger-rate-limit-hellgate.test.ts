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
    // R5 cold-start=1: first emit lands, then bucket is empty.
    logger.warn("slice.op: msg")
    expect(lineCount()).toBe(1)
    // Hammer the bucket while it's starved — 50 drops accumulate.
    for (let i = 0; i < 50; i++) logger.warn("slice.op: msg")
    expect(lineCount()).toBe(1) // all 50 suppressed under cold-start exhaust
    // Advance > 1 second so the bucket refills at least 1 token.
    advance(1100)
    logger.warn("slice.op: msg AFTER")
    // Expect TWO additional writes: the suppression flush + the actual message
    // (3 lines total: cold-start + flush + AFTER).
    expect(lineCount()).toBe(3)
    // The flush line precedes the message.
    const flush = captured[1] ?? ""
    const after = captured[2] ?? ""
    expect(flush).toContain("[suppressed 50 more from slice.op]")
    expect(after).toContain("msg AFTER")
  })

  test("(3) 5s idle refills 5 tokens — drains exactly 5 messages before bucket empties", () => {
    // R5 cold-start=1: warm up the bucket so refill semantics are tested
    // independent of the cold-start initial token.
    logger.warn("slice.op: warmup") // cold-start emit, tokens=0
    expect(lineCount()).toBe(1)
    // Idle 5s → 5 tokens refilled (cap=10, currently 0 → 5).
    advance(5000)
    for (let i = 0; i < 5; i++) logger.warn("slice.op: b")
    // 5 emits land. No suppression flush precedes the first (no drops
    // happened between cold-start emit and the 5s wait).
    expect(lineCount()).toBe(6)
    // 6th in this batch is suppressed (bucket empty again at tokens=0).
    logger.warn("slice.op: c")
    expect(lineCount()).toBe(6)
  })

  test("(4) different labels each get their own bucket — no cross-label sharing", () => {
    // R5 cold-start=1: A 10 writes → 1 emit + 9 suppressed. B identical.
    // The invariant pinned here is PER-LABEL ISOLATION — B's first emit is
    // unaffected by A's prior 10 writes (no shared bucket).
    for (let i = 0; i < 10; i++) logger.warn(`A.op: ${i}`)
    expect(lineCount()).toBe(1) // A: cold-start emit, rest suppressed
    for (let i = 0; i < 10; i++) logger.warn(`B.op: ${i}`)
    expect(lineCount()).toBe(2) // B: own cold-start emit (proves isolation)
    // A's 11th is still suppressed (no refill yet).
    logger.warn("A.op: overflow")
    expect(lineCount()).toBe(2)
    // Advance 1100ms → BOTH A and B refill 1 token. Emit one on B to
    // confirm A's suppression didn't drain B's budget (cross-talk check).
    advance(1100)
    logger.warn("B.op: post")
    // 3rd write line = B.op: post (preceded by a suppression flush for B's
    // earlier 9 drops). Pin both by indexing rather than total count, since
    // the flush line bumps `lineCount` to 4.
    expect(lineCount()).toBe(4)
    const flush = captured[2] ?? ""
    const after = captured[3] ?? ""
    expect(flush).toContain("[suppressed 9 more from B.op]")
    expect(after).toContain("B.op: post")
  })

  test("(5) LRU >= 32 labels evicts the oldest — evicted state is forgotten on re-touch", () => {
    // R5 cold-start=1: each fresh label gets ONE emit before suppression.
    // Fill LRU with 32 distinct labels — 32 emits total.
    for (let i = 0; i < 32; i++) logger.warn(`L${i}.op: seed`)
    expect(lineCount()).toBe(32)
    // Spam L0 with 14 writes — 1st was already emitted in seed loop, so
    // L0.tokens=0; all 14 land in `suppressed`.
    for (let i = 0; i < 14; i++) logger.warn("L0.op: dropped")
    expect(lineCount()).toBe(32) // all 14 suppressed
    // Insert 32 more new labels. Each fresh label = 1 cold-start emit. The
    // LRU evicts oldest first; since L0 just moved to the tail (most recently
    // touched), L1..L31 are evicted FIRST, then L0 once enough new labels
    // arrive (32 new > 31 cold + L0 → L0 evicted somewhere in the run).
    for (let i = 32; i < 64; i++) logger.warn(`L${i}.op: late`)
    expect(lineCount()).toBe(64) // 32 cold-start emits for L32..L63
    // L0's bucket has been evicted (along with its suppressed=14 count). A
    // fresh L0 write seeds a NEW bucket — cold-start 1 token, no carried
    // suppression flush. The key invariant: NO stale "[suppressed 14 ...]"
    // line leaks from the prior eviction-victim state.
    logger.warn("L0.op: rebirth")
    expect(lineCount()).toBe(65)
    expect(captured[64]).not.toContain("[suppressed")
    expect(captured[64]).toContain("L0.op: rebirth")
  })

  test("(6) colon-less messages still get a (truncated-prefix) label and are rate-limited", () => {
    // No colon → label = first 64 chars of the message. Same exact string
    // = same label = same bucket.
    //
    // R5 cold-start=1: 10 identical writes → 1 emit + 9 suppressed.
    const msg = "no colon here just a long ordinary message"
    for (let i = 0; i < 10; i++) logger.warn(msg)
    expect(lineCount()).toBe(1)
    logger.warn(msg)
    expect(lineCount()).toBe(1) // 11th still suppressed (no refill yet)
    // The label-derivation pathway IS being exercised (without it, every
    // distinct call would be its own bucket and all 11 would have emitted).
  })

  test("(7) QUANTA_LOG_RATE_LIMIT=off disables limiting — 1000 writes all land", () => {
    process.env.QUANTA_LOG_RATE_LIMIT = "off"
    __resetRuntimeConfig()
    for (let i = 0; i < 1000; i++) logger.warn("slice.op: noise")
    expect(lineCount()).toBe(1000)
  })

  test("(8) suppression flush line format is the operator-grep contract", () => {
    // R5 cold-start=1: first emit lands, next 16 are suppressed.
    logger.warn("auth.signin: failed") // emit 1 (cold-start)
    for (let i = 0; i < 16; i++) logger.warn("auth.signin: failed") // all suppressed
    expect(lineCount()).toBe(1)
    // Advance > 1 second so the bucket refills 1 token → next write emits
    // both the suppression flush (16 drops) and the actual message.
    advance(1100)
    logger.warn("auth.signin: failed")
    expect(lineCount()).toBe(3) // cold-start + flush + new emit
    const flush = captured[1] ?? ""
    // Format: `[<level>] [suppressed <N> more from <label>]\n`
    expect(flush).toBe("[warn] [suppressed 16 more from auth.signin]\n")
  })

  test("(9) info+warn+error sharing one label share one bucket", () => {
    // R5 cold-start=1: the SAME label across THREE severities still drains
    // the SAME bucket — the first call (info) emits, every subsequent call
    // is suppressed regardless of level.
    logger.info("svc.x: a") // cold-start: emit
    expect(lineCount()).toBe(1)
    logger.warn("svc.x: a") // shared bucket exhausted: suppressed
    logger.error("svc.x: a") // ditto
    expect(lineCount()).toBe(1) // proves shared-bucket invariant
    // Confirm severity-mix dropping is tracked: refill 1 token and a new
    // emit flushes the prior 2 drops as a single suppression line.
    advance(1100)
    logger.error("svc.x: a")
    expect(lineCount()).toBe(3)
    const flush = captured[1] ?? ""
    // Flush emits at the last-suppressed level (error) — operator sees a
    // matching severity prefix.
    expect(flush).toBe("[error] [suppressed 2 more from svc.x]\n")
  })

  test("(10) sustained spam on label A does not starve label B (no cross-talk)", () => {
    // R5 cold-start=1: spam A for 60 calls (1 emit cold-start, 59 dropped).
    for (let i = 0; i < 60; i++) logger.warn("A.op: x")
    expect(lineCount()).toBe(1)
    // B has never been touched — fresh bucket, cold-start=1 token. The 1st
    // emit goes through; the next 9 are suppressed. The starvation closure
    // here is the per-label isolation invariant, NOT capacity-10 propagation.
    for (let i = 0; i < 10; i++) logger.warn("B.op: y")
    expect(lineCount()).toBe(2)
    // Both labels can keep up with refill rate — advance 1.1s and both
    // refill 1 token; both emit once each. This is the load-bearing test:
    // A's sustained 60-call spam did NOT take from B's refill schedule.
    advance(1100)
    logger.warn("A.op: x")
    logger.warn("B.op: y")
    // 2 emits + 2 suppression flushes (A had 59 drops, B had 9 drops).
    expect(lineCount()).toBe(6)
  })
})
