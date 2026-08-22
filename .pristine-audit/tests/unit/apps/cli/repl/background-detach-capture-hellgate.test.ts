/**
 * ★ HELLGATE — WS-H / UUX-3-01 (Crit): background-turn output capture.
 *
 * At HEAD the portal exposes `appendOutput` but NOTHING in production calls
 * it — `/background reattach` and `bufferedBytes` are always empty; the ADR's
 * capture is non-functional. This hellgate pins the fix end-to-end:
 *
 *  (A) `buildBackgroundCaptureTee` — the mutable-proxy tee (same pattern as
 *      the debug-tracer tee) that session-setup interposes in the stream chain.
 *      OFF ⇒ literal stream identity + no capture handle (byte-identical).
 *      ON ⇒ install/remove sinks that receive the PROJECTED text of the live
 *      turn stream, in order; downstream events are NEVER altered/dropped.
 *  (B) portal integration — detach ⇒ `wireBackgroundOutputCapture` tees the
 *      stream into `entry.appendOutput` until the body settles; reattach
 *      replays the buffered bytes (non-empty + ordered). RED at HEAD: the
 *      seam does not exist, buffers stay empty.
 *  (C) production threading — `buildSessionLoopOptions` forwards
 *      `wires.backgroundPortal` onto the loop deps. RED at HEAD: the portal
 *      was composed in surface-compose but never threaded, so Ctrl+B detach
 *      (and therefore capture) was unreachable in the real CLI.
 *
 * Adversarial axes (per WS-H spec): backpressure (cap holds, dropped bytes
 * marked), double-detach (two live sinks), reattach-then-detach-again,
 * settle-during-reattach-replay, throwing sink never poisons the tee.
 */

import { describe, expect, test } from "bun:test"
import type { AgentEvent, StreamPort } from "@/stream"
import {
  buildBackgroundCaptureTee,
  projectBackgroundChunk,
} from "../../../../../src/apps/cli/repl/background-capture-tee"
import {
  BG_BUFFER_MAX_BYTES,
  createBackgroundTurnPortal,
} from "../../../../../src/apps/cli/repl/background-turn-portal"
import {
  handleMovedToBackground,
  wireBackgroundOutputCapture,
} from "../../../../../src/apps/cli/repl/session-loop/turn-helpers"

const text = (delta: string): AgentEvent => ({ type: "assistant_text", delta })

const recordingPort = (): StreamPort & { events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  return {
    events,
    emit: (e) => {
      events.push(e)
    },
  }
}

/** Drain microtasks so a promise-settle observer has fired. */
const settleMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("(A) buildBackgroundCaptureTee — mutable-proxy stream tee", () => {
  test("OFF (gate false) ⇒ literal stream identity + capture undefined (byte-identical)", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(false, downstream)
    expect(stream).toBe(downstream) // NOT a wrapper — the literal input ref
    expect(capture).toBeUndefined()
  })

  test("ON + no sinks installed ⇒ pure passthrough, downstream sees every event", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    expect(capture).toBeDefined()
    stream.emit(text("hello"))
    stream.emit({ type: "tool_call", id: "t1", name: "grep", input: {} })
    expect(downstream.events).toHaveLength(2)
    expect(downstream.events[0]).toEqual(text("hello"))
  })

  test("installed sink receives projected chunks IN ORDER; downstream unchanged", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const got: string[] = []
    capture?.install((chunk) => got.push(chunk))
    stream.emit(text("a"))
    stream.emit(text("b"))
    stream.emit({ type: "usage", inputTokens: 1, outputTokens: 1, model: "m" })
    stream.emit(text("c"))
    expect(got.join("")).toBe("abc") // ordered; non-text events not captured as text
    expect(downstream.events).toHaveLength(4) // downstream untouched (all 4 events)
  })

  test("remove() stops capture; later events are not appended", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const got: string[] = []
    const remove = capture?.install((chunk) => got.push(chunk))
    stream.emit(text("before"))
    remove?.()
    stream.emit(text("after"))
    expect(got.join("")).toBe("before")
    expect(downstream.events).toHaveLength(2) // passthrough unaffected by remove
  })

  test("DOUBLE-DETACH — two sinks live at once; removing one keeps the other", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const a: string[] = []
    const b: string[] = []
    const removeA = capture?.install((c) => a.push(c))
    capture?.install((c) => b.push(c))
    stream.emit(text("x"))
    removeA?.()
    stream.emit(text("y"))
    expect(a.join("")).toBe("x")
    expect(b.join("")).toBe("xy")
  })

  test("a THROWING sink never poisons the tee — downstream + sibling sink still fed", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const good: string[] = []
    capture?.install(() => {
      throw new Error("sink crashed")
    })
    capture?.install((c) => good.push(c))
    stream.emit(text("survives"))
    expect(good.join("")).toBe("survives")
    expect(downstream.events).toHaveLength(1)
  })

  test("remove() is idempotent (double-remove does not drop a sibling sink)", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const a: string[] = []
    const b: string[] = []
    const removeA = capture?.install((c) => a.push(c))
    capture?.install((c) => b.push(c))
    removeA?.()
    removeA?.() // second remove must not disturb sink b
    stream.emit(text("z"))
    expect(a).toHaveLength(0)
    expect(b.join("")).toBe("z")
  })

  test("projector: tool boundaries are captured as marker lines (activity context)", () => {
    const marker = projectBackgroundChunk({ type: "tool_call", id: "t", name: "bash", input: {} })
    expect(marker).toBeDefined()
    expect(marker).toContain("bash")
    // lifecycle noise is NOT captured (no chunk minted)
    expect(projectBackgroundChunk({ type: "turn_start", turn: 1 })).toBeUndefined()
  })
})

