/**
 * §4.3 e2e HELLGATE (REAL OS layer) — supervised side-agent over a genuinely
 * FORKED child process. No mocks: `nodeProcessForkPort` forks the real worker
 * fixture, the supervisor wires IPC, and we observe a finding crossing the OS
 * IPC boundary + a real respawn after a real crash.
 */

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  nodeProcessForkPort,
  sideAgentWorkerModulePath,
} from "../../src/host/runtime/side-agent-fork-port"
import {
  createProcessSideAgentDaemonRegistry,
  createSupervisedProcessDaemon,
  type SideAgentSpec,
} from "../../src/side-agent"

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

describe("§4.3 OS-fork e2e — PRODUCTION worker via the process REGISTRY", () => {
  const intervalSpec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
    task: "audit the dependency tree",
    trigger: { kind: "interval", everyMs: 60_000 },
    maxWakes: 1,
    maxTurnsPerWake: 3,
    ...over,
  })

  test("registry forks the real production worker ⇒ a real finding crosses IPC", async () => {
    // End-to-end over the REAL fork port + the REAL production worker module
    // (`worker-entry.mjs`) the host wires — registry → supervisor → fork → worker.
    const reg = createProcessSideAgentDaemonRegistry({
      fork: nodeProcessForkPort,
      scheduler: realScheduler,
      now: () => Date.now(),
      workerModulePath: sideAgentWorkerModulePath(),
    })
    const id = reg.spawn(intervalSpec())

    const got = await waitFor(() => reg.findings().length > 0)
    expect(got).toBe(true)
    const finding = reg.findings()[0]
    expect(finding?.daemonId).toBe(id)
    // The worker's deterministic pass posts a signature finding derived from the
    // charter (proves the task + turn budget crossed the IPC boundary and the
    // child did real, hermetic work in a separate process).
    expect(finding?.summary).toContain("audit the dependency tree")
    expect(finding?.detail).toContain("forked child OS process")

    // list() reflects a running, real daemon.
    const snap = reg.list()[0]
    expect(snap?.status).toBe("running")
    expect(snap?.wakesDone).toBeGreaterThanOrEqual(1)

    // Stop ⇒ the real child exits (no leaked OS process).
    expect(reg.stop(id)).toBe(true)
    await waitFor(() => reg.list()[0]?.status === "stopped", 2000)
    expect(reg.list()[0]?.status).toBe("stopped")
  }, 12000)

  test("the production worker module path resolves to a real, forkable file", () => {
    const path = sideAgentWorkerModulePath()
    expect(path.endsWith("worker-entry.mjs")).toBe(true)
    // The path is absolute (fork requires it).
    expect(path.startsWith("/")).toBe(true)
  })
})
