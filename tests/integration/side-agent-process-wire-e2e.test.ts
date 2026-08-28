/**
 * §4.3 HELLGATE (INTEGRATION) — `maybeWireSideAgent` PROCESS-backer selection,
 * the two cases that FORK A REAL OS WORKER.
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
 *     (The worker is hermetic — no LLM/network — so this is deterministic.)
 *   - PROCESS OFF ⇒ the in-process backer is wired: `spawn` runs the in-process
 *     subagent pass on the MAIN thread. With the test's throwing fake LLM that
 *     pass yields nothing AND no OS child is ever forked, so the worker's
 *     signature finding NEVER appears (the distinguisher).
 *
 * RED-ON-INJECTION: if the assembler ignored `sideAgentProcess` and always wired
 * in-process, the PROCESS-ON case would never see a worker finding and fail; if
 * it always wired the process backer, the OFF case would fork a worker and see
 * the signature finding and fail.
 *
 * WHY tests/integration AND NOT tests/unit. Both cases fork OS children and wait
 * on an IPC round trip: measured 11,457ms and 7,272ms inside a full
 * `bun test tests/unit` run, against a per-test unit budget of 8,529ms
 * (`tools/dev/unit-speed-budget.json`) that may only go DOWN. The budget's own
 * remedy text is "Move it to tests/integration or fake the slow dependency", and
 * faking is not available here — forking the REAL worker is the entire
 * distinguisher between the two backers. The byte-identical default-OFF case is
 * pure, so it stayed in
 * `tests/unit/side-agent-assembler-process-wire-hellgate.test.ts`.
 *
 * Env hygiene: both side-agent gates are parsed from the same INJECTED env bag,
 * so a surface cannot assemble one backer while `runtimeConfig()` reports another.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
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

/**
 * DEADLOCK BACKSTOP, not a verdict. The old `waitFor(pred, 6000)` made a wall
 * clock the judge: under full-suite congestion the fork→ready→charter→IPC round
 * trip lands well past 6s with the wiring perfectly intact, and the test went
 * red at ~6002ms. Now the verdict is the SIGNAL (the finding, or a terminal
 * supervisor status), and the timer only exists so a genuinely wedged fork
 * fails loudly instead of hanging the suite forever.
 */
const BACKSTOP_MS = 60_000
const TEST_TIMEOUT_MS = 180_000
const POLL_MS = 10

/** Await a real observable condition. Throws (never silently returns false) so a
 *  backstop trip is reported as the deadlock it is, not as "the thing did not
 *  happen". `pred` may itself throw to fail FAST on a terminal signal. */
const awaitSignal = async (label: string, pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + BACKSTOP_MS
  for (;;) {
    if (pred()) return
    if (Date.now() > deadline) {
      throw new Error(`deadlock backstop (${BACKSTOP_MS}ms) waiting for: ${label}`)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

const WORKER_SIGNATURE = "side-agent process pass:"

const hasWorkerFinding = (reg: SideAgentDaemonPort): boolean =>
  reg.findings().some((f) => f.summary.startsWith(WORKER_SIGNATURE))

/** The forked worker's finding is the pass signal; a terminal supervisor status
 *  with no finding is the fail signal — either way the verdict is a real event,
 *  so no amount of load can turn a working wire into a red. */
const workerFindingLanded = (reg: SideAgentDaemonPort): boolean => {
  if (hasWorkerFinding(reg)) return true
  const status = reg.list()[0]?.status
  if (status === "failed" || status === "stopped") {
    throw new Error(`process-backed daemon reached terminal status "${status}" with no finding`)
  }
  return false
}

/** Stop every daemon on `reg` and wait for the registry to report it terminal —
 *  so no forked OS child outlives the test. */
const stopAllDaemons = async (reg: SideAgentDaemonPort): Promise<void> => {
  for (const snapshot of reg.list()) reg.stop(snapshot.id)
  await awaitSignal("every spawned daemon reports a terminal status", () =>
    reg.list().every((s) => s.status !== "running"),
  )
}

describe("§4.3 maybeWireSideAgent — process backer selection", () => {
  test(
    "PROCESS ON ⇒ spawn forks the real worker; a finding crosses IPC",
    async () => {
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseReq("sess-proc-on") },
        { QUANTA_SIDE_AGENT: "1", QUANTA_SIDE_AGENT_PROCESS: "1" },
      )
      const reg = cfg.sideAgentDaemons as SideAgentDaemonPort | undefined
      expect(reg).toBeDefined()
      if (reg === undefined) throw new Error("expected sideAgentDaemons wired")

      spawnDaemon(reg)
      // The forked worker beacons ready ⇒ supervisor hands the charter ⇒ the worker
      // posts its signature finding over the OS IPC boundary. We await THAT event
      // (or a terminal supervisor status, which fails immediately) — never a clock.
      await awaitSignal("the forked worker's signature finding to cross IPC", () =>
        workerFindingLanded(reg),
      )
      const finding = reg.findings().find((f) => f.summary.startsWith(WORKER_SIGNATURE))
      expect(finding?.summary).toContain("process-wire-probe")

      // Cleanup — stop the daemon so the child exits (no leaked OS process).
      await stopAllDaemons(reg)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "PROCESS OFF ⇒ in-process backer; the worker signature finding NEVER appears",
    async () => {
      const offCfg = assembleAgentConfig(
        { mode: "interactive", base: baseReq("sess-proc-off") },
        { QUANTA_SIDE_AGENT: "1" },
      )
      const offReg = offCfg.sideAgentDaemons as SideAgentDaemonPort | undefined
      expect(offReg).toBeDefined()
      if (offReg === undefined) throw new Error("expected sideAgentDaemons wired")

      // PAIRED POSITIVE CONTROL — the load-invariant observation window.
      // Asserting an ABSENCE needs a window long enough for the thing to have
      // shown up if it were going to. The old `waitFor(…, 800)` guessed that
      // window in milliseconds, so on a congested box (where the round trip
      // takes many seconds) it degenerated into a vacuous pass. Instead we run a
      // PROCESS-ON registry alongside, in the same process under the same load,
      // and only judge the OFF registry once the ON one has completed the FULL
      // fork→ready→charter→finding round trip. The OFF daemon was spawned first,
      // so it has had at least that long to produce a worker finding.
      const onCfg = assembleAgentConfig(
        { mode: "interactive", base: baseReq("sess-proc-off-control") },
        { QUANTA_SIDE_AGENT: "1", QUANTA_SIDE_AGENT_PROCESS: "1" },
      )
      const onReg = onCfg.sideAgentDaemons as SideAgentDaemonPort | undefined
      if (onReg === undefined) throw new Error("expected control sideAgentDaemons wired")

      spawnDaemon(offReg)
      spawnDaemon(onReg)
      await awaitSignal("the CONTROL (process-backed) registry's worker finding", () =>
        workerFindingLanded(onReg),
      )

      // Same elapsed real time, same machine, same load — and no OS worker was
      // ever forked for the OFF registry, so its signature finding cannot exist.
      // (The in-process pass uses the throwing fake LLM ⇒ no finding either; and
      // the interval is 60s away ⇒ no immediate wake.)
      expect(hasWorkerFinding(offReg)).toBe(false)

      await stopAllDaemons(onReg)
      for (const snapshot of offReg.list()) offReg.stop(snapshot.id)
    },
    TEST_TIMEOUT_MS,
  )
})
