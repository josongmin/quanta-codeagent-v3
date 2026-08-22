/**
 * ★ HELLGATE — UUX-6-12: a team-broker escalation prompt must NAME the worker.
 *
 * Pinned bug: when a WORKER's soft-denied tool escalated to the leader's
 * `onConfirm` (QUANTA_TEAM_BROKER), the action the leader saw was a bare
 * `{tool, input, isReadOnly}` — the CLI rendered only `Allow <tool>? …` with
 * ZERO context: not that a SUBAGENT was asking, not WHICH worker, not the
 * scope/reason. The operator decided a permission widening blind.
 *
 * Fix under test:
 *   §1 wire — `buildLeaderDecide(onConfirm, {workerId})` stamps a first-class
 *      `teamEscalation: {workerId, scope, reason}` onto the confirm action;
 *      `maybeWireCoordinationBroker` threads the worker's mailbox id (already
 *      in scope at the wire site) end-to-end through `createSubagentRunner`.
 *   §2 CLI — `buildCliOnConfirm` renders the worker context line BEFORE the
 *      verb prompt; PAIRED control: an action WITHOUT `teamEscalation` renders
 *      the byte-identical pre-fix prompt (no phantom header).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { runAgent } from "@/agent/loop"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import { __testing } from "@/apps/cli/repl/runtime-context-compose"
import type { ToolAction } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { makeFakeCliHitlDeps, makeScriptedChannel } from "./_cli-fakes"

// ── fixtures (mirror team-broker-composition-wire-hellgate.test.ts) ───────────

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([fakeTool("read")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
})

const childOf = async (parent: AgentConfig): Promise<AgentConfig> => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome()
  }) as typeof runAgent
  const runner = createSubagentRunner(parent, { run })
  await runner({ prompt: "x", depth: 1 })
  const child = seen[0]
  if (child === undefined) throw new Error("child never forked")
  return child
}

// Quiet the prompt-adjacent gates so §2 asserts ONLY the verb prompt bytes
// (mirrors approval-verb-parity-hellgate).
const ENV_KEYS = [
  "QUANTA_TEAM_BROKER",
  "QUANTA_PREFLIGHT_CHECK",
  "QUANTA_DIFF_PREVIEW",
  "QUANTA_HUNK_APPROVAL",
] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    if (k !== "QUANTA_TEAM_BROKER") process.env[k] = "0"
  }
  __resetRuntimeConfig()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const captureStderr = async (fn: () => Promise<unknown>): Promise<string> => {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ""
  process.stderr.write = ((chunk: unknown) => {
    buf += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await fn()
  } finally {
    process.stderr.write = orig
  }
  return buf
}

// ── §1 — the wire threads workerId onto the leader's confirm action ──────────

describe("HELLGATE UUX-6-12 §1 — escalation confirm carries the asking worker's id", () => {
  test("wired broker escalate ⇒ leader onConfirm sees teamEscalation {workerId, scope, reason}", async () => {
    process.env.QUANTA_TEAM_BROKER = "1"
    __resetRuntimeConfig()
    let confirmSeen: ToolAction | undefined
    const child = await childOf(
      parentConfig({
        onConfirm: async (action) => {
          confirmSeen = action
          return true
        },
      }),
    )
    const verdict = await child.admissibility?.coordinationBroker?.escalate({
      tool: "bash",
      scope: "rm dist",
      reason: "cleanup needs a clean slate",
    })
    expect(verdict?.approved).toBe(true)
    expect(confirmSeen?.tool).toBe("bash")
    // The load-bearing pin: WHICH worker is asking is first-class on the action.
    expect(confirmSeen?.teamEscalation).toBeDefined()
    expect(confirmSeen?.teamEscalation?.workerId).toBe(child.mailboxAgentId ?? "")
    expect(confirmSeen?.teamEscalation?.workerId?.length).toBeGreaterThan(0)
    expect(confirmSeen?.teamEscalation?.scope).toBe("rm dist")
    expect(confirmSeen?.teamEscalation?.reason).toBe("cleanup needs a clean slate")
  })
})

// ── §2 — the CLI prompt RENDERS the worker context ────────────────────────────

describe("HELLGATE UUX-6-12 §2 — CLI confirm names the asking worker", () => {
  test("action WITH teamEscalation ⇒ context line naming worker + scope + reason precedes the verbs", async () => {
    const deps = makeFakeCliHitlDeps({ channel: makeScriptedChannel(["y"]).channel })
    const onConfirm = __testing.buildCliOnConfirm(deps)
    const action: ToolAction = {
      tool: "bash",
      input: {},
      isReadOnly: false,
      teamEscalation: {
        workerId: "root/1",
        scope: "rm dist",
        reason: "cleanup needs a clean slate",
      },
    }
    const out = await captureStderr(async () => {
      expect(await onConfirm(action)).toBe(true)
    })
    expect(out).toContain("root/1")
    expect(out).toContain("rm dist")
    expect(out).toContain("cleanup needs a clean slate")
    // The worker header renders BEFORE the verb prompt (context first).
    expect(out.indexOf("root/1")).toBeLessThan(out.indexOf("Allow bash?"))
  })

  test("PAIRED control: action WITHOUT teamEscalation renders the byte-identical plain prompt", async () => {
    const deps = makeFakeCliHitlDeps({ channel: makeScriptedChannel(["y"]).channel })
    const onConfirm = __testing.buildCliOnConfirm(deps)
    const out = await captureStderr(async () => {
      expect(await onConfirm({ tool: "bash", input: {}, isReadOnly: false })).toBe(true)
    })
    expect(out).toBe("Allow bash? [y]es / [a]lways session / [N]o / deny+s[t]eer: ")
  })
})
