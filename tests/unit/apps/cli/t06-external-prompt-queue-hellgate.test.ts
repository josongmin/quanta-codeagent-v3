import { describe, expect, test } from "bun:test"
import { ExternalPromptQueue } from "@/apps/cli/repl/external-prompt-queue"
import type { CliPromptInput } from "@/apps/cli/repl/prompt-types"

/**
 * T06 — External prompt queue waiter idempotency hellgate (L5 M-14).
 *
 * Root cause: a `next(signal)` waiter could be settled TWICE — once by
 * `push()` (resolve with a prompt) and once by the abort listener (resolve
 * null) — and a settled-but-not-removed waiter could be handed a second
 * prompt. The settle path is now idempotent + self-removing.
 */

const prompt = (text: string): CliPromptInput => text

describe("T06 / external prompt queue", () => {
  test("QUEUE-1: queued item returns immediately, FIFO preserved", async () => {
    const q = new ExternalPromptQueue()
    q.push(prompt("a"))
    q.push(prompt("b"))
    expect(await q.next()).toBe("a")
    expect(await q.next()).toBe("b")
  })

  test("QUEUE-2: a pending waiter is resolved by a later push", async () => {
    const q = new ExternalPromptQueue()
    const p = q.next()
    q.push(prompt("late"))
    expect(await p).toBe("late")
  })

  test("QUEUE-3: abort after a waiter resolves null exactly once, no double-settle", async () => {
    const q = new ExternalPromptQueue()
    const ctrl = new AbortController()
    const p = q.next(ctrl.signal)
    ctrl.abort()
    expect(await p).toBeNull()
    // The settled waiter must be gone — a subsequent push must NOT be consumed
    // by the already-settled waiter (it would otherwise be lost). It must
    // instead queue for the NEXT next().
    q.push(prompt("after-abort"))
    expect(q.size()).toBe(1)
    expect(await q.next()).toBe("after-abort")
  })

  test("QUEUE-4: push winning the race against an abort yields the prompt, never null", async () => {
    const q = new ExternalPromptQueue()
    const ctrl = new AbortController()
    const p = q.next(ctrl.signal)
    // push() settles the waiter first; a then-fired abort must be a no-op.
    q.push(prompt("won"))
    ctrl.abort()
    expect(await p).toBe("won")
  })

  test("QUEUE-5: abort BEFORE next() short-circuits to null without registering a waiter", async () => {
    const q = new ExternalPromptQueue()
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await q.next(ctrl.signal)).toBeNull()
    // No leaked waiter: a later push must queue, not silently vanish.
    q.push(prompt("x"))
    expect(q.size()).toBe(1)
  })
})
