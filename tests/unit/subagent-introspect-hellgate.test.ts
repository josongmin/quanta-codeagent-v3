/**
 * Hellgate — RFC-04 / ADR-0437 `list_agents` + `followup_task`.
 *
 * Drives behavior through the assembled `Tool.execute()` surface AND the pure
 * handlers, against a real `TaskRegistry` + a fake mailbox + a real
 * `TurnWakeRegistry` with spy wakers. No LLM. Covers RFC §8's 16 cases.
 */
import { describe, expect, test } from "bun:test"
import { buildSubagentIntrospectBlock } from "../../src/agent/tier1/subagent-introspect"
import type { AgentConfig } from "../../src/agent/types"
import {
  AgentMetaRegistry,
  createIntrospectTools,
  createSubagent6Tools,
  handleFollowupTask,
  handleListAgents,
  type MailboxSendPort,
  type SubagentRunner,
  TaskRegistry,
  TurnWakeRegistry,
  type WakeOutcome,
} from "../../src/subagent"
import type { Tool, ToolEvent } from "../../src/tool"

const ctxLess = { cwd: "/tmp", signal: new AbortController().signal }

const drive = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctxLess as never)) last = ev
  if (!last || last.type !== "result") throw new Error("no result event")
  return last
}

/** A fake mailbox capturing sends. */
const fakeMailbox = () => {
  const sent: Array<{ from: string; to: string; body: string }> = []
  const port: MailboxSendPort = {
    send: (init) => {
      sent.push({ from: init.from, to: init.to, body: init.body })
      return init
    },
  }
  return { port, sent }
}

/** Register a running task and return its id. */
const spawnRunning = (reg: TaskRegistry, description: string, agentType?: string): string => {
  const id = reg.newId()
  reg.register({ id, description, ...(agentType !== undefined ? { agentType } : {}) })
  return id
}

describe("list_agents — RFC-04 / ADR-0437", () => {
  // 1. reflectivity
  test("reflects running children; includeSettled toggles settled ones", () => {
    const reg = new TaskRegistry()
    const a = spawnRunning(reg, "task A")
    const b = spawnRunning(reg, "task B")
    reg.complete(b, { ok: true, finalText: "done", turns: 1 })

    const live = handleListAgents({}, { registry: reg })
    expect(live.kind).toBe("success")
    if (live.kind === "success") {
      expect(live.agents.map((x) => x.id)).toEqual([a])
    }
    const all = handleListAgents({ includeSettled: true }, { registry: reg })
    if (all.kind === "success") {
      expect(all.agents.length).toBe(2)
      expect(all.agents.find((x) => x.id === b)?.status).toBe("settled")
    }
  })

  // 2. status bucketing
  test("completed/stopped ⇒ settled; failed ⇒ failed", () => {
    const reg = new TaskRegistry()
    const c = spawnRunning(reg, "c")
    const s = spawnRunning(reg, "s")
    const f = spawnRunning(reg, "f")
    reg.complete(c, { ok: true, finalText: "ok", turns: 1 })
    reg.forceStop(s)
    reg.fail(f, "boom")
    const out = handleListAgents({ includeSettled: true }, { registry: reg })
    if (out.kind === "success") {
      const byId = Object.fromEntries(out.agents.map((a) => [a.id, a.status]))
      expect(byId[c]).toBe("settled")
      expect(byId[s]).toBe("settled")
      expect(byId[f]).toBe("failed")
    }
  })

  // 3. prefix filter
  test("prefix filters by id OR label; no match ⇒ empty success", () => {
    const reg = new TaskRegistry()
    const meta = new AgentMetaRegistry()
    const a = spawnRunning(reg, "alpha task")
    meta.set(a, { depth: 1, label: "Explore" })
    spawnRunning(reg, "beta task")
    const byLabel = handleListAgents({ prefix: "Expl" }, { registry: reg, agentMeta: meta })
    if (byLabel.kind === "success") expect(byLabel.agents.map((x) => x.id)).toEqual([a])
    const none = handleListAgents({ prefix: "zzz" }, { registry: reg, agentMeta: meta })
    expect(none.kind).toBe("success")
    if (none.kind === "success") expect(none.agents).toEqual([])
  })

  // 4. concurrency-safe snapshot
  test("settling a task mid-iteration does not corrupt the snapshot", () => {
    const reg = new TaskRegistry()
    const a = spawnRunning(reg, "a")
    spawnRunning(reg, "b")
    const out = handleListAgents({}, { registry: reg })
    // settle after snapshot taken
    reg.complete(a, { ok: true, finalText: "x", turns: 1 })
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.agents.length).toBe(2)
  })

  // 5. depth/label join + fallback
  test("agentMeta join supplies depth/label; absent ⇒ depth 0 + description fallback", () => {
    const reg = new TaskRegistry()
    const meta = new AgentMetaRegistry()
    const a = spawnRunning(reg, "deep task")
    meta.set(a, { depth: 3, label: "Worker" })
    const b = spawnRunning(reg, "no meta task")
    const withMeta = handleListAgents({}, { registry: reg, agentMeta: meta })
    if (withMeta.kind === "success") {
      const ra = withMeta.agents.find((x) => x.id === a)
      expect(ra?.depth).toBe(3)
      expect(ra?.label).toBe("Worker")
      const rb = withMeta.agents.find((x) => x.id === b)
      expect(rb?.depth).toBe(0)
      expect(rb?.label).toBe("no meta task")
    }
  })

  // 6. limit
  test("limit caps the result count", () => {
    const reg = new TaskRegistry()
    spawnRunning(reg, "a")
    spawnRunning(reg, "b")
    spawnRunning(reg, "c")
    const out = handleListAgents({ limit: 1 }, { registry: reg })
    if (out.kind === "success") expect(out.agents.length).toBe(1)
  })

  // 16. injected clock determinism — startedAt reflects registry record
  test("startedAt is the registry record's startedAt (deterministic field)", () => {
    const reg = new TaskRegistry()
    const a = spawnRunning(reg, "a")
    const rec = reg.get(a)
    const out = handleListAgents({}, { registry: reg })
    if (out.kind === "success") expect(out.agents[0]?.startedAt).toBe(rec?.startedAt)
  })
})

