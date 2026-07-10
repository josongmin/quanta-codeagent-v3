/**
 * HELLGATE — ROUND 4: RESOURCE-EXHAUSTION / UNBOUNDED-GROWTH lens.
 *
 * Two structures that grew one entry per distinct key ever seen, with no cap and
 * no eviction (R4 findings), are proven BOUNDED under adversarial volume:
 *
 *   1. tmux-adapter `lastCapture` Map — one entry per distinct handle ever READ.
 *      A session that reads from N distinct tmux handles accumulated N entries
 *      forever (detach/kill evict, but a never-detached handle lingered). Now
 *      bounded at `maxAttached` (default PTY_MAX_ATTACHED=32): a `read` of a NEW
 *      handle past the cap is rejected `cap-exceeded`; re-reading a tracked
 *      handle is always allowed; detach/kill free a slot.
 *
 *   2. stale-read-guard H9 `rangeHashes` Map — one entry per distinct
 *      (path,offset,limit) range ever read. A loop reading 1M distinct windows
 *      grew it without bound. Now bounded at `DEFAULT_RANGE_DEDUP_CAP` with FIFO
 *      eviction (the map is a pure optimization, so dropping the oldest is safe).
 *
 * Pure unit tests — no real tmux/process, no filesystem, no network. Each test
 * constructs the VOLUME input and asserts the structure stays bounded OR the cap
 * fires with a typed failure BEFORE unbounded growth.
 */
import { describe, expect, test } from "bun:test"
import {
  createTmuxAdapter,
  PTY_MAX_ATTACHED,
  type PtyHandle,
  type PtyResult,
  type TmuxExec,
} from "@/tool/pty"
import { DEFAULT_RANGE_DEDUP_CAP, ReadFileState } from "@/tool/stale-read-guard"

// ── tmux lastCapture bound ───────────────────────────────────────────────────

/** A trivial always-succeeds tmux exec: every subcommand returns ok with a fixed
 *  capture text so `read` always records a `lastCapture` entry for its handle. */
const okExec = (): TmuxExec => ({
  run: async () => ({ ok: true, stdout: "pane-text" }),
})

describe("R4 — tmux lastCapture is BOUNDED (no unbounded growth)", () => {
  test("reading N>cap DISTINCT handles: the (cap+1)-th NEW handle is rejected cap-exceeded", async () => {
    const cap = 4
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: cap })
    // Fill the cap with `cap` distinct handles — each first read admits a slot.
    for (let i = 0; i < cap; i++) {
      const r = await adapter.read(`tmux:quanta-${i}`, 0)
      expect(r.ok).toBe(true)
    }
    // The (cap+1)-th DISTINCT handle must be refused, not silently admitted.
    const over: PtyResult<unknown> = await adapter.read("tmux:quanta-overflow", 0)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.code).toBe("cap-exceeded")
      expect(over.message).toContain(String(cap))
    }
  })

  test("re-reading an ALREADY-TRACKED handle never trips the cap (no growth)", async () => {
    const cap = 2
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: cap })
    await adapter.read("tmux:quanta-a", 0)
    await adapter.read("tmux:quanta-b", 0) // now at cap
    // Re-reading either tracked handle 1000× stays bounded — same map size.
    for (let i = 0; i < 1000; i++) {
      const r = await adapter.read(i % 2 === 0 ? "tmux:quanta-a" : "tmux:quanta-b", 0)
      expect(r.ok).toBe(true)
    }
    // A brand-new handle is still refused (the 1000 re-reads did not grow room).
    const over = await adapter.read("tmux:quanta-c", 0)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe("cap-exceeded")
  })

  test("detach frees a slot — the next NEW handle is then admitted", async () => {
    const cap = 1
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: cap })
    expect((await adapter.read("tmux:quanta-a", 0)).ok).toBe(true)
    // At cap — a different handle is refused…
    expect((await adapter.read("tmux:quanta-b", 0)).ok).toBe(false)
    // …detach the tracked one to evict its lastCapture entry…
    expect((await adapter.detach("tmux:quanta-a")).ok).toBe(true)
    // …now the slot is free and the new handle reads ok.
    expect((await adapter.read("tmux:quanta-b", 0)).ok).toBe(true)
  })

  test("kill frees a slot too (the other eviction path)", async () => {
    const cap = 1
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: cap })
    expect((await adapter.read("tmux:quanta-a", 0)).ok).toBe(true)
    expect((await adapter.read("tmux:quanta-b", 0)).ok).toBe(false)
    expect((await adapter.kill("tmux:quanta-a")).ok).toBe(true)
    expect((await adapter.read("tmux:quanta-b", 0)).ok).toBe(true)
  })

  test("a non-positive maxAttached override is clamped to 1 (always holds the just-read handle)", async () => {
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: 0 })
    // Clamp to 1 ⇒ the first read succeeds (the map can hold 1 entry)…
    expect((await adapter.read("tmux:quanta-a", 0)).ok).toBe(true)
    // …and a second DISTINCT handle is refused (proves the bound is 1, not 0).
    expect((await adapter.read("tmux:quanta-b", 0)).ok).toBe(false)
  })

  test("default cap is PTY_MAX_ATTACHED when no override is given", async () => {
    const adapter = createTmuxAdapter({ exec: okExec() })
    // Reading exactly PTY_MAX_ATTACHED distinct handles all succeed…
    for (let i = 0; i < PTY_MAX_ATTACHED; i++) {
      expect((await adapter.read(`tmux:quanta-${i}`, 0)).ok).toBe(true)
    }
    // …the next distinct handle is refused.
    const over = await adapter.read("tmux:quanta-over", 0)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.message).toContain(String(PTY_MAX_ATTACHED))
  })

  test("VOLUME: 10k distinct-handle reads never grow the map past the cap", async () => {
    const cap = 8
    const adapter = createTmuxAdapter({ exec: okExec(), maxAttached: cap })
    let admitted = 0
    let refused = 0
    for (let i = 0; i < 10_000; i++) {
      const r: PtyResult<unknown> = await adapter.read(`tmux:quanta-${i}` as PtyHandle, 0)
      if (r.ok) admitted++
      else refused++
    }
    // Only the first `cap` distinct handles were ever admitted; the remaining
    // 9_992 distinct handles were all refused — the map never exceeded the cap.
    expect(admitted).toBe(cap)
    expect(refused).toBe(10_000 - cap)
  })
})

