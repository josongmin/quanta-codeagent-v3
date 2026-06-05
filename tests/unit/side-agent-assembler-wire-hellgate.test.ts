/**
 * ★ E2E CONTRACT — N1 background side-agent, host-binding closeout (§9).
 *
 * Proves the LIVE wire: `assembleAgentConfig` under `QUANTA_SIDE_AGENT=1` mints a
 * real `SideAgentDaemonRegistry` into `cfg.sideAgentDaemons` (via
 * `maybeWireSideAgent` → `wireSideAgentDaemons`, bridging the ADR-0130 subagent
 * runner + the ADR-0416 mailbox + real timers/clock), and that the tier-1
 * `buildSideAgentBlock` then exposes the four `side_agent_*` tools over THAT same
 * registry. Gate unset ⇒ slot stays undefined ⇒ zero tools (byte-identical
 * default-OFF). Caller-supplied registry wins (caller-override-precedence).
 *
 * Determinism: no real subagent ever runs — assembly only mints the registry; we
 * assert the slot + the tool surface, not a daemon pass. No clock/random in the
 * test body (the assembler injects `Date.now`/`setInterval` itself).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildSideAgentBlock } from "@/agent/tier1"
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
  cwd: "/repo",
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

const SIDE_AGENT_TOOL_NAMES = [
  "side_agent_spawn",
  "side_agent_list",
  "side_agent_stop",
  "side_agent_findings",
] as const

describe("N1 — maybeWireSideAgent (host-binding closeout)", () => {
  test("A1 — QUANTA_SIDE_AGENT=1 ⇒ cfg.sideAgentDaemons is a live registry", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-side-on") },
      { QUANTA_SIDE_AGENT: "1" },
    )
    expect(cfg.sideAgentDaemons).toBeDefined()
    // structural-mirror SideAgentDaemonPort surface (spawn/list/stop/findings)
    const reg = cfg.sideAgentDaemons as Record<string, unknown>
    expect(typeof reg.spawn).toBe("function")
    expect(typeof reg.list).toBe("function")
    expect(typeof reg.stop).toBe("function")
    expect(typeof reg.findings).toBe("function")
  })

  test("A2 — wired registry ⇒ buildSideAgentBlock exposes the four side_agent_* tools", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-side-tools") },
      { QUANTA_SIDE_AGENT: "1" },
    )
    const tools = buildSideAgentBlock(cfg)
    expect(tools.map((t) => t.name).sort()).toEqual([...SIDE_AGENT_TOOL_NAMES].sort())
  })

  test("B1 — gate unset ⇒ slot undefined ⇒ zero tools (byte-identical default-OFF)", () => {
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseReq("sess-side-off") }, {})
    expect(cfg.sideAgentDaemons).toBeUndefined()
    expect(buildSideAgentBlock(cfg)).toEqual([])
  })

  test("B2 — gate set to non-'1' ⇒ slot undefined (strict opt-in)", () => {
    for (const raw of ["0", "true", "on", "", "yes"]) {
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseReq(`sess-side-${raw}`) },
        { QUANTA_SIDE_AGENT: raw },
      )
      expect(cfg.sideAgentDaemons).toBeUndefined()
    }
  })

  test("C1 — caller-supplied registry is preserved (caller-override-precedence)", () => {
    const sentinel = {
      spawn: () => undefined,
      list: () => [],
      stop: () => undefined,
      findings: () => [],
    }
    const cfg = assembleAgentConfig(
      {
        mode: "interactive",
        base: {
          ...baseReq("sess-side-pre"),
          sideAgentDaemons: sentinel,
        } as AssembleRequest["base"],
      },
      { QUANTA_SIDE_AGENT: "1" },
    )
    expect(cfg.sideAgentDaemons).toBe(sentinel as never)
  })
})
