/**
 * ADR-0415 — HookBus auto-subscribe + RuntimeFacade port exposure — hellgate.
 *
 * Wave-3 left two deliberate holds:
 *
 *   Part 2 — the composition root never passed a real `hookBus` to
 *            `wireObservability`, so run-ledger-attribution NEVER subscribed in
 *            production; and the promoted ADR-0414 `runLedger` /
 *            `approvalStateMachine` AgentConfig slots were never populated.
 *   Part 3 — `RuntimeFacade` (web-daemon surface) did not expose the 4 ports,
 *            so the ADR-0408 observability-emitter read nothing.
 *
 * This battery pins both wires WITHOUT touching the sealed Wave-1/2/3 slices:
 *
 *   - `resolveObservabilityWire(env, {hookBus})` with `QUANTA_OBSERVABILITY=on`
 *     ⇒ hookBus.subscribe called once for `post_tool_use`; firing a fake
 *     bash-background `post_tool_use` event ⇒ `runLedger.start` invoked.
 *   - `QUANTA_OBSERVABILITY` absent ⇒ no subscribe, no ports (byte-identical).
 *   - `buildBaseFromArgs` with the gate on ⇒ `config.runLedger` +
 *     `config.approvalStateMachine` populated; gate off ⇒ both undefined.
 *   - RuntimeFacade getters return the wire ports when enabled, undefined when
 *     disabled.
 *   - observability-emitter fed the facade ports ⇒ emits a snapshot.
 *   - detach() unsubscribes (fake bus unsubscribe count == 1); idempotent.
 *   - Double-wire ⇒ no double-subscription on a single handle's detach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs, resolveObservabilityWire } from "@/../src/apps/agent/index"
import { createObservabilityEmitter } from "@/../src/apps/web-daemon/observability-emitter"
import {
  attachObservabilityPorts,
  type ObservableRuntimeFacade,
} from "@/../src/apps/web-daemon/runtime-factory"
import { HookBus } from "@/agent"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  type ObservabilityWireOpts,
  wireObservability as wireObservabilityRaw,
} from "@/agent/observability-wire"
import { createObjectiveStore } from "@/objective"
import type { RuntimeFacade } from "@/sdk/runtime"

/** RFC-03 C2 — the objective authority is INJECTED into the wire (no longer
 *  minted there; construction owned by the assembly builder — constructor-owner
 *  ratchet). This wrapper supplies the objective the composition root injects so
 *  the enabled-path invariants are unchanged; OFF path untouched. */
const wireObservability = (opts: ObservabilityWireOpts = {}): ObservabilityWireHandle =>
  opts.enabled === true && opts.objective === undefined
    ? wireObservabilityRaw({
        ...opts,
        objective: createObjectiveStore(opts.now !== undefined ? { now: opts.now } : {}),
      })
    : wireObservabilityRaw(opts)

// -----------------------------------------------------------------------------
// fakes
// -----------------------------------------------------------------------------

/** A `HookBus` subclass that records every `.on(...)` registration + lets the
 *  test fire events through the real registered handlers. This is the SHAPE
 *  the composition root passes to `resolveObservabilityWire` (a live
 *  `HookBus`), so it exercises the production adapter (`toObservabilityHookBus`
 *  → `bus.on(event, handler)`). `HookBus.on()` has no public unsubscribe, so
 *  the adapter's detach is a no-op — unsubscribe semantics are pinned
 *  separately against `wireObservability` with an `ObservabilityHookBus` fake
 *  below. */
class RecordingHookBus extends HookBus {
  readonly registered: Array<{ event: string }> = []
  override on(type: never, handler: never, options?: never): this {
    this.registered.push({ event: type as unknown as string })
    return super.on(type, handler, options)
  }
  get subscribeCount(): number {
    return this.registered.length
  }
  async fire(event: string, payload: unknown): Promise<void> {
    await this.emit({ type: event, ...(payload as object) } as never)
  }
}

/** A duck-typed `ObservabilityHookBus` that records subscribe + unsubscribe
 *  calls and fires events into every still-active subscriber. Used to drive
 *  `wireObservability` DIRECTLY (consume-only — the wire slice is sealed) so
 *  detach()/idempotency/double-wire unsubscribe semantics are observable. */