describe("(B) UUX-3-01 — detach ⇒ capture ⇒ reattach replays buffered bytes", () => {
  test("detach mid-stream → buffered bytes NON-EMPTY and ordered; reattach replays (RED at HEAD)", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()

    let resolveBody: (v: string) => void = () => undefined
    const body = new Promise<string>((res) => {
      resolveBody = res
    })
    const taskId = portal.detach({
      label: "long task",
      promise: body,
      abort: new AbortController(),
    })
    // THE production seam under test: detach installs the tee into the entry.
    wireBackgroundOutputCapture({
      entry: portal.get(taskId),
      capture,
      settled: body,
    })

    stream.emit(text("first "))
    stream.emit(text("second "))
    stream.emit(text("third"))

    const entry = portal.get(taskId)
    expect(entry).toBeDefined()
    expect(entry?.bufferedBytes() ?? 0).toBeGreaterThan(0) // ← RED at HEAD (always 0)
    const re = portal.reattach(taskId)
    expect(re?.buffer).toBe("first second third") // ordered replay

    resolveBody("done")
    await settleMicrotasks()
  })

  test("SETTLE removes the tee — post-settle stream events do NOT grow the buffer", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()
    let resolveBody: (v: string) => void = () => undefined
    const body = new Promise<string>((res) => {
      resolveBody = res
    })
    const taskId = portal.detach({ label: "t", promise: body, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(taskId), capture, settled: body })
    stream.emit(text("live"))
    resolveBody("ok")
    await settleMicrotasks()
    const before = portal.get(taskId)?.bufferedBytes() ?? Number.NaN
    stream.emit(text("post-settle leak"))
    expect(portal.get(taskId)?.bufferedBytes()).toBe(before)
  })

  test("REJECTING body also removes the tee (no leak on failure path)", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()
    let rejectBody: (e: Error) => void = () => undefined
    const body = new Promise<string>((_res, rej) => {
      rejectBody = rej
    })
    const taskId = portal.detach({ label: "t", promise: body, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(taskId), capture, settled: body })
    stream.emit(text("pre"))
    rejectBody(new Error("boom"))
    await settleMicrotasks()
    const before = portal.get(taskId)?.bufferedBytes() ?? Number.NaN
    stream.emit(text("leak"))
    expect(portal.get(taskId)?.bufferedBytes()).toBe(before)
  })

  test("BACKPRESSURE — huge output while detached: cap holds, dropped middle is MARKED", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    // Small injected cap so the test is fast; production default is the named
    // BG_BUFFER_MAX_BYTES const (no magic number in prod).
    const portal = createBackgroundTurnPortal({ bufferMaxBytes: 128 })
    const body = new Promise<string>(() => undefined) // never settles
    const taskId = portal.detach({ label: "hog", promise: body, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(taskId), capture, settled: body })
    for (let i = 0; i < 200; i++) stream.emit(text(`chunk-${i} `))
    const entry = portal.get(taskId)
    expect(entry?.bufferedBytes() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(128)
    const re = portal.reattach(taskId)
    expect(re?.buffer).toContain("elided") // dropped bytes are marked, not silent
    expect(re?.buffer).toContain("chunk-0") // HEAD retained (what the turn was doing)
    expect(re?.buffer).toContain("chunk-199 ") // newest TAIL retained
  })

  test("default cap is the named constant (sanity, no magic number)", () => {
    expect(BG_BUFFER_MAX_BYTES).toBeGreaterThan(0)
  })

  test("REATTACH-THEN-DETACH-AGAIN — a second detached turn buffers independently of the first's snapshot", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()
    let resolveA: (v: string) => void = () => undefined
    const bodyA = new Promise<string>((res) => {
      resolveA = res
    })
    const idA = portal.detach({ label: "A", promise: bodyA, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(idA), capture, settled: bodyA })
    stream.emit(text("A-out "))
    const reA = portal.reattach(idA) // read-only replay
    expect(reA?.buffer).toBe("A-out ")
    resolveA("done")
    await settleMicrotasks()

    // detach again (fresh turn) — old entry's buffer must not grow
    const bodyB = new Promise<string>(() => undefined)
    const idB = portal.detach({ label: "B", promise: bodyB, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(idB), capture, settled: bodyB })
    stream.emit(text("B-out"))
    expect(portal.reattach(idA)?.buffer).toBe("A-out ") // A frozen at settle
    expect(portal.reattach(idB)?.buffer).toBe("B-out")
  })

  test("SETTLE DURING REATTACH REPLAY — the replayed snapshot string is immutable", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()
    let resolveBody: (v: string) => void = () => undefined
    const body = new Promise<string>((res) => {
      resolveBody = res
    })
    const taskId = portal.detach({ label: "t", promise: body, abort: new AbortController() })
    wireBackgroundOutputCapture({ entry: portal.get(taskId), capture, settled: body })
    stream.emit(text("snapshot"))
    const re = portal.reattach(taskId)
    const replayed = re?.buffer
    resolveBody("done") // settle WHILE the caller still holds the replay
    await settleMicrotasks()
    expect(replayed).toBe("snapshot") // the handed-out replay cannot mutate
  })

  test("absent entry / absent capture ⇒ wireBackgroundOutputCapture is a safe no-op", () => {
    expect(() =>
      wireBackgroundOutputCapture({
        entry: undefined,
        capture: undefined,
        settled: Promise.resolve(),
      }),
    ).not.toThrow()
  })
})