// ── stale-read-guard rangeHashes FIFO bound ──────────────────────────────────

describe("R4 — stale-read-guard rangeHashes is BOUNDED (FIFO eviction)", () => {
  test("recording cap+1 distinct ranges evicts the OLDEST (FIFO), map stays at cap", () => {
    const cap = 3
    const state = new ReadFileState(cap)
    // Record cap distinct ranges (offset 0..cap-1).
    for (let off = 0; off < cap; off++) {
      state.recordReadRange("/f", off, 100, `hash-${1000 + off}`)
    }
    // All present.
    for (let off = 0; off < cap; off++) {
      expect(state.recordedRangeHash("/f", off, 100)).toBe(`hash-${1000 + off}`)
    }
    // One more DISTINCT range → the oldest (offset 0) is evicted.
    state.recordReadRange("/f", cap, 100, "hash-9999")
    expect(state.recordedRangeHash("/f", 0, 100)).toBeUndefined() // evicted
    expect(state.recordedRangeHash("/f", cap, 100)).toBe("hash-9999") // newest retained
    // Middle ranges survive.
    for (let off = 1; off < cap; off++) {
      expect(state.recordedRangeHash("/f", off, 100)).toBe(`hash-${1000 + off}`)
    }
  })

  test("re-recording an existing range REFRESHES + moves it to the FIFO tail (survives eviction)", () => {
    const cap = 2
    const state = new ReadFileState(cap)
    state.recordReadRange("/f", 0, 10, "h1") // oldest
    state.recordReadRange("/f", 1, 10, "h2")
    // Touch offset 0 again → it becomes the NEWEST (moves to tail).
    state.recordReadRange("/f", 0, 10, "h5")
    // Now insert a 3rd distinct range → offset 1 (the now-oldest) is evicted.
    state.recordReadRange("/f", 2, 10, "h3")
    expect(state.recordedRangeHash("/f", 1, 10)).toBeUndefined() // evicted
    expect(state.recordedRangeHash("/f", 0, 10)).toBe("h5") // refreshed + survived
    expect(state.recordedRangeHash("/f", 2, 10)).toBe("h3")
  })

  test("VOLUME: 100k distinct ranges keep only the last `cap` (no unbounded growth)", () => {
    const cap = 16
    const state = new ReadFileState(cap)
    for (let i = 0; i < 100_000; i++) {
      state.recordReadRange("/f", i, 50, `h${i}`)
    }
    // The first 100k-cap ranges are all gone; only the last `cap` survive.
    expect(state.recordedRangeHash("/f", 0, 50)).toBeUndefined()
    expect(state.recordedRangeHash("/f", 100_000 - cap - 1, 50)).toBeUndefined()
    for (let i = 100_000 - cap; i < 100_000; i++) {
      expect(state.recordedRangeHash("/f", i, 50)).toBe(`h${i}`)
    }
  })

  test("a non-positive cap is clamped to 1 (still bounded, holds the latest range)", () => {
    const state = new ReadFileState(0)
    state.recordReadRange("/f", 0, 10, "h1")
    state.recordReadRange("/f", 1, 10, "h2")
    expect(state.recordedRangeHash("/f", 0, 10)).toBeUndefined() // evicted
    expect(state.recordedRangeHash("/f", 1, 10)).toBe("h2") // latest survives
  })

  test("the freshness `mtimes` map is ORTHOGONAL — the range cap does not touch it", () => {
    // The dedup cap must not affect the write-blocking freshness baseline.
    const state = new ReadFileState(1)
    state.record("/a", 100)
    state.record("/b", 200)
    // Recording many ranges (which evict each other under cap=1) leaves the
    // freshness map intact — both paths still carry a baseline.
    for (let i = 0; i < 50; i++) state.recordReadRange("/a", i, 10, `h${i}`)
    expect(state.recordedMtime("/a")).toBe(100)
    expect(state.recordedMtime("/b")).toBe(200)
    expect(state.has("/a")).toBe(true)
    expect(state.has("/b")).toBe(true)
  })

  test("DEFAULT_RANGE_DEDUP_CAP is the default bound (no constructor arg)", () => {
    const state = new ReadFileState()
    // Fill exactly to the default cap, then one more → the first is evicted,
    // proving the unparameterized default is finite (not unbounded).
    for (let i = 0; i < DEFAULT_RANGE_DEDUP_CAP; i++) {
      state.recordReadRange("/f", i, 1, `h${i}`)
    }
    expect(state.recordedRangeHash("/f", 0, 1)).toBe("h0")
    state.recordReadRange("/f", DEFAULT_RANGE_DEDUP_CAP, 1, "h1")
    expect(state.recordedRangeHash("/f", 0, 1)).toBeUndefined()
  })
})