const fakeObservabilityBus = () => {
  const subs: Array<{ event: string; handler: (e: unknown) => void; active: boolean }> = []
  let unsubscribeCount = 0
  const bus: ObservabilityHookBus = {
    subscribe: (event, handler) => {
      const entry = { event, handler, active: true }
      subs.push(entry)
      return () => {
        unsubscribeCount += 1
        entry.active = false
      }
    },
  }
  return {
    bus,
    subs,
    get subscribeCount() {
      return subs.length
    },
    get unsubscribeCount() {
      return unsubscribeCount
    },
    fire(event: string, payload: unknown): number {
      let fired = 0
      for (const s of subs) {
        if (s.active && s.event === event) {
          s.handler(payload)
          fired += 1
        }
      }
      return fired
    },
  }
}

/** Wire `wireObservability` directly with a duck-typed bus + repoRoot so the
 *  4 ports populate (mirrors what `resolveObservabilityWire` does internally,
 *  minus the env projection). */
const wireWithBus = (bus: ObservabilityHookBus, enabled: boolean): ObservabilityWireHandle =>
  wireObservability(enabled ? { enabled: true, repoRoot: process.cwd(), hookBus: bus } : {})

/** A bash background-launch `post_tool_use` event — the exact shape the
 *  default ledger matcher recognizes as a `start kind:"shell"`. */
const bashBackgroundEvent = (shellId = "sh-1") => ({
  type: "post_tool_use",
  name: "bash",
  ok: true,
  input: { command: "sleep 100 &" },
  output: `[bash background] shellId=${shellId} status=running`,
})

const ENV_KEY = "QUANTA_OBSERVABILITY"

describe("ADR-0415 Part 2 — resolveObservabilityWire(env, {hookBus}) [real HookBus adapter]", () => {
  test("[1] gate ON + live HookBus ⇒ on() called once for post_tool_use", () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv, {
      hookBus: bus,
    })
    expect(bus.subscribeCount).toBe(1)
    expect(bus.registered[0]?.event).toBe("post_tool_use")
    handle.detach()
  })

  test("[2] gate ON ⇒ ledger/ASM/shadow ports + bash-background event drives runLedger.start", async () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv, {
      hookBus: bus,
    })
    // RFC-03 H1 — the HOST wire no longer mints an objective; the ONE gated
    // authority is owned by the assembler and late-bound onto the ASM there.
    expect(handle.objective).toBeUndefined()
    expect(handle.runLedger).toBeDefined()
    expect(handle.approvalStateMachine).toBeDefined()
    // shadowVerify present too (repoRoot defaults to process.cwd()).
    expect(handle.shadowVerify).toBeDefined()

    expect(handle.runLedger?.get("sh-1")).toBeNull()
    // Emitting through the LIVE bus the wire subscribed to drives attribution.
    await bus.fire("post_tool_use", bashBackgroundEvent("sh-1"))
    expect(handle.runLedger?.get("sh-1")?.status).toBe("running")
    expect(handle.runLedger?.get("sh-1")?.kind).toBe("shell")
    handle.detach()
  })

  test("[3] gate absent ⇒ no subscribe + zero ports (byte-identical default-OFF)", () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({} as NodeJS.ProcessEnv, { hookBus: bus })
    expect(bus.subscribeCount).toBe(0)
    expect(handle.objective).toBeUndefined()
    expect(handle.runLedger).toBeUndefined()
    expect(handle.approvalStateMachine).toBeUndefined()
    expect(handle.shadowVerify).toBeUndefined()
  })

  test("[4] gate falsy/garbage ⇒ noop (canonical gate vocab — default-OFF)", () => {
    for (const raw of ["off", "0", "false", "no", "", "garbage"]) {
      const bus = new RecordingHookBus()
      const handle = resolveObservabilityWire({ [ENV_KEY]: raw } as NodeJS.ProcessEnv, {
        hookBus: bus,
      })
      expect(bus.subscribeCount).toBe(0)
      expect(handle.runLedger).toBeUndefined()
    }
  })

  test("[4b] gate any truthy token (1/on/true/ON) ⇒ wired (no more strict-'on' footgun)", () => {
    for (const raw of ["1", "on", "true", "ON", "On", "yes"]) {
      const bus = new RecordingHookBus()
      const handle = resolveObservabilityWire({ [ENV_KEY]: raw } as NodeJS.ProcessEnv, {
        hookBus: bus,
      })
      expect(bus.subscribeCount).toBe(1)
      expect(handle.runLedger).toBeDefined()
    }
  })

  test("[5] gate ON without hookBus ⇒ ports present, no subscribe, no throw", () => {
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv)
    expect(handle.runLedger).toBeDefined()
    // RFC-03 H1 — host wire mints NO objective (owned by the gated assembler path).
    expect(handle.objective).toBeUndefined()
    // No hookBus ⇒ attribution silently inert; ledger has no entries.
    expect(handle.runLedger?.list().length).toBe(0)
    expect(() => handle.detach()).not.toThrow()
  })

  test("[6] live HookBus adapter detach is a NO-OP (HookBus has no off()) — no throw", () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv, {
      hookBus: bus,
    })
    // Detach drops the wire's local refs; the real bus stays subscribed (the
    // composition root registers handlers once for the process lifetime).
    expect(() => handle.detach()).not.toThrow()
  })
})