describe("followup_task — RFC-04 / ADR-0437", () => {
  const setup = (wakeReturn: WakeOutcome | "no-register" = "woke") => {
    const reg = new TaskRegistry()
    const mb = fakeMailbox()
    const wake = new TurnWakeRegistry()
    const target = spawnRunning(reg, "child task")
    const wakeCalls: string[] = []
    if (wakeReturn !== "no-register") {
      wake.register(target, (reason) => {
        wakeCalls.push(reason)
        return wakeReturn
      })
    }
    return { reg, mb, wake, target, wakeCalls }
  }

  const deps = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => ({
    registry: s.reg,
    mailbox: s.mb.port,
    wake: s.wake,
    callerLabel: "parent",
    ...over,
  })

  // 7. delivers + triggers
  test("idle target: delivers via mailbox AND triggers (triggered:true)", () => {
    const s = setup("woke")
    const out = handleFollowupTask({ agentId: s.target, message: "go" }, deps(s))
    expect(out.kind).toBe("success")
    if (out.kind === "success") {
      expect(out.delivered).toBe(true)
      expect(out.triggered).toBe(true)
    }
    expect(s.mb.sent).toHaveLength(1)
    expect(s.mb.sent[0]?.body).toBe("go")
    expect(s.wakeCalls).toEqual(["followup"])
  })

  // 8. mid-turn queuing
  test("busy target (queued): triggered:false, still delivered", () => {
    const s = setup("queued")
    const out = handleFollowupTask({ agentId: s.target, message: "later" }, deps(s))
    if (out.kind === "success") {
      expect(out.triggered).toBe(false)
      expect(out.delivered).toBe(true)
    }
    expect(s.mb.sent).toHaveLength(1)
  })

  // 9. interrupt
  test("interrupt:true passes reason 'interrupt' to the waker", () => {
    const s = setup("woke")
    handleFollowupTask({ agentId: s.target, message: "now", interrupt: true }, deps(s))
    expect(s.wakeCalls).toEqual(["interrupt"])
  })

  // 10. target not found ⇒ no side effect
  test("unknown id ⇒ id_unknown, no mailbox send, no wake", () => {
    const s = setup("woke")
    const out = handleFollowupTask({ agentId: "task_ghost", message: "x" }, deps(s))
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("id_unknown")
    expect(s.mb.sent).toHaveLength(0)
    expect(s.wakeCalls).toHaveLength(0)
  })

  // 11. settled target
  test("settled target ⇒ cause:settled, no send/wake", () => {
    const s = setup("woke")
    s.reg.complete(s.target, { ok: true, finalText: "done", turns: 1 })
    const out = handleFollowupTask({ agentId: s.target, message: "x" }, deps(s))
    if (out.kind === "error") expect(out.cause).toBe("settled")
    expect(s.mb.sent).toHaveLength(0)
  })

  // 12. no-waker degradation
  test("no live waker ⇒ cause:no_waker BUT mailbox delivery still happens", () => {
    const s = setup("no-register")
    const out = handleFollowupTask({ agentId: s.target, message: "queued-msg" }, deps(s))
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("no_waker")
    // honest degradation: the message WAS delivered.
    expect(s.mb.sent).toHaveLength(1)
    expect(s.mb.sent[0]?.body).toBe("queued-msg")
  })

  // 13. self-target
  test("targeting own id ⇒ cause:self_target, no send", () => {
    const s = setup("woke")
    const out = handleFollowupTask(
      { agentId: s.target, message: "x" },
      deps(s, { ownAgentId: s.target }),
    )
    if (out.kind === "error") expect(out.cause).toBe("self_target")
    expect(s.mb.sent).toHaveLength(0)
  })

  // 14. root-forbidden (root never in registry ⇒ id_unknown)
  test("root target (not in registry) ⇒ id_unknown", () => {
    const s = setup("woke")
    const out = handleFollowupTask({ agentId: "root", message: "x" }, deps(s))
    if (out.kind === "error") expect(out.cause).toBe("id_unknown")
  })

  // resolveLabel applied to mailbox 'to'
  test("resolveLabel maps agentId to mailbox label", () => {
    const s = setup("woke")
    handleFollowupTask(
      { agentId: s.target, message: "x" },
      deps(s, { resolveLabel: () => "child/0" }),
    )
    expect(s.mb.sent[0]?.to).toBe("child/0")
  })
})

