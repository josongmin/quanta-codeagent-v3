import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ExternalPromptQueue } from "@/apps/cli/repl/external-prompt-queue"
import type { CliPromptInput } from "@/apps/cli/repl/prompt-types"
import { isIndependentPromptInput } from "@/apps/cli/repl/session-loop/bootstrap"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

/**
 * T06 — External prompt queue waiter idempotency hellgate (L5 M-14).
 *
 * Root cause: a `next(signal)` waiter could be settled TWICE — once by
 * `push()` (resolve with a prompt) and once by the abort listener (resolve
 * null) — and a settled-but-not-removed waiter could be handed a second
 * prompt. The settle path is now idempotent + self-removing.
 */

const prompt = (text: string): CliPromptInput => text

describe("T06 / external prompt queue — thin-surface ownership (ADR-0303)", () => {
  test("OWN-1: the generic queue mechanism lives below src/apps/** (in @/runner)", () => {
    expect(existsSync(join(REPO_ROOT, "src/runner/orchestrate/external-prompt-queue.ts"))).toBe(
      true,
    )
    const generic = readFileSync(
      join(REPO_ROOT, "src/runner/orchestrate/external-prompt-queue.ts"),
      "utf8",
    )
    // the reusable waiter race logic must live in the runner, not the surface
    expect(generic).toContain("export class ExternalPromptQueue<T>")
    expect(generic).toContain("removeEventListener")
    // and it must NOT depend on any surface (no apps import, no surface element type)
    expect(generic).not.toContain("@/apps/")
    expect(generic).not.toContain('from "./prompt-types"')
  })

  test("OWN-2: the CLI file is a thin binding, not a re-implementation", () => {
    const surface = readFileSync(
      join(REPO_ROOT, "src/apps/cli/repl/external-prompt-queue.ts"),
      "utf8",
    )
    expect(surface).toContain("extends GenericExternalPromptQueue<CliPromptInput>")
    expect(surface).toContain("onPush")
    // the waiter race logic must NOT be re-implemented in the surface
    expect(surface).not.toContain("removeEventListener")
    expect(surface).not.toContain("#waiters")
  })
})

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

  test("QUEUE-6: every external ingress notifies before a waiter receives it", async () => {
    const events: string[] = []
    const q = new ExternalPromptQueue({ onPush: () => events.push("push") })
    const pending = q.next()
    q.push(prompt("wake"))
    expect(events).toEqual(["push"])
    expect(await pending).toBe("wake")
  })

  test("QUEUE-7: a notification fault cannot drop an external prompt", async () => {
    const q = new ExternalPromptQueue({
      onPush: () => {
        throw new Error("observer failed")
      },
    })
    q.push(prompt("still-delivered"))
    expect(await q.next()).toBe("still-delivered")
  })

  test("QUEUE-8: notification receives the exact input for ingress classification", () => {
    const seen: CliPromptInput[] = []
    const q = new ExternalPromptQueue({ onPush: (input) => seen.push(input) })
    const continuation: CliPromptInput = {
      text: "continue",
      goalContinuation: { threadId: "t", objectiveRevision: 1, attemptKey: "a" },
    }
    q.push("plain")
    q.push(continuation)
    expect(seen).toEqual(["plain", continuation])
    expect(seen.map(isIndependentPromptInput)).toEqual([true, false])
  })
})