describe("ADR-0415 Part 2 — wireObservability detach semantics [ObservabilityHookBus fake]", () => {
  test("[7] detach() unsubscribes exactly once", () => {
    const fake = fakeObservabilityBus()
    const handle = wireWithBus(fake.bus, true)
    expect(fake.unsubscribeCount).toBe(0)
    handle.detach()
    expect(fake.unsubscribeCount).toBe(1)
  })

  test("[8] detach() idempotent ⇒ no double-unsubscribe, no throw", () => {
    const fake = fakeObservabilityBus()
    const handle = wireWithBus(fake.bus, true)
    handle.detach()
    handle.detach()
    handle.detach()
    expect(fake.unsubscribeCount).toBe(1)
  })

  test("[9] subscribe THROWS ⇒ wire still returns ports + detach is noop (NO-THROW)", () => {
    const throwingBus: ObservabilityHookBus = {
      subscribe: () => {
        throw new Error("bus rejected registration")
      },
    }
    let handle: ObservabilityWireHandle | undefined
    expect(() => {
      handle = wireWithBus(throwingBus, true)
    }).not.toThrow()
    expect(handle?.runLedger).toBeDefined()
    expect(() => handle?.detach()).not.toThrow()
  })

  test("[10] double-wire ⇒ two independent handles, two subscriptions; detach is isolated", () => {
    const fake = fakeObservabilityBus()
    const a = wireWithBus(fake.bus, true)
    const b = wireWithBus(fake.bus, true)
    expect(fake.subscribeCount).toBe(2)
    a.detach()
    expect(fake.unsubscribeCount).toBe(1)
    // b still active ⇒ firing reaches b's subscriber (a is inert).
    const fired = fake.fire("post_tool_use", bashBackgroundEvent("sh-2"))
    expect(fired).toBe(1)
    expect(b.runLedger?.get("sh-2")?.status).toBe("running")
    expect(a.runLedger?.get("sh-2")).toBeNull()
    b.detach()
    expect(fake.unsubscribeCount).toBe(2)
  })

  test("[10b] single wire ⇒ exactly one subscription, exactly one unsubscribe on detach", () => {
    const fake = fakeObservabilityBus()
    const handle = wireWithBus(fake.bus, true)
    expect(fake.subscribeCount).toBe(1)
    expect(fake.subs[0]?.event).toBe("post_tool_use")
    handle.detach()
    expect(fake.unsubscribeCount).toBe(1)
  })

  test("[10c] gate OFF ⇒ no subscribe, detach noop", () => {
    const fake = fakeObservabilityBus()
    const handle = wireWithBus(fake.bus, false)
    expect(fake.subscribeCount).toBe(0)
    handle.detach()
    expect(fake.unsubscribeCount).toBe(0)
  })
})

describe("ADR-0415 Part 2 — buildBaseFromArgs AgentConfig injection", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY
  const prevObs = process.env[ENV_KEY]

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
  })

  afterEach(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
    if (prevObs === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevObs
  })

  test("[11] gate ON ⇒ runLedger + approvalStateMachine populated; objective is NOT set by observability (RFC-03 H1)", () => {
    process.env[ENV_KEY] = "on"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.runLedger).toBeDefined()
    expect(base.approvalStateMachine).toBeDefined()
    // RFC-03 H1 (HITL bypass fix) — the observability wire NO LONGER mints an
    // objective authority. `base.objective` is only ever set by the GATED
    // `maybeWireObjective` (assembler, behind QUANTA_OBJECTIVE_TOOLS), so
    // QUANTA_OBSERVABILITY alone must NOT populate it (else an ungated authority
    // would win + `objective_*` tools would leak under observability alone).
    expect(base.objective).toBeUndefined()
  })

  test("[12] gate ON ⇒ hooks bus present AND attribution is subscribed end-to-end", async () => {
    process.env[ENV_KEY] = "on"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.hooks).toBeDefined()
    // Emitting a real post_tool_use through the live bus drives the ledger.
    await base.hooks?.emit({
      type: "post_tool_use",
      name: "bash",
      ok: true,
      input: { command: "sleep 100 &" },
      output: "[bash background] shellId=sh-cfg status=running",
    })
    expect(base.runLedger?.get("sh-cfg")?.status).toBe("running")
  })

  test("[13] gate OFF ⇒ runLedger + approvalStateMachine undefined (byte-identical)", () => {
    delete process.env[ENV_KEY]
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect(base.runLedger).toBeUndefined()
    expect(base.approvalStateMachine).toBeUndefined()
    expect(base.objective).toBeUndefined()
    // No observability ⇒ no bus is attached by THIS wire (default-OFF).
    expect(base.hooks).toBeUndefined()
  })

  test("[14] gate OFF ⇒ no observability keys present on base at all", () => {
    delete process.env[ENV_KEY]
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    expect("runLedger" in base).toBe(false)
    expect("approvalStateMachine" in base).toBe(false)
  })
})

