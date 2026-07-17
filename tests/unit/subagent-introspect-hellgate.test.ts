/**
 * Hellgate — RFC-04 / ADR-0437 `list_agents` + `followup_task`.
 *
 * Drives behavior through the assembled `Tool.execute()` surface AND the pure
 * handlers, against a real `TaskRegistry` + a fake mailbox + a real
 * `TurnWakeRegistry` with spy wakers. No LLM. Covers RFC §8's 16 cases.
 */
import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "../../src/agent/features"
import {
  createSubagentDeliveryController,
  createTargetResolver,
  type DeliveryMailboxPort,
  type SubagentControlRegistry,
} from "../../src/agent/subagent-delivery"
import { buildSubagentIntrospectBlock } from "../../src/agent/tier1/subagent-introspect"
import type { AgentConfig } from "../../src/agent/types"
import {
  AgentMetaRegistry,
  createIntrospectTools,
  createSubagent6Tools,
  handleFollowupTask,
  handleListAgents,
  handleSpawnAgent,
  type MailboxSendPort,
  type SubagentRunner,
  TaskRegistry,
  TurnWakeRegistry,
  type WakeOutcome,
} from "../../src/subagent"
import { ownersForRegistry } from "../../src/subagent/agent-tool"
import { logger } from "../../src/shared"
import type { Tool, ToolEvent } from "../../src/tool"

const ctxLess = { cwd: "/tmp", signal: new AbortController().signal }

const drive = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctxLess as never)) last = ev
  if (!last || last.type !== "result") throw new Error("no result event")
  return last
}

/** A fake mailbox capturing sends. Returns a minted `{id}` (the real store
 *  returns a `MailboxMessage`) so the delivery controller can stamp messageId. */
