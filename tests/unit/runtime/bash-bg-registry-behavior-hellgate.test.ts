/**
 * D1/D2 — `bash-bg-registry` behavioral hellgate (src/runtime/bash-bg-registry.ts).
 *
 * Two behaviors the slice-level guards do NOT directly cover:
 *
 *  (a) D1 PID-REUSE HAZARD — `evictOldest` must NOT kill a COMPLETED (already
 *      reaped) background shell. Re-killing a long-dead pid risks SIGKILL-ing a
 *      RECYCLED pid 2s later. The registry guards this with
 *      `if (handle.status === "running") handle.kill()`. We inject a fake spawner
 *      whose subprocess records every `kill()` and assert eviction of a TERMINAL
 *      (completed) entry NEVER calls it — while eviction of a STILL-RUNNING entry
 *      DOES (red-on-injection: drop the `status === "running"` guard and the
 *      completed-entry assertion goes RED).
 *
 *  (b) D2 BOUNDED BUFFER — a flooding background shell's retained snapshot stays
 *      bounded (uses `createBoundedBuffer(MAX_BG_BUFFER_BYTES)`), so a `yes` /
 *      `tail -f` cannot grow the accumulator without bound. We stream far more
 *      than the cap through the fake subprocess's stdout and assert the snapshot
 *      is bounded (head+tail+marker), NOT O(total streamed).
 *
 * The registry IS injectable in isolation: `createBashBgRegistry({ port,
 * maxEntries })` takes a closed-port spawner and a cap. A fake subprocess whose
 * handle exposes NO numeric `pid` makes `escalatingKill` fall back to the
 * single-PID `proc.kill()` — so the fake's `kill` spy is the observable.
 */

import { describe, expect, test } from "bun:test"
import {
  type BashProcessHandlePort,
  type BashSubprocess,
  createBashBgRegistry,
  MAX_BG_BUFFER_BYTES,
} from "@/runtime/bash-bg-registry"

/** A controllable fake subprocess. `kill` is the spy; the streams + `exited` are
 *  driven by the test so we can pin a shell as `running` or `completed`. NO
 *  numeric `pid` ⇒ escalatingKill uses the single-PID `proc.kill()` (our spy). */
interface FakeProc extends BashSubprocess {
  killCount: number
  /** Resolve the child's exit (so the registry flips status → "completed"). */
  finish: (code: number) => void
}

/** Build a fake subprocess whose stdout yields `chunks` (then closes) and whose
 *  `exited` resolves only when the test calls `finish`. */
const makeFakeProc = (chunks: readonly string[]): FakeProc => {
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((res) => {
    exitResolve = res
  })
  const enc = new TextEncoder()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  const proc: FakeProc = {
    killCount: 0,
    stdout,
    stderr,
    exited,
    kill() {
      proc.killCount += 1
    },
    finish: (code: number) => exitResolve(code),
  }
  return proc
}

/** A port that hands out a queue of pre-built fake procs in registration order. */
const queuePort = (procs: FakeProc[]): BashProcessHandlePort => {
  let i = 0
  return {
    async spawn() {
      const p = procs[i++]
      if (p === undefined) throw new Error("queuePort exhausted")
      return p
    },
  }
}

/** Spin the event loop until `pred()` or a bounded number of ticks elapses. The
 *  drain + exit-resolver in `register` runs on macrotasks; we yield enough. */