describe("ADR-0415 Part 3 — RuntimeFacade port exposure", () => {
  /** Minimal RuntimeFacade stub — Part 3 only reads the 4 attached getters. */
  const stubFacade = (): RuntimeFacade => ({
    createSession: async () => {
      throw new Error("not used")
    },
    close: async () => undefined,
  })

  test("[15] attachObservabilityPorts(facade, handle-on) ⇒ getters return wire ports", () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv, {
      hookBus: bus,
    })
    const facade: ObservableRuntimeFacade = attachObservabilityPorts(stubFacade(), handle)
    expect(facade.objective).toBe(handle.objective)
    expect(facade.runLedger).toBe(handle.runLedger)
    expect(facade.approvalStateMachine).toBe(handle.approvalStateMachine)
    expect(facade.shadowVerify).toBe(handle.shadowVerify)
    handle.detach()
  })

  test("[16] attachObservabilityPorts(facade, handle-off) ⇒ getters undefined", () => {
    const handle = resolveObservabilityWire({} as NodeJS.ProcessEnv)
    const facade: ObservableRuntimeFacade = attachObservabilityPorts(stubFacade(), handle)
    expect(facade.objective).toBeUndefined()
    expect(facade.runLedger).toBeUndefined()
    expect(facade.approvalStateMachine).toBeUndefined()
    expect(facade.shadowVerify).toBeUndefined()
  })

  test("[17] attach preserves the underlying facade methods (createSession/close)", async () => {
    const handle = resolveObservabilityWire({} as NodeJS.ProcessEnv)
    let closed = false
    const base: RuntimeFacade = {
      createSession: async () => {
        throw new Error("not used")
      },
      close: async () => {
        closed = true
      },
    }
    const facade = attachObservabilityPorts(base, handle)
    await facade.close()
    expect(closed).toBe(true)
  })

  test("[18] emitter fed facade ports (gate ON) ⇒ emits a snapshot", async () => {
    const bus = new RecordingHookBus()
    const handle = resolveObservabilityWire({ [ENV_KEY]: "on" } as NodeJS.ProcessEnv, {
      hookBus: bus,
    })
    const facade = attachObservabilityPorts(stubFacade(), handle)
    // Seed a run via the LIVE bus so the snapshot has content.
    await bus.fire("post_tool_use", bashBackgroundEvent("sh-emit"))

    const frames: string[] = []
    const emitter = createObservabilityEmitter({
      ws: { send: (frame) => frames.push(frame) },
      ...(facade.objective !== undefined ? { objective: facade.objective } : {}),
      ...(facade.runLedger !== undefined ? { runLedger: facade.runLedger } : {}),
      ...(facade.approvalStateMachine !== undefined
        ? { approvalSM: facade.approvalStateMachine }
        : {}),
    })
    emitter.tick()
    expect(frames.length).toBe(1)
    expect(frames[0]).toContain("observability.snapshot")
    expect(frames[0]).toContain("sh-emit")
    emitter.stop()
    handle.detach()
  })

  test("[19] emitter fed an EMPTY facade (gate OFF) ⇒ emits nothing", () => {
    const handle = resolveObservabilityWire({} as NodeJS.ProcessEnv)
    const facade = attachObservabilityPorts(stubFacade(), handle)
    const frames: string[] = []
    const emitter = createObservabilityEmitter({
      ws: { send: (frame) => frames.push(frame) },
      ...(facade.objective !== undefined ? { objective: facade.objective } : {}),
      ...(facade.runLedger !== undefined ? { runLedger: facade.runLedger } : {}),
      ...(facade.approvalStateMachine !== undefined
        ? { approvalSM: facade.approvalStateMachine }
        : {}),
    })
    emitter.tick()
    expect(frames.length).toBe(0)
    emitter.stop()
  })
})