describe("introspect default-OFF + gating — RFC-04 §8.15", () => {
  // 15. gates OFF ⇒ no tools
  test("tier1 builder returns [] unless gates set", () => {
    const base = { cwd: "/tmp" } as AgentConfig
    expect(buildSubagentIntrospectBlock(base)).toEqual([])
    expect(buildSubagentIntrospectBlock({ ...base, subagent: {} } as AgentConfig)).toEqual([])
    const listOnly = buildSubagentIntrospectBlock({
      ...base,
      subagent: { enableIntrospect: true },
    } as AgentConfig)
    expect(listOnly.map((t) => t.name)).toEqual(["list_agents"])
  })

  test("followup gate without mailbox+wake substrate ⇒ followup NOT built", () => {
    // enableFollowup true but no mailbox/wake wired ⇒ createIntrospectTools skips it.
    const reg = new TaskRegistry()
    const tools = createIntrospectTools({ registry: reg, enableFollowup: true })
    expect(tools.map((t) => t.name)).toEqual([])
  })

  test("both gates + substrate ⇒ both tools, names exact", () => {
    const reg = new TaskRegistry()
    const wake = new TurnWakeRegistry()
    const mb = fakeMailbox()
    const tools = createIntrospectTools({
      registry: reg,
      mailbox: mb.port,
      wake,
      callerLabel: "parent",
      enableIntrospect: true,
      enableFollowup: true,
    })
    expect(tools.map((t) => t.name).sort()).toEqual(["followup_task", "list_agents"])
  })

  test("list_agents tool surface drives end-to-end", async () => {
    const reg = new TaskRegistry()
    spawnRunning(reg, "task X")
    const [listTool] = createIntrospectTools({ registry: reg, enableIntrospect: true })
    const ev = await drive(listTool as Tool, {})
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("task X")
    }
  })

  test("followup_task tool surface delivers + triggers end-to-end", async () => {
    const reg = new TaskRegistry()
    const wake = new TurnWakeRegistry()
    const mb = fakeMailbox()
    const id = spawnRunning(reg, "child")
    wake.register(id, () => "woke")
    const tools = createIntrospectTools({
      registry: reg,
      mailbox: mb.port,
      wake,
      callerLabel: "parent",
      enableFollowup: true,
    })
    const followup = tools.find((t) => t.name === "followup_task") as Tool
    const ev = await drive(followup, { agentId: id, message: "hi" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(mb.sent).toHaveLength(1)
  })

  test("TurnWakeRegistry: unregistered ⇒ no-receiver; disposer removes waker", () => {
    const wake = new TurnWakeRegistry()
    expect(wake.wake("x", "followup")).toBe("no-receiver")
    const dispose = wake.register("x", () => "woke")
    expect(wake.has("x")).toBe(true)
    expect(wake.wake("x", "followup")).toBe("woke")
    dispose()
    expect(wake.has("x")).toBe(false)
    expect(wake.wake("x", "followup")).toBe("no-receiver")
  })

  test("TurnWakeRegistry: throwing waker degrades to no-receiver", () => {
    const wake = new TurnWakeRegistry()
    wake.register("x", () => {
      throw new Error("boom")
    })
    expect(wake.wake("x", "followup")).toBe("no-receiver")
  })

  // WIRED path: spawn_agent (6-tool) writes AgentMetaRegistry; list_agents joins it.
  test("spawn_agent populates AgentMetaRegistry and list_agents reflects depth/label", async () => {
    const reg = new TaskRegistry()
    const meta = new AgentMetaRegistry()
    const runner: SubagentRunner = async () =>
      await new Promise(() => {}) /* never settles ⇒ stays running */
    const { tools } = createSubagent6Tools({
      runner,
      registry: reg,
      agentMeta: meta,
      parentDepth: 2,
    })
    const spawn = tools.find((t) => t.name === "spawn_agent") as Tool
    // drive spawn_agent through the real Tool.execute surface
    for await (const _ev of spawn.execute(
      { prompt: "explore the repo", agentType: "Explore" } as never,
      ctxLess as never,
    )) {
      /* consume */
    }
    const out = handleListAgents({}, { registry: reg, agentMeta: meta })
    expect(out.kind).toBe("success")
    if (out.kind === "success") {
      expect(out.agents).toHaveLength(1)
      expect(out.agents[0]?.depth).toBe(3) // parentDepth 2 + 1
      expect(out.agents[0]?.label).toBe("Explore")
      expect(out.agents[0]?.status).toBe("running")
    }
  })
})
