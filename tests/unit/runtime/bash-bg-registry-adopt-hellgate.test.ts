/**
 * ADR-0296 auto-background — `BashBgRegistry.adopt` hellgate.
 *
 * `adopt` is the seam `runShell` uses when a foreground command hits its
 * deadline: it hands the STILL-RUNNING child (its kill/disarm closures, the
 * live output buffers it keeps appending to, the exit-code promise, and the
 * drain-completion promise) to the registry, which owns the terminal lifecycle
 * from there. Unlike `register`, adopt does NOT spawn — so these tests need no
 * spawner port; they drive the lifecycle promises directly.
 *
 * Axes:
 *  1. LIFECYCLE — adopted handle starts `running`, exposes the LIVE buffer
 *     content, and on drains+exit flips `running → completed` with the exit code
 *     latched + `disarm` called exactly once.
 *  2. LIVE BUFFER — `snapshot`/`get` read the same buffer instance the caller
 *     keeps appending to (a post-adopt append is visible).
 *  3. CAP-EVICT — adopt honors `maxEntries`: an overflowing adopt evicts +
 *     KILLS the oldest still-running handle (red-on-injection: the kill spy).
 *  4. KILLALL REAP — `killAll` terminates an adopted running shell (session-end
 *     cleanup covers adopted children, not just spawned ones).
 */

import { describe, expect, test } from "bun:test"
import { createBashBgRegistry } from "@/runtime/bash-bg-registry"
import { createBoundedBuffer } from "@/runtime/bounded-buffer"

/** Spin macrotasks until `pred()` or a bounded number of ticks elapses (the
 *  adopt lifecycle's status flip runs on a microtask chain off the resolvers). */
const settle = async (pred: () => boolean, max = 200): Promise<void> => {
  for (let i = 0; i < max && !pred(); i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

/** A controllable adopted child: `kill` is the spy and (mirroring the real
 *  escalating-kill → process-exit chain) resolves `exited` so an `evictOldest` /
 *  `killAll` that awaits the handle's exit does not hang. */
const makeAdoptable = (initialStdout = "") => {
  const stdout = createBoundedBuffer(200_000)
  const stderr = createBoundedBuffer(200_000)
  if (initialStdout.length > 0) stdout.append(initialStdout)
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((res) => {
    exitResolve = res
  })
  let drainsResolve!: () => void
  const drainsDone = new Promise<void>((res) => {
    drainsResolve = res
  })
  const spy = { kills: 0, disarms: 0 }
  return {
    stdout,
    stderr,
    exited,
    drainsDone,
    spy,
    kill: () => {
      spy.kills += 1
      // Real chain: kill → pipes close (drains resolve) → child reaped. Both
      // must settle or an `evictOldest`/`killAll` that awaits the handle hangs.
      drainsResolve()
      exitResolve(137)
    },
    disarm: () => {
      spy.disarms += 1
    },
    finish: (code: number) => {
      drainsResolve()
      exitResolve(code)
    },
    adoptArgs(command = "sleep 1", cwd = "/tmp") {
      return {
        command,
        cwd,
        kill: this.kill,
        disarm: this.disarm,
        stdout: this.stdout,
        stderr: this.stderr,
        exited: this.exited,
        drainsDone: this.drainsDone,
      }
    },
  }
}

describe("adopt — lifecycle (running → completed, exit-code latch, disarm-once)", () => {
  test("an adopted shell starts running, then completes with the exit code + a single disarm", async () => {
    const child = makeAdoptable("hello\n")
    const reg = createBashBgRegistry({ maxEntries: 4 })

    const { id, snapshot } = await reg.adopt(child.adoptArgs("sleep 1"))
    expect(snapshot.status).toBe("running")
    expect(snapshot.exitCode).toBeNull()
    expect(reg.get(id)?.status).toBe("running")
    // LIVE buffer — the content the caller had already appended is visible.
    expect(reg.get(id)?.stdout).toContain("hello")

    // Drain finishes + child exits 0 ⇒ flips to completed with the code latched.
    child.finish(0)
    await settle(() => reg.get(id)?.status === "completed")
    expect(reg.get(id)?.status).toBe("completed")
    expect(reg.get(id)?.exitCode).toBe(0)
    expect(child.spy.disarms).toBe(1) // exactly once, never the kill path
    expect(child.spy.kills).toBe(0)
  })

  test("LIVE buffer — a post-adopt append into the shared buffer is reflected in the snapshot", async () => {
    const child = makeAdoptable("before\n")
    const reg = createBashBgRegistry({ maxEntries: 4 })
    const { id } = await reg.adopt(child.adoptArgs())

    expect(reg.get(id)?.stdout).toBe("before\n")
    // The drain (caller-owned) appends more while the registry holds the handle.
    child.stdout.append("after\n")
    expect(reg.get(id)?.stdout).toBe("before\nafter\n")
  })
})

describe("adopt — cap-and-evict (red-on-injection: the oldest's kill spy)", () => {
  test("an overflowing adopt evicts AND kills the oldest still-running adopted shell", async () => {
    const reg = createBashBgRegistry({ maxEntries: 1 })
    const oldest = makeAdoptable()
    const newer = makeAdoptable()

    const a = await reg.adopt(oldest.adoptArgs("sleep 999"))
    expect(reg.get(a.id)?.status).toBe("running")
    expect(oldest.spy.kills).toBe(0)

    // Overflow maxEntries=1 ⇒ evict the oldest. evictOldest kills the RUNNING
    // handle (our kill spy → resolves its exited so the await inside settles).
    const b = await reg.adopt(newer.adoptArgs("echo two"))

    expect(oldest.spy.kills).toBe(1) // running ⇒ killed exactly once (no re-kill)
    expect(reg.get(a.id)).toBeNull() // evicted
    expect(reg.get(b.id)?.status).toBe("running") // newest survives
    // cleanup
    newer.finish(0)
  })
})

describe("adopt — killAll reaps adopted shells (session-end cleanup)", () => {
  test("killAll terminates an adopted RUNNING shell and clears the registry", async () => {
    const reg = createBashBgRegistry({ maxEntries: 4 })
    const child = makeAdoptable()
    // Drains are done but the child has not exited (a detached `tail -f`).
    const args = child.adoptArgs("tail -f log")
    // Resolve drains immediately; leave `exited` pending until killAll kills it.
    const noDrains = Promise.resolve()
    const { id } = await reg.adopt({ ...args, drainsDone: noDrains })
    expect(reg.get(id)?.status).toBe("running")

    await reg.killAll()

    expect(child.spy.kills).toBeGreaterThanOrEqual(1) // killAll signalled it
    expect(reg.get(id)).toBeNull() // registry cleared
    expect(reg.size()).toBe(0)
  })
})
