/**
 * ★ HELLGATE — Ticket 18 (V1): background-turn portal.
 *
 * The portal is the PURE state store behind `/background` + Ctrl+B. It owns a
 * registry of detached turns, each carrying its live `promise` + an
 * `AbortController`. The portal NEVER re-enters the agent loop and never imports
 * `@/agent` — it is a passive observer with a read-only `view()` projection.
 *
 * Invariants under test:
 *   - detach() registers a 'running' entry immediately (before the promise
 *     settles) so a prompt-re-entry breadcrumb can be painted at once.
 *   - promise resolve ⇒ state flips to 'done' + result captured.
 *   - promise reject (non-abort) ⇒ 'failed' + error captured.
 *   - promise reject with AbortError ⇒ 'cancelled' (the user backgrounded then
 *     cancelled; the body unwound via its abort signal).
 *   - cancel(id) fires the entry's AbortController (NO-THROW even if unknown).
 *   - buffer is BOUNDED at BG_BUFFER_MAX_BYTES with a HEAD+TAIL window (no OOM
 *     on a runaway stream) — naive newest-only would lose the start.
 *   - get(unknown) ⇒ undefined, no throw.
 *
 * Red-on-injection: drop the `.catch` in detach (so a rejected body bubbles)
 * ⇒ the 'failed'/'cancelled' tests reject with an unhandled rejection instead
 * of observing the captured state.
 */

import { describe, expect, test } from "bun:test"
import { backgroundCmd } from "../background-cmd"
import {
  BG_BUFFER_MAX_BYTES,
  createBackgroundTurnPortal,
} from "../repl/background-turn-portal"
import type { SlashContext } from "../slash-contract"

/** Collect a slash command's stdout/stderr for assertions. */
const runBg = async (
  args: readonly string[],
  background: SlashContext["background"],
  now = 10_000,
): Promise<{ code: number; out: string; err: string }> => {
  let out = ""
  let err = ""
  const code = await backgroundCmd.run(args, {
    out: (s) => {
      out += s
    },
    err: (s) => {
      err += s
    },
    cwd: "/tmp",
    now: () => now,
    ...(background !== undefined ? { background } : {}),
  } as SlashContext)
  return { code, out, err }
}

/** Resolve once the portal entry has reached a settled state (the detach
 *  `.then/.catch` runs on a microtask after the body promise settles). */
const settle = async (
  portal: ReturnType<typeof createBackgroundTurnPortal>,
  id: string,
): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    const e = portal.get(id)
    if (e !== undefined && e.state !== "running") return
    await new Promise((r) => setTimeout(r, 1))
  }
}

describe("background-turn-portal — registry lifecycle", () => {
  test("detach registers a 'running' entry synchronously", () => {
    const portal = createBackgroundTurnPortal()
    let resolve: (v: { ok: true }) => void = () => {}
    const promise = new Promise<{ ok: true }>((r) => {
      resolve = r
    })
    const abort = new AbortController()
    const id = portal.detach({ label: "hello world", promise, abort })
    const entry = portal.get(id)
    expect(entry).toBeDefined()
    expect(entry?.state).toBe("running")
    expect(entry?.label).toBe("hello world")
    expect(typeof entry?.startedAt).toBe("number")
    expect(portal.list().map((e) => e.taskId)).toContain(id)
    resolve({ ok: true })
  })

  test("resolve ⇒ 'done' + result captured", async () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({
      label: "x",
      promise: Promise.resolve({ value: 42 }),
      abort,
    })
    await settle(portal, id)
    const entry = portal.get(id)
    expect(entry?.state).toBe("done")
    expect(entry?.result).toEqual({ value: 42 })
    expect(entry?.error).toBeUndefined()
  })

  test("reject (non-abort) ⇒ 'failed' + error captured", async () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const boom = new Error("kaboom")
    const id = portal.detach({ label: "x", promise: Promise.reject(boom), abort })
    await settle(portal, id)
    const entry = portal.get(id)
    expect(entry?.state).toBe("failed")
    expect(entry?.error).toBe(boom)
    expect(entry?.result).toBeUndefined()
  })

  test("reject with AbortError ⇒ 'cancelled' (not 'failed')", async () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const abortErr = new Error("aborted")
    abortErr.name = "AbortError"
    const id = portal.detach({
      label: "x",
      promise: Promise.reject(abortErr),
      abort,
    })
    await settle(portal, id)
    expect(portal.get(id)?.state).toBe("cancelled")
  })

  test("cancel(id) fires the entry's AbortController", () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({
      label: "x",
      promise: new Promise(() => {}),
      abort,
    })
    expect(abort.signal.aborted).toBe(false)
    portal.cancel(id)
    expect(abort.signal.aborted).toBe(true)
  })

  test("cancel(unknown) is a no-op (no throw)", () => {
    const portal = createBackgroundTurnPortal()
    expect(() => portal.cancel("nope")).not.toThrow()
  })

  test("get(unknown) ⇒ undefined (no throw)", () => {
    const portal = createBackgroundTurnPortal()
    expect(portal.get("nope")).toBeUndefined()
  })
})

