/** jun-06 RFC — MCP resources/prompts on the SUPERVISED (auto-restart) path.
 *
 *  Closes the N3 limitation: the resources/prompts aggregate now includes
 *  SUPERVISED clients. The supervisor exposes the six `resources/*`+`prompts/*`
 *  methods, each re-resolving the CURRENT live client per call, so the once-built
 *  aggregate handle survives a restart that swaps the underlying client.
 *
 *  The single LOAD-BEARING invariant: the supervisor is NO-THROW. During the
 *  reconnect gap (`backing-off`/`restarting`/`degraded`) every resources method
 *  returns a typed `transport` failure — NEVER a throw — so the N3 aggregate
 *  (no-throw by contract, the round-3 audit found 16 no-throw violations; this
 *  must not add a 17th) is never handed an exception.
 *
 *  Fully on a fake clock + fake timer queue — ZERO real timers, ZERO real
 *  RNG/Date.now. */

import { describe, expect, it } from "bun:test"
import { aggregateResourcesHandle, loadMcpTools } from "@/agent/mcp-bridge"
import {
  DEFAULT_BACKOFF_POLICY,
  type McpCallResult,
  type McpPrompt,
  type McpPromptResult,
  McpReconnectSupervisor,
  type McpResource,
  type McpResourceContent,
  type McpResult,
  type McpServerConfig,
  type McpToolDef,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"

// --- fake clock + timer queue (mirrors supervised-tasks hellgate idiom) ------

interface FakeClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => () => void
  advance: (ms: number) => void
}

const makeClock = (): FakeClock => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        timers.splice(timers.indexOf(next), 1)
        next.fn()
      }
    },
  }
}

// --- fake supervisable client (resources-aware) -----------------------------

const UNSUPPORTED = {
  ok: false as const,
  reason: "unsupported" as const,
  message: "server did not advertise the capability",
}

interface FakeClientControl {
  id: string
  client: SupervisableMcpClient
  crash: (reason?: string) => void
  resourceCalls: string[]
  started: boolean
  stopped: boolean
}

interface FakeClientOpts {
  /** Whether this client's server advertises `resources`. `undefined` ⇒ the
   *  whole resources method-set is OMITTED (mirrors `IsolatedMcpClient`). */
  supportsResources?: boolean
  /** Whether this client's server advertises `prompts`. Defaults to
   *  `supportsResources` when omitted (a server that speaks one usually speaks
   *  the other in these fixtures). */
  supportsPrompts?: boolean
  /** Tag woven into returned resource/prompt content, so a restart-swap test can
   *  assert which client served the call. */
  tag?: string
  /** Force every resources/prompts call to throw (proves the proxy try/catch). */
  throwOnCall?: boolean
  tools?: McpToolDef[]
  callResult?: McpCallResult
}

