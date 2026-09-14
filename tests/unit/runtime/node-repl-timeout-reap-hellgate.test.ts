/**
 * ★ HELLGATE — node-repl exec-timeout child reaping (audit U2).
 *
 * `markDead` (the teardown taken on a read-timeout / write-failure) used to only
 * flip state to "dead" + drop the on-disk handle — it never killed the spawned
 * `node -i` child nor removed the kernel from the in-memory Map. So every exec
 * that hit its `timeoutMs` (the designed bound for runaway code) orphaned a live
 * node process + its piped fds for the host's lifetime, and the dead kernel was
 * retained in `list()`. FIX: markDead now calls `k.proc.kill()` AND evicts the
 * Map entry, so a timed-out kernel is fully reaped.
 *
 * This drives a REAL `node -i` child (the slice is a thin spawn wrapper; faking
 * it would not exercise the kill/evict path) and asserts the OS process is gone.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { KILL_GRACE_MS } from "@/runtime/guarded-spawn"
import { createDefaultNodeReplKernel } from "@/runtime/node-repl/default-kernel"
import { quantaHomeDir } from "@/shared/quanta-home"

/** `process.kill(pid, 0)` probes liveness without signalling: throws ESRCH once
 *  the process is gone. Poll briefly so the OS has a tick to reap after SIGTERM. */
const waitDead = async (pid: number, budgetMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // ESRCH ⇒ reaped
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("node-repl exec-timeout reaps the child (U2)", () => {
  test("a timed-out runaway exec KILLS the child + EVICTS the kernel (no zombie, no Map leak)", async () => {
    const kernel = createDefaultNodeReplKernel()
    const spawned = await kernel.spawn({ sessionId: "reap-1" })
    expect(spawned.ok).toBe(true)
    if (!spawned.ok) return
    const { id, pid } = spawned.value
    expect(kernel.list().some((k) => k.spec.id === id)).toBe(true)
    expect(await waitDead(pid, 200)).toBe(false) // alive before the timeout
    // With no `home`, the on-disk handle lands in the QUANTA home — the preload's scratch
    // one. The default used to be the OS home's `.quanta`, so this test wrote a handle
    // into the developer's real store on every run.
    const handle = join(quantaHomeDir(), "node_repl", "active_execs", `${id}.json`)
    expect(existsSync(handle)).toBe(true)

    // A synchronous infinite loop never reaches the sentinel ⇒ read-timeout fires. The
    // kernel installs no SIGTERM handler, so the OS default action terminates even a
    // CPU-spinning child when markDead issues proc.kill() — exactly the reap we assert.
    const res = await kernel.exec(id, "while (true) {}", { timeoutMs: 400 })
    // Timed out — and said so: this used to be `kernel-dead`, which the tool rendered as
    // "process exited" (round-10 audit).
    expect(res.ok ? "ok" : res.error).toEqual({ kind: "exec-timeout", id, timeoutMs: 400 })

    // THE FIX — observable contract of markDead:
    expect(kernel.list().some((k) => k.spec.id === id)).toBe(false) // Map evicted
    expect(kernel.status(id)).toBe("dead")
    expect(existsSync(handle)).toBe(false) // …and the handle with it
    // …and the OS child is actually gone (the part the old markDead skipped).
    expect(await waitDead(pid)).toBe(true)

    // A follow-up exec on the reaped id fails fast (kernel-dead), never hangs.
    const after = await kernel.exec(id, "1 + 1", { timeoutMs: 1_000 })
    expect(after.ok).toBe(false)
  })

  test("kill() reaps + evicts too (explicit-teardown control path)", async () => {
    const kernel = createDefaultNodeReplKernel()
    const spawned = await kernel.spawn({ sessionId: "reap-2" })
    expect(spawned.ok).toBe(true)
    if (!spawned.ok) return
    const { id, pid } = spawned.value
    await kernel.kill(id)
    expect(kernel.list().some((k) => k.spec.id === id)).toBe(false)
    expect(kernel.status(id)).toBe("dead")
    expect(await waitDead(pid)).toBe(true)
    await kernel.kill(id) // idempotent — no throw on a second kill
  })

  // Round-11 audit B2 (reproduced on Node 22 and 25): the REPL runs model-authored code, and
  // `process.on('SIGTERM', () => {})` kept a timed-out kernel alive at 99% CPU, reparented
  // to pid 1 and gone from list(), while the tool said it was stopped. The stop now sends
  // SIGTERM to the tree and SIGKILL after the grace window.
  const forceKill = (pid: number): void => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
  const ignoringSigterm = async (sessionId: string) => {
    const kernel = createDefaultNodeReplKernel()
    const spawned = await kernel.spawn({ sessionId })
    if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned.error)}`)
    const armed = await kernel.exec(spawned.value.id, "process.on('SIGTERM', () => {}); 1", {
      timeoutMs: 5_000,
    })
    expect(armed.ok).toBe(true)
    return { kernel, ...spawned.value }
  }

  test("RED: a timed-out kernel whose code ignores SIGTERM is still stopped", async () => {
    const { kernel, id, pid } = await ignoringSigterm("reap-term")
    try {
      const res = await kernel.exec(id, "while (true) {}", { timeoutMs: 400 })
      expect(res.ok ? "ok" : res.error.kind).toBe("exec-timeout")
      expect(await waitDead(pid, KILL_GRACE_MS + 3_000)).toBe(true)
    } finally {
      forceKill(pid)
    }
  }, 20_000)

  test("RED: kill() stops a kernel that ignores SIGTERM too", async () => {
    const { kernel, id, pid } = await ignoringSigterm("reap-term-kill")
    try {
      await kernel.kill(id)
      expect(await waitDead(pid, KILL_GRACE_MS + 3_000)).toBe(true)
    } finally {
      forceKill(pid)
    }
  }, 20_000)

  test("a healthy exec still completes (the reap path does not break normal use)", async () => {
    const kernel = createDefaultNodeReplKernel()
    const spawned = await kernel.spawn({ sessionId: "reap-3" })
    expect(spawned.ok).toBe(true)
    if (!spawned.ok) return
    const { id, pid } = spawned.value
    // PRIMARY guard (deterministic): the reap path did not break normal exec —
    // every healthy exec returns ok:true and the kernel stays live + reusable.
    // The stdout content of a real `node -i` REPL is timing-racy because its
    // console chunk may flush after the sentinel. This reap-path test therefore
    // asserts the deterministic contract: every sentinel completes and the
    // same child remains live and reusable.
    for (let i = 0; i < 5; i++) {
      const res = await kernel.exec(id, `console.log("REAP_OK_" + (20 + ${i + 1}))`, {
        timeoutMs: 5_000,
      })
      expect(res.ok).toBe(true) // strict: exec must succeed every time
      expect(kernel.list().some((k) => k.spec.id === id)).toBe(true) // strict: still live/reusable
    }
    await kernel.kill(id) // cleanup so the test leaves no child behind
    expect(await waitDead(pid)).toBe(true)
  })
})
