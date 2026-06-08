/**
 * §4.3 e2e HELLGATE (REAL OS layer) — supervised side-agent over a genuinely
 * FORKED child process. No mocks: `nodeProcessForkPort` forks the real worker
 * fixture, the supervisor wires IPC, and we observe a finding crossing the OS
 * IPC boundary + a real respawn after a real crash.
 */

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { nodeProcessForkPort } from "../../src/host/runtime/side-agent-fork-port"
import { createSupervisedProcessDaemon } from "../../src/side-agent"

const WORKER = fileURLToPath(new URL("../fixtures/side-agent-worker.mjs", import.meta.url))

/** Poll until `pred()` or timeout. */
const waitFor = async (pred: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

/** Real one-shot scheduler (node timers). */
const realScheduler = {
  schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
}

describe("§4.3 OS-fork e2e — real child process IPC", () => {
  test("fork a real worker ⇒ finding crosses the IPC boundary", async () => {
    const findings: { summary: string; detail?: string }[] = []
    const d = createSupervisedProcessDaemon({
      task: "check the build",
      maxTurnsPerWake: 2,
      fork: nodeProcessForkPort,
      forkSpec: { modulePath: WORKER, args: ["normal"] },
      now: () => Date.now(),
      scheduler: realScheduler,
      onFinding: (f) => void findings.push(f),
    })
    d.start()
    const got = await waitFor(() => findings.length > 0)
    expect(got).toBe(true)
    expect(findings[0]).toEqual({ summary: "worked on: check the build", detail: "turns=2" })
    expect(d.status()).toBe("running")
    d.stop()
    // Give the child a tick to observe the kill.
    await waitFor(() => d.status() === "stopped")
    expect(d.status()).toBe("stopped")
  })

  test("real crash ⇒ supervised respawn (a NEW pid forks)", async () => {
    const statuses: string[] = []
    const d = createSupervisedProcessDaemon({
      task: "crashy charter",
      maxTurnsPerWake: 1,
      fork: nodeProcessForkPort,
      forkSpec: { modulePath: WORKER, args: ["crash"] },
      now: () => Date.now(),
      scheduler: realScheduler,
      onFinding: () => {},
      baseBackoffMs: 20,
      backoffCapMs: 50,
      maxRestarts: 2,
      onStatus: (s) => void statuses.push(s),
    })
    d.start()
    const firstPid = d.pid()
    // The worker crashes immediately ⇒ supervisor should back off + respawn,
    // then eventually give up at maxRestarts.
    const settled = await waitFor(() => d.status() === "crashed-permanently", 8000)
    expect(settled).toBe(true)
    expect(d.restarts()).toBe(2)
    // We observed at least one backing-off transition (a real respawn cycle).
    expect(statuses).toContain("backing-off")
    // The first fork's pid was real.
    expect(typeof firstPid).toBe("number")
  }, 10000)
})