const makeFakeClient = (id: string, opts: FakeClientOpts = {}): FakeClientControl => {
  const handlers = new Set<(reason?: string) => void>()
  const tag = opts.tag ?? id
  const supportsPrompts = opts.supportsPrompts ?? opts.supportsResources
  const ctl: FakeClientControl = {
    id,
    resourceCalls: [],
    started: false,
    stopped: false,
    crash: (reason) => {
      for (const h of handlers) h(reason)
    },
    client: {
      async start() {
        ctl.started = true
      },
      async listTools() {
        return opts.tools ?? [{ name: "echo", description: "", inputSchema: { type: "object" } }]
      },
      async callTool(_name, _args) {
        return opts.callResult ?? { ok: true, content: "ok" }
      },
      async stop() {
        ctl.stopped = true
      },
      onExit(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      // OMIT the whole resources surface when supportsResources is undefined.
      ...(opts.supportsResources === undefined
        ? {}
        : {
            serverSupportsResources(): boolean {
              return opts.supportsResources === true
            },
            serverSupportsPrompts(): boolean {
              return supportsPrompts === true
            },
            async listResources(): Promise<McpResult<McpResource[]>> {
              ctl.resourceCalls.push("listResources")
              if (opts.throwOnCall) throw new Error("boom")
              // Mirror the real McpClient: capability-gate locally → typed
              // `unsupported` when the server didn't advertise `resources`.
              if (opts.supportsResources !== true) return UNSUPPORTED
              return { ok: true, value: [{ uri: `file://${tag}/a`, name: tag }] }
            },
            async readResource(uri: string): Promise<McpResult<McpResourceContent[]>> {
              ctl.resourceCalls.push(`readResource:${uri}`)
              if (opts.throwOnCall) throw new Error("boom")
              if (opts.supportsResources !== true) return UNSUPPORTED
              return { ok: true, value: [{ uri, text: `content-${tag}` }] }
            },
            async listPrompts(): Promise<McpResult<McpPrompt[]>> {
              ctl.resourceCalls.push("listPrompts")
              if (opts.throwOnCall) throw new Error("boom")
              if (supportsPrompts !== true) return UNSUPPORTED
              return { ok: true, value: [{ name: `prompt-${tag}` }] }
            },
            async getPrompt(
              name: string,
              _args?: Record<string, unknown>,
            ): Promise<McpResult<McpPromptResult>> {
              ctl.resourceCalls.push(`getPrompt:${name}`)
              if (opts.throwOnCall) throw new Error("boom")
              if (supportsPrompts !== true) return UNSUPPORTED
              return {
                ok: true,
                value: { messages: [{ role: "user", content: `msg-${tag}` }], description: tag },
              }
            },
          }),
    },
  }
  return ctl
}

const CONFIG: McpServerConfig = { name: "srv", command: ["x"] }

const baseDeps = (
  clock: FakeClock,
  factory: SupervisorDeps["factory"],
  extra: Partial<SupervisorDeps> = {},
): SupervisorDeps => ({
  factory,
  policy: { ...DEFAULT_BACKOFF_POLICY },
  now: clock.now,
  setTimer: clock.setTimer,
  random: () => 0, // deterministic delay === base
  ...extra,
})

/** Drive the supervisor to DEGRADED by exhausting fast + periodic phases. Each
 *  scheduled backoff fires an async `attemptRestart` whose `start()` rejects;
 *  flush the microtask chain (reject → catch → onStartFailure → scheduleRestart)
 *  between clock advances so the next timer exists before we advance again. */
const driveToDegraded = async (sup: McpReconnectSupervisor, clock: FakeClock): Promise<void> => {
  const p = DEFAULT_BACKOFF_POLICY
  for (let i = 0; i < (p.maxFastAttempts + p.maxPeriodicCycles + 4) * 2; i++) {
    clock.advance(p.periodicMaxMs)
    // Flush several microtask turns for the async restart chain.
    for (let f = 0; f < 6; f++) await Promise.resolve()
    if (sup.snapshot().state === "degraded") return
  }
}

// --- §1 healthy proxy returns the live client's HandleResult verbatim --------

describe("jun-06 RFC §1 healthy proxy", () => {
  it("each resources method delegates to the live client and returns its result", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsResources: true })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    expect(sup.serverSupportsResources()).toBe(true)
    expect(sup.serverSupportsPrompts()).toBe(true)

    const lr = await sup.listResources()
    expect(lr).toEqual({ ok: true, value: [{ uri: "file://c0/a", name: "c0" }] })
    const rr = await sup.readResource("file://c0/a")
    expect(rr).toEqual({ ok: true, value: [{ uri: "file://c0/a", text: "content-c0" }] })
    const lp = await sup.listPrompts()
    expect(lp).toEqual({ ok: true, value: [{ name: "prompt-c0" }] })
    const gp = await sup.getPrompt("prompt-c0", { x: 1 })
    expect(gp.ok).toBe(true)
    if (gp.ok) expect(gp.value.messages[0]?.content).toBe("msg-c0")
    await sup.stop()
  })
})

// --- §2 reconnect-gap (backing-off) ⇒ typed transport, never a throw --------

