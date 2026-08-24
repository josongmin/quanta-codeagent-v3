/**
 * DRIFT GUARD — the two composition paths must open the SAME capability slots.
 *
 * This repo binds an agent two ways. `assembleAgentConfig` serves the headless /
 * SDK / batch surfaces and folds the capability-wire registry. The INTERACTIVE
 * CLI never calls it: it binds through `context-binding#wireRuntimePorts`. For a
 * long time only the first path folded the registry, so the surfaces disagreed
 * about which capabilities exist — measured slot-by-slot under identical gates,
 * the CLI left `browser`, `appshot`, `diagnosticsProvider`, `promptCacheObserver`,
 * `vcsEventSink` and `sideAgentDaemons` unset while the assembler set all six,
 * and an operator who turned those gates on got nothing with no error saying why.
 * `readFileState` was a seventh and worse, because its gate is DEFAULT-ON: the
 * TOCTOU stale-read guard was inert in the shipped CLI.
 *
 * Not one existing test could see it, because each one drove ONE path.
 *
 * The expected slot set is DERIVED, never written down: fold the registry onto a
 * copy and diff the keys. A hand-written name→key table would be a second thing
 * to keep in sync, i.e. the same class of bug one level up.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { CAPABILITY_WIRES } from "@/host/runtime/agent-config-assembler"
import { foldCapabilityWires } from "@/host/runtime/capability-wire-registry"
import { wireRuntimePorts } from "@/host/runtime/internal/context-binding/base"

/** Every capability gate ON, so the registry actually opens slots — a guard run
 *  with everything off would pass vacuously. */
const GATES: Record<string, string> = {
  QUANTA_BROWSER_TOOL: "1",
  QUANTA_APPSHOT: "1",
  QUANTA_OBJECTIVE_TOOLS: "1",
  QUANTA_SUBAGENT_MAILBOX: "1",
  QUANTA_PEER_MESSAGE: "1",
  QUANTA_WEB_SEARCH: "1",
  QUANTA_SUBAGENT_BG: "1",
  QUANTA_EDIT_REPAIR_LOOP: "1",
  QUANTA_SKILL_MCP: "1",
  QUANTA_PROMPT_CACHE_STATUS: "1",
  QUANTA_PASSIVE_VCS: "1",
  QUANTA_PROGRESS_SINK: "1",
  QUANTA_PII_REDACTION: "1",
  QUANTA_SIDE_AGENT: "1",
  QUANTA_WRITE_BUDGET: "1",
  QUANTA_BUDGET_LEDGER: "1",
}

const baseConfig = () =>
  ({
    llm: { model: "m", stream: async function* () {} },
    signal: new AbortController().signal,
    cwd: process.cwd(),
    sessionId: "parity-probe",
  }) as unknown as AgentConfig

/** The slot names the registry OPENS under `GATES`, derived by folding it. */
const registryOpenedSlots = (): readonly string[] => {
  const before = baseConfig() as unknown as Record<string, unknown>
  const after = { ...before } as unknown as AgentConfig
  foldCapabilityWires(CAPABILITY_WIRES, after, GATES)
  const rec = after as unknown as Record<string, unknown>
  return Object.keys(rec).filter((k) => rec[k] !== undefined && before[k] === undefined)
}

describe("capability wires — assembler path vs CLI path", () => {
  test("the registry opens a non-empty slot set under these gates (anti-vacuum)", () => {
    expect(registryOpenedSlots().length).toBeGreaterThan(0)
  })

  test("every slot the registry opens is ALSO opened on the CLI binding path", () => {
    const expected = registryOpenedSlots()
    const bound = wireRuntimePorts(baseConfig() as never, GATES) as unknown as Record<
      string,
      unknown
    >
    const missing = expected.filter((k) => bound[k] === undefined)
    // Named rather than counted: a failure must say WHICH capability the CLI
    // silently lacks, since that is the whole cost of this class of bug.
    expect(missing).toEqual([])
  })

  test("gates unset ⇒ the CLI path opens no capability slot it would not have had", () => {
    const before = baseConfig() as unknown as Record<string, unknown>
    const bound = wireRuntimePorts(baseConfig() as never, {}) as unknown as Record<string, unknown>
    const opened = registryOpenedSlots().filter(
      (k) => bound[k] !== undefined && before[k] === undefined,
    )
    // `readFileState` is the ONE default-ON member (its gate is a strict
    // kill-switch, not an opt-in), so it is expected here and nothing else is.
    expect(opened).toEqual(["readFileState"])
  })
})
