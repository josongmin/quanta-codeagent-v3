/**
 * P0 injected-env composition hellgate.
 *
 * `assembleAgentConfig(req, env)` is the host boundary: it must derive every
 * optional capability from THAT request env, never from the process-global
 * runtimeConfig cache. The two inverse cases below are intentionally hostile:
 * global ON/request OFF and global OFF/request ON. Each assertion observes the
 * installed runtime surface, so swapping the helper back to runtimeConfig()
 * makes at least one half fail.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { createPermissionStore } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import {
  __setBashSandboxEscalationHandler,
  getBashSandboxEscalationHandler,
} from "@/tool/bash/sandbox-escalation-wire"

const keys = ["QUANTA_SUBAGENT_QUEUE", "QUANTA_SANDBOX_ESCALATION", "QUANTA_TEAM_PEER_MSG"] as const
const originalEnv = new Map(keys.map((key) => [key, process.env[key]]))

const base = (sessionId: string): AssembleRequest["base"] =>
  ({
    llm: { stream: async function* () {} } as unknown as AgentConfig["llm"],
    registry: {
      register: () => undefined,
      get: () => undefined,
      list: () => [],
    } as unknown as AgentConfig["registry"],
    stream: { emit: () => undefined },
    permission: { mode: "default" },
    admissibility: { permissionStore: createPermissionStore() },
    messages: [],
    system: "test",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId,
  }) as AssembleRequest["base"]

const setGlobal = (on: boolean): void => {
  for (const key of keys) {
    if (on) process.env[key] = "1"
    else delete process.env[key]
  }
  __resetRuntimeConfig()
}

afterEach(() => {
  for (const key of keys) {
    const original = originalEnv.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  __resetRuntimeConfig()
  __setBashSandboxEscalationHandler(undefined)
})

describe("P0 — assembler injected env owns queue, sandbox escalation, and peer team wiring", () => {
  test("global ON + request OFF leaves all three surfaces OFF", () => {
    setGlobal(true)
    const cfg = assembleAgentConfig(
      {
        mode: "interactive",
        base: base("injected-off"),
      },
      {
        QUANTA_SUBAGENT_BG: "1",
        QUANTA_SUBAGENT_MAILBOX: "1",
      },
    )

    const scheduler = cfg.subagentBackground?.scheduler
    expect(scheduler).toBeDefined()
    // Queue OFF is observable without starting a child: the queue-only command
    // returns `queue_disabled`; when admission is installed it returns not_found.
    expect(scheduler?.forceBackground("missing")).toBe("queue_disabled")
    expect(getBashSandboxEscalationHandler()).toBeUndefined()
    expect(cfg.peerInbox).toBeUndefined()
    expect(cfg.teamRegistry).toBeUndefined()
  })

  test("global OFF + request ON installs all three requested surfaces", () => {
    setGlobal(false)
    const cfg = assembleAgentConfig(
      {
        mode: "interactive",
        base: base("injected-on"),
      },
      {
        QUANTA_SUBAGENT_BG: "1",
        QUANTA_SUBAGENT_QUEUE: "1",
        QUANTA_SUBAGENT_MAILBOX: "1",
        QUANTA_SANDBOX_ESCALATION: "1",
        QUANTA_TEAM_PEER_MSG: "1",
      },
    )

    const scheduler = cfg.subagentBackground?.scheduler
    expect(scheduler).toBeDefined()
    expect(scheduler?.forceBackground("missing")).toBe("not_found")
    expect(getBashSandboxEscalationHandler()).toBeDefined()
    expect(cfg.peerInbox).toBeDefined()
    expect(cfg.teamRegistry).toBeDefined()
  })
})