const settle = async (pred: () => boolean, max = 200): Promise<void> => {
  for (let i = 0; i < max && !pred(); i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

describe("evictOldest — terminal-entry kill ban (D1 PID-reuse hazard)", () => {
  test("a COMPLETED oldest shell is evicted WITHOUT calling its killer (no SIGKILL of a recycled pid)", async () => {
    const oldest = makeFakeProc(["hello\n"])
    const filler = makeFakeProc([])
    const registry = createBashBgRegistry({ port: queuePort([oldest, filler]), maxEntries: 1 })

    // Register + let the first shell run to completion (drain closes, exit fires).
    const h = await registry.register({ command: "echo hello", cwd: "/tmp" })
    oldest.finish(0)
    await settle(() => registry.get(h.id)?.status === "completed")
    expect(registry.get(h.id)?.status).toBe("completed")
    expect(oldest.killCount).toBe(0)

    // A second register overflows maxEntries=1 ⇒ evicts the COMPLETED oldest.
    await registry.register({ command: "echo two", cwd: "/tmp" })

    // The terminal entry was dropped but its killer was NEVER invoked.
    expect(registry.get(h.id)).toBeNull() // evicted
    expect(oldest.killCount).toBe(0) // no kill on a reaped (completed) shell
  })

  test("a STILL-RUNNING oldest shell IS killed on eviction (the guard does not over-suppress)", async () => {
    const oldest = makeFakeProc([]) // never `finish`ed ⇒ stays running
    const filler = makeFakeProc([])
    const registry = createBashBgRegistry({ port: queuePort([oldest, filler]), maxEntries: 1 })

    const h = await registry.register({ command: "sleep 999", cwd: "/tmp" })
    // Do NOT finish ⇒ status stays "running".
    expect(registry.get(h.id)?.status).toBe("running")

    // Overflow ⇒ evict the RUNNING oldest ⇒ it MUST be killed (else it orphans).
    const second = registry.register({ command: "echo two", cwd: "/tmp" })
    // The kill fires synchronously inside evictOldest before the await on exited;
    // allow the running shell's exit to resolve so the await settles.
    await settle(() => oldest.killCount > 0)
    oldest.finish(0) // let evictOldest's `await handle.exited` resolve
    await second

    expect(oldest.killCount).toBeGreaterThanOrEqual(1) // running shell WAS killed
    expect(registry.get(h.id)).toBeNull() // and evicted
  })
})

describe("bounded snapshot — a flooding bg shell stays bounded (D2 OOM fix)", () => {
  test("streaming far past MAX_BG_BUFFER_BYTES keeps the snapshot bounded, not O(total)", async () => {
    // Stream ~4x the cap in 64KB chunks. The retained snapshot must be bounded by
    // the head+tail budget + an elision marker, NOT the full streamed size.
    const CHUNK = "A".repeat(64 * 1024)
    const chunkCount = Math.ceil((MAX_BG_BUFFER_BYTES * 4) / CHUNK.length)
    const totalStreamed = CHUNK.length * chunkCount
    const proc = makeFakeProc(Array.from({ length: chunkCount }, () => CHUNK))
    const registry = createBashBgRegistry({ port: queuePort([proc]), maxEntries: 4 })

    const h = await registry.register({ command: "yes", cwd: "/tmp" })
    proc.finish(0)
    await settle(() => registry.get(h.id)?.status === "completed")

    const snap = registry.get(h.id)
    expect(snap).not.toBeNull()
    const out = snap?.stdout ?? ""
    // Bounded: well under the verbatim budget + a little marker room — NOT 800KB+.
    expect(out.length).toBeLessThanOrEqual(MAX_BG_BUFFER_BYTES + 1024)
    // And strictly less than what was actually streamed (proof of elision).
    expect(out.length).toBeLessThan(totalStreamed)
    // The middle was elided (the buffer reports the drop in its rendered marker).
    expect(out).toContain("bytes elided")
  })

  test("a small under-budget bg shell is preserved VERBATIM (no premature elision)", async () => {
    const proc = makeFakeProc(["line one\n", "line two\n", "done\n"])
    const registry = createBashBgRegistry({ port: queuePort([proc]), maxEntries: 4 })
    const h = await registry.register({ command: "echo ...", cwd: "/tmp" })
    proc.finish(0)
    await settle(() => registry.get(h.id)?.status === "completed")
    expect(registry.get(h.id)?.stdout).toBe("line one\nline two\ndone\n")
  })
})