const fakeMailbox = () => {
  const sent: Array<{ from: string; to: string; body: string }> = []
  let seq = 0
  const port: MailboxSendPort = {
    send: (init) => {
      sent.push({ from: init.from, to: init.to, body: init.body })
      seq += 1
      return { id: `msg-${seq}` }
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

/** Minimal `AgentConfig` the subagent block + introspect builder read; the
 *  runner is built lazily (no LLM call at assembly), so a bare llm stub is fine. */
const featuresConfig = (subagent: Record<string, unknown>): AgentConfig =>
  ({
    llm: { model: "test-model", async *stream() {} },
    signal: new AbortController().signal,
    cwd: "/tmp",
    depth: 0,
    permission: { mode: "default" },
    subagent,
  }) as unknown as AgentConfig

describe("ALBB-12 claim 1 — shared TaskRegistry by construction (features seam)", () => {
  // The introspect builder must observe the SAME registry the agent/6-tool
  // spawn path minted (R1), WITHOUT the host pre-seeding
  // config.subagent.taskRegistry. Injection: revert the features.ts write-back
  // ⇒ list_agents reads a fresh empty R2 ⇒ this assertion fails.
  test("list_agents reflects a task in the block's registry with NO pre-seeded taskRegistry", async () => {
    const config = featuresConfig({ enableIntrospect: true })
    // Precondition of the red-on-injection: the host did NOT pre-seed.
    expect((config.subagent as { taskRegistry?: unknown }).taskRegistry).toBeUndefined()

    const features = await buildSessionFeatures(config)
    const reg = features.taskRegistry
    if (reg === undefined) throw new Error("block minted no taskRegistry")
    // Simulate the agent/6-tool spawn path putting a task into R1.
    const id = reg.newId()
    reg.register({ id, description: "spawned child" })

    const listTool = features.extraTools.find((t) => t.name === "list_agents")
    if (listTool === undefined) throw new Error("list_agents not registered")
    const ev = await drive(listTool, {})
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("spawned child")
    }
  })
})

describe("ALBB-12 claim 1 — fail-closed visibility (no silent empty registry)", () => {
  // enableIntrospect ON but the registry unreachable (genuinely split surface)
  // ⇒ NO list_agents tool + exactly one stderr warn. Injection: restoring the
  // `?? new TaskRegistry()` fallback makes the block emit a list_agents over an
  // empty registry ⇒ the length-0 assertion fails.
  test("split surface ⇒ [] (no list_agents) + a once warn", () => {
    const warned: string[] = []
    const orig = logger.warn
    ;(logger as { warn: typeof logger.warn }).warn = (msg: string) => {
      warned.push(msg)
    }
    try {
      const split = { enableIntrospect: true } as AgentConfig["subagent"]
      const tools = buildSubagentIntrospectBlock({ subagent: split } as AgentConfig)
      expect(tools).toEqual([])
      // The genuinely-split state was surfaced (visible fail-open), not silent.
      expect(warned.length).toBeGreaterThanOrEqual(1)
    } finally {
      ;(logger as { warn: typeof logger.warn }).warn = orig
    }
  })
})

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

// jul-7 audit F-B [MED]: list_agents enumerated the SHARED registry with NO lineage filter.
// Because enableIntrospect propagates to children (buildChildConfig spreads parent.subagent),
// a child could list its SIBLINGS' ids + labels (label = agentType ?? prompt.slice(0,40) —
// leaking a sibling's prompt prefix). Gate enumeration by the caller's lineage: a labeled
// caller sees ONLY its own-lineage tasks (+ owner-less host-seeded), NOT cross-lineage ones.
describe("list_agents — F-B lineage enumeration gate", () => {
  const trivialRunner: SubagentRunner = async () => ({ ok: true, finalText: "x", turns: 1 })

  const stampChild = async (reg: TaskRegistry, lineage: string, prompt: string): Promise<string> => {
    const s = await handleSpawnAgent({ prompt }, { runner: trivialRunner, registry: reg, requesterLineage: lineage })
    if (s.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(s.agentId)
    return s.agentId
  }

  test("labeled caller sees ONLY its own lineage's tasks (sibling ids+labels hidden)", async () => {
    const reg = new TaskRegistry()
    const aChild = await stampChild(reg, "agent-A", "A-child-SECRET-prompt")
    const bChild = await stampChild(reg, "agent-B", "B-child-other-prompt")

    const outA = handleListAgents(
      { includeSettled: true },
      { registry: reg, requesterLineage: "agent-A" },
    )
    expect(outA.kind).toBe("success")
    if (outA.kind === "success") {
      const ids = outA.agents.map((x) => x.id)
      expect(ids).toContain(aChild)
      expect(ids).not.toContain(bChild) // sibling row entirely hidden
      // and no label leaks B's prompt prefix
      expect(outA.agents.some((x) => x.label.includes("B-child"))).toBe(false)
    }
  })

  test("byte-identical: NO requesterLineage ⇒ enumerate all (legacy path)", async () => {
    const reg = new TaskRegistry()
    const aChild = await stampChild(reg, "agent-A", "A-child")
    const bChild = await stampChild(reg, "agent-B", "B-child")
    const out = handleListAgents({ includeSettled: true }, { registry: reg })
    expect(out.kind).toBe("success")
    if (out.kind === "success") {
      const ids = out.agents.map((x) => x.id)
      expect(ids).toContain(aChild)
      expect(ids).toContain(bChild)
    }
  })

  test("owner-less host-seeded tasks stay visible to a labeled caller (legacy disclosure)", () => {
    const reg = new TaskRegistry()
    const hostSeeded = spawnRunning(reg, "host task") // registered directly, no owner stamp
    const out = handleListAgents({}, { registry: reg, requesterLineage: "agent-A" })
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.agents.map((x) => x.id)).toContain(hostSeeded)
  })
})

describe("followup_task — RFC-04 / ADR-0437", () => {
  // WS3 migration (RFC jul-18 §4.4): `handleFollowupTask` no longer sequences
  // mailbox-send + wake itself — it consumes the delivery CONTROLLER. The setup
  // now registers a typed control ENDPOINT (whose `wake()`/`interrupt()` return
  // the scripted outcome + record the command) so every legacy assertion is
  // preserved, driven through the real controller + target resolver (the same
  // registry/ownership/self/settled policy, now owned by the controller).
  const setup = (wakeReturn: WakeOutcome | "no-register" = "woke") => {
    const reg = new TaskRegistry()
    const mb = fakeMailbox()
    const wake = new TurnWakeRegistry()
    const target = spawnRunning(reg, "child task")
    // `wakeCalls` records the control commands the controller issued: "followup"
    // for a wake, "interrupt" for a per-turn interrupt (the exact vocabulary the
    // pre-WS3 waker saw), so #9's interrupt-path assertion still holds.
    const wakeCalls: string[] = []
    if (wakeReturn !== "no-register") {
      wake.registerEndpoint(target, {
        mailboxLabel: target,
        wake: () => {
          wakeCalls.push("followup")
          return wakeReturn
        },
        interrupt: () => {
          wakeCalls.push("interrupt")
          // idle→woke_idle, busy→interrupted_active (both schedule/handle a turn);
          // "no-register" is handled by the absent-endpoint branch below.
          return wakeReturn === "woke" ? "woke_idle" : "interrupted_active"
        },
        steer: () => "accepted",
      })
    }
    return { reg, mb, wake, target, wakeCalls }
  }

  /** Build the controller-backed followup deps from the setup. `over` folds the
   *  legacy self/lineage/label knobs into the target resolver (the host closes
   *  them into the controller now). */
  const deps = (
    s: ReturnType<typeof setup>,
    over: {
      ownAgentId?: string
      requesterLineage?: string
    } = {},
  ) => {
    const control = s.wake as unknown as SubagentControlRegistry
    const delivery = createSubagentDeliveryController({
      control,
      mailbox: s.mb.port as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
      resolveTarget: createTargetResolver({
        registry: s.reg,
        control,
        ...(over.requesterLineage !== undefined ? { requesterLineage: over.requesterLineage } : {}),
        ...(over.ownAgentId !== undefined ? { ownTaskId: over.ownAgentId } : {}),
      }),
      newDeliveryId: (() => {
        let n = 0
        return () => `del-${(n += 1)}`
      })(),
      steerEnabled: false,
    })
    return { delivery, callerLabel: "parent" }
  }

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

  // label resolution: task id → mailbox label. Post-WS3 the controller resolves
  // the delivery address via `control.labelOf()` (the endpoint's mailboxLabel),
  // so re-register the endpoint under a distinct mailbox label and assert the
  // send targets it (the same jun-07 BUG#4 phantom-address guard, now owned by
  // the controller).
  test("delivery resolves agentId to the child's mailbox label", () => {
    const s = setup("woke")
    s.wake.registerEndpoint(s.target, {
      mailboxLabel: "child/0",
      wake: () => "woke",
      interrupt: () => "woke_idle",
      steer: () => "accepted",
    })
    handleFollowupTask({ agentId: s.target, message: "x" }, deps(s))
    expect(s.mb.sent[0]?.to).toBe("child/0")
  })

  // jul-7 re-audit F-E [HIGH]: followup_task DELIVERS a message AND triggers/interrupts a
  // turn on the target by id, with no lineage gate — a sibling could inject into (or
  // interrupt:true ABORT) another lineage's running child. Gate it like wait/send/output.
  test("F-E: cross-lineage followup_task ⇒ ownership_denied, NO send, NO wake", () => {
    const s = setup("woke")
    ownersForRegistry(s.reg).set(s.target, "agent-A") // target owned by lineage A
    const out = handleFollowupTask(
      { agentId: s.target, message: "INJECT", interrupt: true },
      deps(s, { requesterLineage: "agent-B" }), // sibling B attacks
    )
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("denied")
    expect(s.mb.sent).toHaveLength(0) // NOT delivered
    expect(s.wakeCalls).toHaveLength(0) // NOT triggered/interrupted
  })

  test("F-E control: OWNER lineage followup_task ⇒ delivered + triggered", () => {
    const s = setup("woke")
    ownersForRegistry(s.reg).set(s.target, "agent-A")
    const out = handleFollowupTask(
      { agentId: s.target, message: "go" },
      deps(s, { requesterLineage: "agent-A" }),
    )
    expect(out.kind).toBe("success")
    expect(s.mb.sent).toHaveLength(1)
    expect(s.wakeCalls).toEqual(["followup"])
  })

  test("F-E byte-identical: owner-less target ⇒ legacy delivery (no requesterLineage gate)", () => {
    const s = setup("woke") // spawnRunning does NOT stamp an owner
    const out = handleFollowupTask(
      { agentId: s.target, message: "go" },
      deps(s, { requesterLineage: "agent-B" }),
    )
    expect(out.kind).toBe("success") // owner-less ⇒ allowed regardless of lineage
    expect(s.mb.sent).toHaveLength(1)
  })
})

describe("introspect default-OFF + gating — RFC-04 §8.15", () => {
  // 15. gates OFF ⇒ no tools. ALBB-12 claim 1: the gate-ON list_agents now
  // requires a shared `taskRegistry` (fail-closed) — a gate-on WITHOUT a
  // registry is the genuinely-split surface and yields [] (covered by the
  // dedicated fail-closed test above), so this gate-shape check supplies one.
  test("tier1 builder returns [] unless gates set", () => {
    const base = { cwd: "/tmp" } as AgentConfig
    expect(buildSubagentIntrospectBlock(base)).toEqual([])
    expect(buildSubagentIntrospectBlock({ ...base, subagent: {} } as AgentConfig)).toEqual([])
    const listOnly = buildSubagentIntrospectBlock({
      ...base,
      subagent: { enableIntrospect: true, taskRegistry: new TaskRegistry() },
    } as AgentConfig)
    expect(listOnly.map((t) => t.name)).toEqual(["list_agents"])
  })

  test("followup gate without mailbox+wake substrate ⇒ followup NOT built", () => {
    // enableFollowup true but no mailbox/wake wired ⇒ createIntrospectTools skips it.
    const reg = new TaskRegistry()
    const tools = createIntrospectTools({ registry: reg, enableFollowup: true })
    expect(tools.map((t) => t.name)).toEqual([])
  })

  // WS3: `followup_task` is built when the delivery CONTROLLER is wired (not raw
  // mailbox+wake). Build a minimal controller over the registry/wake/mailbox.
  const makeDelivery = (reg: TaskRegistry, wake: TurnWakeRegistry, mb: ReturnType<typeof fakeMailbox>) => {
    const control = wake as unknown as SubagentControlRegistry
    return createSubagentDeliveryController({
      control,
      mailbox: mb.port as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
      resolveTarget: createTargetResolver({ registry: reg, control }),
      newDeliveryId: (() => {
        let n = 0
        return () => `del-${(n += 1)}`
      })(),
      steerEnabled: false,
    })
  }

  test("both gates + substrate ⇒ both tools, names exact", () => {
    const reg = new TaskRegistry()
    const wake = new TurnWakeRegistry()
    const mb = fakeMailbox()
    const tools = createIntrospectTools({
      registry: reg,
      delivery: makeDelivery(reg, wake, mb),
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
    wake.registerEndpoint(id, {
      mailboxLabel: id,
      wake: () => "woke",
      interrupt: () => "woke_idle",
      steer: () => "accepted",
    })
    const tools = createIntrospectTools({
      registry: reg,
      delivery: makeDelivery(reg, wake, mb),
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
      { prompt: "explore the repo", agent_type: "Explore" } as never,
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

  // BOUNDEDNESS: the AgentMetaRegistry side-table must NOT grow unbounded —
  // when a child reaches a terminal state the spawn path drops its entry. Without
  // the `delete` cleanup this read-back finds a lingering entry (red-on-injection).
  test("spawn_agent deletes its AgentMetaRegistry entry once the child settles", async () => {
    const reg = new TaskRegistry()
    const meta = new AgentMetaRegistry()
    // Runner resolves immediately ⇒ registry.complete(...) settles the task.
    const runner: SubagentRunner = async () => ({ ok: true, finalText: "done", turns: 1 })
    const { tools } = createSubagent6Tools({ runner, registry: reg, agentMeta: meta })
    const spawn = tools.find((t) => t.name === "spawn_agent") as Tool
    const res = await drive(spawn, { prompt: "settle then vanish", agent_type: "Explore" })
    expect(res.type).toBe("result")
    // Pull the freshly-minted agent id (the only record in this fresh registry),
    // then wait for the fire-and-forget settle continuation (complete → finally).
    const listed = handleListAgents({ includeSettled: true }, { registry: reg })
    const agentId = listed.kind === "success" ? listed.agents[0]?.id : undefined
    expect(agentId).toBeDefined()
    if (agentId === undefined) return
    await reg.waitForSettle(agentId)
    // Let the trailing `.finally(delete)` microtask flush.
    await Promise.resolve()
    await Promise.resolve()
    expect(meta.get(agentId)).toBeUndefined()
    // Sanity: the task itself is no longer a live (running) entry either.
    expect(reg.pendingIds()).not.toContain(agentId)
  })
})