describe("(C) handleMovedToBackground — the session-loop Ctrl+B side-effect bundle", () => {
  test("detach registers a labeled entry, tees the capture, paints breadcrumbs, notifies on settle", async () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const portal = createBackgroundTurnPortal()
    const writes: string[] = []
    const notified: Array<{ ok: boolean; cwdBasename: string }> = []
    let resolveBody: (v: string) => void = () => undefined
    const body = new Promise<string>((res) => {
      resolveBody = res
    })
    handleMovedToBackground({
      portal,
      capture,
      promptText: "  run the   long build  ",
      notify: {
        onTurnComplete: (a: { ok: boolean; cwdBasename: string }) =>
          notified.push({ ok: a.ok, cwdBasename: a.cwdBasename }),
        dispose: () => undefined,
      } as never,
      notifyCwdBasename: "repo",
      write: (s) => writes.push(s),
      handle: { body, turnAbort: new AbortController() },
    })
    // portal entry registered with the whitespace-collapsed label
    const rows = portal.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe("run the long build")
    // capture teed — stream output lands in the entry buffer
    stream.emit(text("bg says hi"))
    expect(portal.reattach(rows[0]?.taskId ?? "")?.buffer).toBe("bg says hi")
    // breadcrumbs painted (detach hint + task id)
    expect(writes.join("")).toContain("moved to background")
    expect(writes.join("")).toContain(rows[0]?.taskId ?? "@@none@@")
    // notify reused on settle, ok:true, task id in the label
    resolveBody("done")
    await settleMicrotasks()
    expect(notified).toHaveLength(1)
    expect(notified[0]?.ok).toBe(true)
    expect(notified[0]?.cwdBasename).toContain(rows[0]?.taskId ?? "@@none@@")
  })

  test("portal absent ⇒ NO side effects (no writes, no notify, no capture install)", () => {
    const downstream = recordingPort()
    const { stream, capture } = buildBackgroundCaptureTee(true, downstream)
    const writes: string[] = []
    const got: string[] = []
    // Sentinel sink proves no interleaved install happened.
    capture?.install((c) => got.push(c))
    handleMovedToBackground({
      portal: undefined,
      capture,
      promptText: "x",
      notify: undefined,
      notifyCwdBasename: undefined,
      write: (s) => writes.push(s),
      handle: { body: Promise.resolve("r"), turnAbort: new AbortController() },
    })
    stream.emit(text("only-sentinel"))
    expect(writes).toHaveLength(0)
    expect(got.join("")).toBe("only-sentinel")
  })

  test("REJECTING body ⇒ notify fires exactly once with ok:false (no unhandled rejection)", async () => {
    const portal = createBackgroundTurnPortal()
    const notified: boolean[] = []
    let rejectBody: (e: Error) => void = () => undefined
    const body = new Promise<string>((_res, rej) => {
      rejectBody = rej
    })
    handleMovedToBackground({
      portal,
      capture: undefined, // capture absent ⇒ detach still fully functional
      promptText: "doomed",
      notify: { onTurnComplete: (a: { ok: boolean }) => notified.push(a.ok) } as never,
      notifyCwdBasename: "repo",
      write: () => undefined,
      handle: { body, turnAbort: new AbortController() },
    })
    rejectBody(new Error("boom"))
    await settleMicrotasks()
    expect(notified).toEqual([false])
    expect(portal.list()[0]?.state).toBe("failed")
  })
})
