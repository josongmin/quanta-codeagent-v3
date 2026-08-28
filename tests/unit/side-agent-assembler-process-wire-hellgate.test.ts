/**
 * §4.3 — `maybeWireSideAgent` PROCESS sub-gate, the BYTE-IDENTICAL default-OFF case.
 *
 * The master gate (`QUANTA_SIDE_AGENT`) unset must leave `sideAgentDaemons`
 * undefined no matter what the `QUANTA_SIDE_AGENT_PROCESS` sub-gate says — a
 * sub-gate that could wire a slot on its own would be a default-OFF escape.
 *
 * WHERE THE TWO BACKER-SELECTION CASES LIVE NOW
 * ---------------------------------------------
 * `PROCESS ON ⇒ forks the real worker` and its `PROCESS OFF` paired control
 * moved to `tests/integration/side-agent-process-wire-e2e.test.ts`. They fork OS
 * children and wait on an IPC round trip: measured 11,457ms and 7,272ms inside a
 * full `bun test tests/unit` run, against a per-test unit budget of 8,529ms
 * (`tools/dev/unit-speed-budget.json`) that may only go DOWN. Faking the fork is
 * not an option — forking the REAL worker IS the distinguisher between the two
 * backers — so the remedy the budget itself names ("move it to
 * tests/integration") is the one taken. `bun run test` (the documented pre-push
 * gate) and the CI pyramid both run tests/integration.
 *
 * Env hygiene: both side-agent gates are parsed from the same INJECTED env bag,
 * so a surface cannot assemble one backer while `runtimeConfig()` reports another.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"

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

describe("§4.3 maybeWireSideAgent — process sub-gate cannot open the slot alone", () => {
  test("gate unset ⇒ slot undefined even with PROCESS on (byte-identical default-OFF)", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-proc-master-off") },
      { QUANTA_SIDE_AGENT_PROCESS: "1" },
    )
    // QUANTA_SIDE_AGENT (the master gate) unset ⇒ no daemons regardless of the
    // process sub-gate.
    expect(cfg.sideAgentDaemons).toBeUndefined()
  })
})
