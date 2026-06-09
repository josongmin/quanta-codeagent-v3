/**
 * §4.3 HELLGATE — `maybeWireSideAgent` PROCESS-backer SELECTION.
 *
 * Proves the live wire SELECTS the OS-process registry when, on top of
 * `QUANTA_SIDE_AGENT=1`, `QUANTA_SIDE_AGENT_PROCESS=1` is also set
 * (`runtimeConfig().sideAgentProcess`), and the EXACT legacy in-process path
 * otherwise. The two backers are structurally identical (both
 * `SideAgentDaemonRegistry`), so we distinguish them BEHAVIORALLY:
 *
 *   - PROCESS ON  ⇒ `spawn` FORKS the real production worker
 *     (`worker-entry.mjs`), which beacons ready, runs a real (deterministic)
 *     bounded pass, and pushes a `finding` over IPC ⇒ `findings()` surfaces it.
 *     (The worker is hermetic — no LLM/network — so this is fast + deterministic.)
 *   - PROCESS OFF ⇒ the in-process backer is wired: `spawn` runs the in-process
 *     subagent pass on the MAIN thread. With the test's throwing fake LLM that
 *     pass yields nothing AND no OS child is ever forked, so the worker's
 *     signature finding NEVER appears (the distinguisher).
 *
 * RED-ON-INJECTION: if the assembler ignored `sideAgentProcess` and always wired
 * in-process, the PROCESS-ON test would never see a worker finding and fail; if
 * it always wired the process backer, the OFF test would fork a worker and see
 * the signature finding and fail.
 *
 * Env hygiene: `QUANTA_SIDE_AGENT` is read from the INJECTED env bag, but
 * `QUANTA_SIDE_AGENT_PROCESS` is read via `runtimeConfig()` (process.env, cached),
 * so we set/restore `process.env` + `__resetRuntimeConfig()` around each case.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { __resetRuntimeConfig } from "@/shared"
import type { SideAgentDaemonPort, SideAgentSpawnInput } from "@/tool/side-agent"

const baseReq = (sessionId: string): AssembleRequest["base"] => ({
  llm: {
    stream() {
      throw new Error("unexpected stream()")
    },
  } as unknown as AgentConfig["llm"],
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

/** Spawn one interval daemon over the wired registry + return its id. */
const spawnDaemon = (reg: SideAgentDaemonPort): string => {
  const spec: SideAgentSpawnInput = {
    task: "process-wire-probe",
    trigger: { kind: "interval", every_ms: 60_000 },
    max_wakes: 1,
    max_turns_per_wake: 1,
  }
  // The registry's `spawn` takes the SideAgentSpec view (camelCase); map it.
  return reg.spawn({
    task: spec.task,
    trigger: {
      kind: "interval",
      everyMs: spec.trigger.kind === "interval" ? spec.trigger.every_ms : 0,
    },
    maxWakes: spec.max_wakes,
    maxTurnsPerWake: spec.max_turns_per_wake,
  })
}

const waitFor = async (pred: () => boolean, timeoutMs = 6000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return pred()
}

const WORKER_SIGNATURE = "side-agent process pass:"

afterEach(() => {
  delete process.env.QUANTA_SIDE_AGENT_PROCESS
  __resetRuntimeConfig()
})

describe("§4.3 maybeWireSideAgent — process backer selection", () => {
  test("PROCESS ON ⇒ spawn forks the real worker; a finding crosses IPC", async () => {
    process.env.QUANTA_SIDE_AGENT_PROCESS = "1"
    __resetRuntimeConfig()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-proc-on") },
      { QUANTA_SIDE_AGENT: "1" },
    )
    const reg = cfg.sideAgentDaemons as SideAgentDaemonPort | undefined
    expect(reg).toBeDefined()
    if (reg === undefined) throw new Error("expected sideAgentDaemons wired")

    spawnDaemon(reg)
    // The forked worker beacons ready ⇒ supervisor hands the charter ⇒ the worker
    // posts its signature finding over the OS IPC boundary.
    const got = await waitFor(() =>
      reg.findings().some((f) => f.summary.startsWith(WORKER_SIGNATURE)),
    )
    expect(got).toBe(true)
    const finding = reg.findings().find((f) => f.summary.startsWith(WORKER_SIGNATURE))
    expect(finding?.summary).toContain("process-wire-probe")

    // Cleanup — stop the daemon so the child exits (no leaked OS process).
    const id = reg.list()[0]?.id
    if (id !== undefined) reg.stop(id)
    await waitFor(() => reg.list()[0]?.status === "stopped", 2000)
  }, 12000)

  test("PROCESS OFF ⇒ in-process backer; the worker signature finding NEVER appears", async () => {
    // QUANTA_SIDE_AGENT_PROCESS unset (afterEach deletes it) ⇒ in-process path.
    __resetRuntimeConfig()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-proc-off") },
      { QUANTA_SIDE_AGENT: "1" },
    )
    const reg = cfg.sideAgentDaemons as SideAgentDaemonPort | undefined
    expect(reg).toBeDefined()
    if (reg === undefined) throw new Error("expected sideAgentDaemons wired")

    spawnDaemon(reg)
    // No OS worker is forked ⇒ the worker's signature finding can never appear.
    // (The in-process pass uses the throwing fake LLM ⇒ no finding either; and the
    // interval is 60s away ⇒ no immediate wake.) Give it a real window to be sure.
    const appeared = await waitFor(
      () => reg.findings().some((f) => f.summary.startsWith(WORKER_SIGNATURE)),
      800,
    )
    expect(appeared).toBe(false)
    const id = reg.list()[0]?.id
    if (id !== undefined) reg.stop(id)
  }, 5000)

  test("gate unset ⇒ slot undefined even with PROCESS on (byte-identical default-OFF)", () => {
    process.env.QUANTA_SIDE_AGENT_PROCESS = "1"
    __resetRuntimeConfig()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-proc-master-off") },
      {},
    )
    // QUANTA_SIDE_AGENT (the master gate) unset ⇒ no daemons regardless of the
    // process sub-gate.
    expect(cfg.sideAgentDaemons).toBeUndefined()
  })
})
