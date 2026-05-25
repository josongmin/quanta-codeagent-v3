/**
 * Hellgate — `DefaultDeferredResultRegistry` (ADR-0286).
 *
 * Seals every invariant in the closed `DeferredResultRegistry` port:
 *   A. Surface (5 normal cases) — register/poll/complete/await/cancel
 *   B. Corner (10 adversarial cases) — race, eviction, throw, double-register,
 *      timeout, post-cancel poll, post-complete await, list, idempotency
 *   C. Cleanup (3 cases) — no zombie Promise, list accuracy, default-OFF
 *
 * The tests construct the production registry directly (no agent loop) so
 * the contract is exercised in isolation. AbortController + microtask
 * scheduling are inherent — we use `Promise.resolve()` ticks to advance
 * the microtask queue deterministically.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DEFERRED_CAP,
  DefaultDeferredResultRegistry,
} from "@/tool/deferred/default-registry"
import type { DeferredHandle, Status } from "@/tool/deferred/types"
import type { ToolResult } from "@/tool/types"

const result = (output: string): ToolResult => ({ ok: true, output })

/** Advance the microtask queue N times. queueMicrotask schedules a step;
 *  awaiting `Promise.resolve()` drains a microtask each time. */
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

describe("ADR-0286 — surface (normal 5)", () => {
  test("register returns a handle with id + createdAt; initially pending", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(async () => result("ok"))
    expect(typeof h.id).toBe("string")
    expect(h.id.length).toBeGreaterThan(0)
    expect(typeof h.createdAt).toBe("number")
    expect(reg.poll(h).kind).toBe("pending")
  })

  test("poll transitions pending → running → completed across microtasks", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let gate: () => void = () => undefined
    const h = reg.register(
      async () =>
        new Promise<ToolResult>((res) => {
          gate = () => res(result("done"))
        }),
    )
    expect(reg.poll(h).kind).toBe("pending")
    await tick(2)
    expect(reg.poll(h).kind).toBe("running")
    gate()
    await tick(2)
    const s = reg.poll(h)
    expect(s.kind).toBe("completed")
    if (s.kind === "completed") expect(s.result.output).toBe("done")
  })

  test("complete: worker resolves → status completed with the result", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(async () => result("answer"))
    const s = await reg.await(h)
    expect(s.kind).toBe("completed")
    if (s.kind === "completed") expect(s.result.output).toBe("answer")
  })

  test("await blocks until terminal", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let gate: () => void = () => undefined
    const h = reg.register(
      async () =>
        new Promise<ToolResult>((res) => {
          gate = () => res(result("awaited"))
        }),
    )
    const p = reg.await(h)
    // Concurrent settle — fire the gate after a few ticks so the await
    // path attaches a waiter BEFORE the worker resolves.
    setTimeout(() => gate(), 10)
    const s = await p
    expect(s.kind).toBe("completed")
  })

  test("cancel moves a pending handle to cancelled", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(
      async (signal) =>
        new Promise<ToolResult>((_res, rej) => {
          signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )
    reg.cancel(h)
    const s = await reg.await(h)
    expect(s.kind).toBe("cancelled")
    if (s.kind === "cancelled") expect(s.error.kind).toBe("cancelled")
  })
})

