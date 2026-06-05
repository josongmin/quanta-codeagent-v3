/**
 * e2e Hellgate — N1 tier1 `buildSideAgentBlock` default-OFF / default-ON, and
 * the REAL `@/side-agent` registry is STRUCTURALLY a `SideAgentDaemonPort`
 * (the duck-typed seam holds — a real registry plugs into the tools).
 */

import { describe, expect, test } from "bun:test"
import { buildSideAgentBlock } from "@/agent/tier1"
import type { AgentConfig } from "@/agent/types"
import { createSideAgentDaemonRegistry } from "@/side-agent"

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ cwd: "/repo", signal: new AbortController().signal, ...over }) as AgentConfig

/** A real daemon registry over inert ports (no real timers fire in the test). */
const realRegistry = () =>
  createSideAgentDaemonRegistry({
    runner: { run: async () => null },
    mailbox: { send: () => {} },
    mainRecipient: "main",
    setInterval: () => 0,
    clearInterval: () => {},
    now: () => 1,
  })

describe("buildSideAgentBlock — default-OFF / default-ON", () => {
  test("no registry ⇒ no tools (byte-identical default-OFF)", () => {
    expect(buildSideAgentBlock(cfg())).toEqual([])
  })

  test("registry wired ⇒ the four side_agent tools (real registry plugs the port)", () => {
    const tools = buildSideAgentBlock(cfg({ sideAgentDaemons: realRegistry() }))
    expect(tools.map((t) => t.name).sort()).toEqual([
      "side_agent_findings",
      "side_agent_list",
      "side_agent_spawn",
      "side_agent_stop",
    ])
  })

  test("the wired tools operate the REAL registry (spawn → list reflects it)", async () => {
    const registry = realRegistry()
    const tools = buildSideAgentBlock(cfg({ sideAgentDaemons: registry }))
    const spawn = tools.find((t) => t.name === "side_agent_spawn")
    if (spawn === undefined) throw new Error("spawn tool missing")
    let ok = false
    for await (const ev of spawn.execute(
      {
        task: "monitor",
        trigger: { kind: "interval", every_ms: 1000 },
        max_wakes: 3,
        max_turns_per_wake: 1,
      } as never,
      { cwd: "/repo", signal: new AbortController().signal },
    )) {
      if (ev.type === "result") ok = ev.result.ok
    }
    expect(ok).toBe(true)
    // The real registry now lists exactly one running daemon.
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.status).toBe("running")
  })
})