describe("background-turn-portal — bounded buffer", () => {
  test("buffer caps at BG_BUFFER_MAX_BYTES with a HEAD+TAIL window (no OOM)", () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({
      label: "x",
      promise: new Promise(() => {}),
      abort,
    })
    const entry = portal.get(id)
    expect(entry).toBeDefined()
    if (entry === undefined) return
    // Append far more than the cap; the entry must never retain more than the cap.
    const head = "HEAD_MARKER_START"
    entry.appendOutput(head)
    const chunk = "y".repeat(1024 * 1024) // 1 MiB
    for (let i = 0; i < 80; i++) entry.appendOutput(chunk) // ~80 MiB > 50 MiB cap
    const tail = "TAIL_MARKER_END"
    entry.appendOutput(tail)
    const buffered = entry.bufferedBytes()
    expect(buffered).toBeLessThanOrEqual(BG_BUFFER_MAX_BYTES)
    const rendered = entry.readBuffer()
    // HEAD+TAIL window keeps BOTH ends (naive newest-only would lose the head).
    expect(rendered).toContain(head)
    expect(rendered).toContain(tail)
    // An elision marker signals the dropped middle.
    expect(rendered).toMatch(/elided/i)
  })

  test("BG_BUFFER_MAX_BYTES is the documented 50 MiB ceiling", () => {
    expect(BG_BUFFER_MAX_BYTES).toBe(50 * 1024 * 1024)
  })
})

describe("background-turn-portal — read-only view()", () => {
  test("view() exposes list/get/reattach/cancel and reattach is READ-ONLY", async () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({
      label: "task label",
      promise: Promise.resolve({ value: "done-result" }),
      abort,
    })
    await settle(portal, id)
    const view = portal.view()
    expect(view.list().map((r) => r.taskId)).toContain(id)
    expect(view.get(id)?.label).toBe("task label")
    const re = view.reattach(id)
    expect(re).toBeDefined()
    // reattach returns buffer + result; it must NOT re-enter the loop (no promise
    // re-await, no AbortController exposure that could mutate the live turn).
    expect(re?.result).toEqual({ value: "done-result" })
    expect(typeof re?.buffer).toBe("string")
    expect(re?.running).toBe(false)
  })

  test("view().reattach(unknown) ⇒ undefined; view().cancel(unknown) no-op", () => {
    const portal = createBackgroundTurnPortal()
    const view = portal.view()
    expect(view.reattach("nope")).toBeUndefined()
    expect(() => view.cancel("nope")).not.toThrow()
  })

  test("view().cancel(id) aborts the underlying entry", () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({
      label: "x",
      promise: new Promise(() => {}),
      abort,
    })
    portal.view().cancel(id)
    expect(abort.signal.aborted).toBe(true)
  })
})

describe("/background command — surface", () => {
  test("absent ctx.background ⇒ 'not wired' + exit 0 (default-OFF)", async () => {
    const r = await runBg(["list"], undefined)
    expect(r.code).toBe(0)
    expect(r.out).toContain("not wired")
  })

  test("list ⇒ shows the detached task id + label (running pill)", async () => {
    const portal = createBackgroundTurnPortal()
    portal.detach({ label: "fix the bug", promise: new Promise(() => {}), abort: new AbortController() })
    const r = await runBg(["list"], portal.view())
    expect(r.code).toBe(0)
    expect(r.out).toContain("fix the bug")
    expect(r.out.toLowerCase()).toContain("running")
  })

  test("list (default, no subcommand) ⇒ same as 'list'", async () => {
    const portal = createBackgroundTurnPortal()
    const r = await runBg([], portal.view())
    expect(r.code).toBe(0)
    expect(r.out.toLowerCase()).toContain("no background turns")
  })

  test("reattach <id> ⇒ prints buffer; running ⇒ 'still streaming' note (READ-ONLY)", async () => {
    const portal = createBackgroundTurnPortal()
    const id = portal.detach({
      label: "streaming task",
      promise: new Promise(() => {}),
      abort: new AbortController(),
    })
    portal.get(id)?.appendOutput("partial output so far")
    const r = await runBg(["reattach", id], portal.view())
    expect(r.code).toBe(0)
    expect(r.out).toContain("partial output so far")
    expect(r.out.toLowerCase()).toContain("still streaming")
  })

  test("reattach <unknown> ⇒ exit 1 + 'unknown task'", async () => {
    const portal = createBackgroundTurnPortal()
    const r = await runBg(["reattach", "nope"], portal.view())
    expect(r.code).toBe(1)
    expect(r.err).toContain("unknown task")
  })

  test("cancel <id> ⇒ aborts the entry + exit 0", async () => {
    const portal = createBackgroundTurnPortal()
    const abort = new AbortController()
    const id = portal.detach({ label: "x", promise: new Promise(() => {}), abort })
    const r = await runBg(["cancel", id], portal.view())
    expect(r.code).toBe(0)
    expect(abort.signal.aborted).toBe(true)
  })

  test("unknown subcommand ⇒ exit 1", async () => {
    const portal = createBackgroundTurnPortal()
    const r = await runBg(["frobnicate"], portal.view())
    expect(r.code).toBe(1)
    expect(r.err.toLowerCase()).toContain("unknown subcommand")
  })
})