describe("jun-06 RFC §2 reconnect-gap fail-fast", () => {
  it("a readResource during backing-off returns transport failure (no throw)", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsResources: true })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    // Crash → backing-off (timer scheduled, not yet fired).
    live.crash("boom")
    expect(sup.snapshot().state).toBe("backing-off")

    const rr = await sup.readResource("file://x")
    expect(rr.ok).toBe(false)
    if (!rr.ok) expect(rr.reason).toBe("transport")
    await sup.stop()
  })

  it("in the aggregate, a gapped supervised member is skipped but a sibling hit still wins", async () => {
    const clock = makeClock()
    const live = makeFakeClient("sup", { supportsResources: true })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    const plain = makeFakeClient("plain", { supportsResources: true, tag: "plain" })
    // Build the aggregate over [supervisor, plain]. Both satisfy the shape.
    const handle = aggregateResourcesHandle([sup, plain.client as never])

    // Healthy: both contribute to the concat.
    const before = await handle.listResources()
    expect(before.ok).toBe(true)
    if (before.ok) expect(before.value.length).toBe(2)

    // Crash the supervised one → its arm returns transport (skipped in concat).
    live.crash("boom")
    expect(sup.snapshot().state).toBe("backing-off")
    const during = await handle.listResources()
    expect(during.ok).toBe(true)
    if (during.ok) {
      expect(during.value.length).toBe(1)
      expect(during.value[0]?.name).toBe("plain")
    }
    await sup.stop()
  })
})

// --- §3 queue mode: recover before cap ⇒ delegate; exceed ⇒ transport -------

describe("jun-06 RFC §3 reconnect-gap queue mode", () => {
  it("exceeding queueWaitMaxMs yields a transport failure (bounded, no hang)", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsResources: true })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client, { pendingPolicy: "queue", queueWaitMaxMs: 1000 }),
    )
    live.crash("boom")
    expect(sup.snapshot().state).toBe("backing-off")

    const pending = sup.listResources()
    // Advance past the queue cap WITHOUT recovery (timer base > cap so no restart).
    clock.advance(1000)
    const res = await pending
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("transport")
    await sup.stop()
  })
})

// --- §4 degraded ⇒ immediate transport, never throws, never hangs -----------

describe("jun-06 RFC §4 degraded", () => {
  it("every resources method returns transport immediately when degraded", async () => {
    const clock = makeClock()
    // A factory that always yields an unstartable client → restart keeps failing.
    const factory: SupervisorDeps["factory"] = () => ({
      async start() {
        throw new Error("never starts")
      },
      async listTools() {
        return []
      },
      async callTool() {
        return { ok: false, content: "" }
      },
      async stop() {},
      onExit() {
        return () => {}
      },
    })
    const sup = await McpReconnectSupervisor.create(CONFIG, baseDeps(clock, factory))
    await driveToDegraded(sup, clock)
    expect(sup.snapshot().state).toBe("degraded")

    for (const r of [
      await sup.listResources(),
      await sup.readResource("file://x"),
      await sup.listPrompts(),
      await sup.getPrompt("p"),
    ]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe("transport")
    }
    await sup.stop()
  })
})

// --- §5 restart-swap transparency: same handle hits the NEW client ----------

describe("jun-06 RFC §5 survives restart — no stale capture", () => {
  it("after crash+restart, readResource returns the NEW client's content", async () => {
    const clock = makeClock()
    const first = makeFakeClient("first", { supportsResources: true, tag: "first" })
    const second = makeFakeClient("second", { supportsResources: true, tag: "second" })
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    expect(sup.current()).toBe(first.client)

    const r1 = await sup.readResource("file://x")
    expect(r1.ok && r1.value[0]?.text).toBe("content-first")

    first.crash("boom")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.snapshot().state).toBe("healthy")
    expect(sup.current()).toBe(second.client)

    // The SAME supervisor now resolves the NEW client per call.
    const r2 = await sup.readResource("file://x")
    expect(r2.ok && r2.value[0]?.text).toBe("content-second")
    // The dead client saw no traffic after the restart.
    expect(first.resourceCalls).toEqual(["readResource:file://x"])
    await sup.stop()
  })
})