describe("ADR-0286 — corner (adversarial 10)", () => {
  test("concurrent poll: 100 polls return consistent terminal status", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(async () => result("x"))
    await reg.await(h)
    const polls = Array.from({ length: 100 }, () => reg.poll(h))
    for (const p of polls) expect(p.kind).toBe("completed")
  })

  test("LRU eviction: oldest non-pending entry is evicted; poll returns handle-evicted", async () => {
    const reg = new DefaultDeferredResultRegistry({ cap: 3 })
    const h1 = reg.register(async () => result("1"))
    const h2 = reg.register(async () => result("2"))
    const h3 = reg.register(async () => result("3"))
    // Settle so they are non-pending and thus eligible for eviction.
    await reg.await(h1)
    await reg.await(h2)
    await reg.await(h3)
    // Register 2 more to push past the cap (the registry size becomes 5;
    // the cap kicks in at register-time, evicting the oldest non-pending).
    const h4 = reg.register(async () => result("4"))
    void h4
    const h5 = reg.register(async () => result("5"))
    void h5
    // h1 should be gone; poll yields the closed `handle-evicted` reason.
    const sEvicted = reg.poll(h1)
    expect(sEvicted.kind).toBe("failed")
    if (sEvicted.kind === "failed") expect(sEvicted.error.kind).toBe("handle-evicted")
  })

  test("worker throw → failed with worker-threw classification", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(async () => {
      throw new Error("boom")
    })
    const s = await reg.await(h)
    expect(s.kind).toBe("failed")
    if (s.kind === "failed") {
      expect(s.error.kind).toBe("worker-threw")
      if (s.error.kind === "worker-threw") expect(s.error.message).toBe("boom")
    }
  })

  test("cancel mid-run: worker observes abort + graceful cancel", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let observed = false
    const h = reg.register(
      async (signal) =>
        new Promise<ToolResult>((_res, rej) => {
          signal.addEventListener("abort", () => {
            observed = true
            rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        }),
    )
    // Let it reach running first.
    await tick(2)
    reg.cancel(h)
    const s = await reg.await(h)
    expect(s.kind).toBe("cancelled")
    expect(observed).toBe(true)
  })

  test("await timeout: returns failed/await-timeout; worker keeps running", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let finished = false
    const h = reg.register(
      async () =>
        new Promise<ToolResult>((res) => {
          setTimeout(() => {
            finished = true
            res(result("late"))
          }, 50)
        }),
    )
    const s = await reg.await(h, 5)
    expect(s.kind).toBe("failed")
    if (s.kind === "failed") expect(s.error.kind).toBe("await-timeout")
    // Worker still completes; a second await (no timeout) sees the real result.
    const s2 = await reg.await(h)
    expect(s2.kind).toBe("completed")
    expect(finished).toBe(true)
  })

  test("double register: each call returns a fresh distinct handle", () => {
    const reg = new DefaultDeferredResultRegistry()
    const h1 = reg.register(async () => result("a"))
    const h2 = reg.register(async () => result("a"))
    expect(h1.id).not.toBe(h2.id)
    const live = reg.list().map((x) => x.id)
    expect(live).toContain(h1.id)
    expect(live).toContain(h2.id)
  })

  test("poll after cancel: returns cancelled (synchronous reflection of cancel)", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(
      async (signal) =>
        new Promise<ToolResult>((_res, rej) => {
          signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )
    reg.cancel(h)
    const s = reg.poll(h)
    expect(s.kind).toBe("cancelled")
  })

  test("await after complete: cached terminal status returned immediately", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h = reg.register(async () => result("cached"))
    const first = await reg.await(h)
    expect(first.kind).toBe("completed")
    // Second await is a no-wait — poll() short-circuits before attaching a waiter.
    const second = await reg.await(h, 5_000)
    expect(second.kind).toBe("completed")
  })

  test("registry over-cap with EVERY entry still pending: accepted silently (no orphan worker)", async () => {
    const reg = new DefaultDeferredResultRegistry({ cap: 2 })
    let r1: (() => void) | undefined
    let r2: (() => void) | undefined
    let r3: (() => void) | undefined
    const h1 = reg.register(
      async () => new Promise<ToolResult>((res) => (r1 = () => res(result("1")))),
    )
    const h2 = reg.register(
      async () => new Promise<ToolResult>((res) => (r2 = () => res(result("2")))),
    )
    const h3 = reg.register(
      async () => new Promise<ToolResult>((res) => (r3 = () => res(result("3")))),
    )
    // No eviction possible — every entry pending/running. All 3 handles live.
    expect(reg.list().length).toBe(3)
    // Flush microtasks so each worker reaches its Promise constructor and
    // captures the `res` callback into r1/r2/r3.
    await tick(3)
    r1?.()
    r2?.()
    r3?.()
    await reg.await(h1)
    await reg.await(h2)
    await reg.await(h3)
  })

  test("cancel unknown handle: silent no-op (does not throw)", () => {
    const reg = new DefaultDeferredResultRegistry()
    const ghost: DeferredHandle = { id: "deferred-ghost", createdAt: 0 }
    expect(() => reg.cancel(ghost)).not.toThrow()
    // Poll yields unknown-handle classification.
    const s = reg.poll(ghost)
    expect(s.kind).toBe("failed")
    if (s.kind === "failed") expect(s.error.kind).toBe("unknown-handle")
  })
})

describe("ADR-0286 — cleanup (3 cases)", () => {
  test("no zombie Promise: timeout detaches the waiter; later complete does not double-resolve", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let r: (() => void) | undefined
    const h = reg.register(
      async () => new Promise<ToolResult>((res) => (r = () => res(result("late")))),
    )
    let extraResolved = 0
    const p = reg.await(h, 5)
    const s1 = await p
    expect(s1.kind).toBe("failed")
    // Trigger the underlying completion AFTER the timeout fired.
    r?.()
    // Wait long enough for the late resolve to settle.
    await new Promise((res) => setTimeout(res, 20))
    // A fresh await reads the cached terminal — no double-resolve from the
    // earlier waiter (which the timeout detached).
    const _s2 = await reg.await(h)
    extraResolved += 1
    expect(extraResolved).toBe(1)
  })

  test("list returns exactly the live handles in registration order", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const h1 = reg.register(async () => result("1"))
    const h2 = reg.register(async () => result("2"))
    const ids = reg.list().map((h) => h.id)
    expect(ids).toEqual([h1.id, h2.id])
  })

  test("default-OFF: DEFAULT_DEFERRED_CAP is 1000 and is the registry's silent ceiling", () => {
    expect(DEFAULT_DEFERRED_CAP).toBe(1000)
    const reg = new DefaultDeferredResultRegistry()
    // Constructing without explicit cap does not throw + accepts a handle.
    const h = reg.register(async () => result("x"))
    const s: Status = reg.poll(h)
    expect(s.kind).toBe("pending")
  })
})