// --- §6 capability drift across a restart -----------------------------------

describe("jun-06 RFC §6 capability drift across restart", () => {
  it("a client that loses resources after restart flips serverSupportsResources to false", async () => {
    const clock = makeClock()
    const first = makeFakeClient("first", { supportsResources: true })
    const second = makeFakeClient("second", { supportsResources: false, supportsPrompts: false })
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    expect(sup.serverSupportsResources()).toBe(true)

    first.crash("boom")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.current()).toBe(second.client)

    // Capability re-evaluated against the NEW client → false.
    expect(sup.serverSupportsResources()).toBe(false)
    // And the proxy now returns unsupported (the new client lacks the methods).
    const r = await sup.listResources()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unsupported")
    await sup.stop()
  })
})

// --- §7 method-set absent ⇒ unsupported, never a null-deref ------------------

describe("jun-06 RFC §7 method-set absent", () => {
  it("a client with no resources methods ⇒ serverSupportsResources false + unsupported call", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0") // supportsResources undefined → methods omitted
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    expect(sup.serverSupportsResources()).toBe(false)
    expect(sup.serverSupportsPrompts()).toBe(false)
    const r = await sup.readResource("file://x")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unsupported")
    const p = await sup.getPrompt("p")
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toBe("unsupported")
    await sup.stop()
  })

  it("a non-conforming method that THROWS is caught and mapped to transport", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsResources: true, throwOnCall: true })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    // Healthy, but the underlying method throws — the proxy must NOT propagate it.
    const r = await sup.listResources()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("transport")
    await sup.stop()
  })
})

// --- §8 mixed aggregate: supervised + plain concat & route ------------------

describe("jun-06 RFC §8 mixed aggregate", () => {
  it("loadMcpTools(supervised, resources-capable) feeds the aggregate; concat across both", async () => {
    const clock = makeClock()
    const supLive = makeFakeClient("sup", { supportsResources: true, tag: "sup" })
    const { tools, clients, resources } = await loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => baseDeps(clock, () => supLive.client),
    })
    expect(Array.isArray(tools)).toBe(true)
    // The supervised resources-capable server contributed a handle.
    expect(resources).toBeDefined()
    if (resources) {
      const lr = await resources.listResources()
      expect(lr.ok).toBe(true)
      if (lr.ok) expect(lr.value.map((e) => e.uri)).toContain("file://sup/a")
      // route: readResource finds the supervised server's content.
      const rr = await resources.readResource("file://sup/a")
      expect(rr.ok).toBe(true)
      if (rr.ok) expect(rr.value[0]?.text).toBe("content-sup")
    }
    for (const c of clients) await c.stop()
  })

  it("aggregate concats a plain client + a supervised client", async () => {
    const clock = makeClock()
    const supLive = makeFakeClient("sup", { supportsResources: true, tag: "sup" })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => supLive.client),
    )
    const plain = makeFakeClient("plain", { supportsResources: true, tag: "plain" })
    const handle = aggregateResourcesHandle([plain.client as never, sup])
    const lr = await handle.listResources()
    expect(lr.ok).toBe(true)
    if (lr.ok) {
      expect(lr.value.map((e) => e.name).sort()).toEqual(["plain", "sup"])
    }
    await sup.stop()
  })
})

// --- §9 default-OFF byte-identical: no resources advertised ⇒ no surface -----

describe("jun-06 RFC §9 default-OFF byte-identical", () => {
  it("a supervised server advertising NEITHER resources nor prompts ⇒ no resources handle", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsResources: false, supportsPrompts: false })
    const { resources, clients } = await loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => baseDeps(clock, () => live.client),
    })
    expect(resources).toBeUndefined()
    for (const c of clients) await c.stop()
  })

  it("a supervised client with NO resources methods at all ⇒ no resources handle", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0") // methods omitted entirely
    const { resources, clients } = await loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => baseDeps(clock, () => live.client),
    })
    expect(resources).toBeUndefined()
    for (const c of clients) await c.stop()
  })
})
