/**
 * ADR-0161 Phase D — Model reroute hellgate.
 *
 * preference / fallback chain / all-unavailable / probe-throws / dedupe /
 * empty preference / special chars / long chain.
 */

import { describe, expect, test } from "bun:test"
import type { EngineAutomation } from "@/scheduler/automation-engine"
import { chooseModel, rerouteResultToRouteEvent } from "@/scheduler/model-reroute"
import {
  AUTOMATION_ENV_FLAG,
  assembleAutomation,
} from "@/scheduler/runtime-wire"
import type { AgentLoopPort, ModelAvailabilityPort, RRule } from "@/scheduler/types"
import type { AgentEvent } from "@/stream"

const portOf = (available: ReadonlyArray<string>): ModelAvailabilityPort => ({
  isAvailable: async (model) => available.includes(model),
})

const throwingPort: ModelAvailabilityPort = {
  isAvailable: async () => {
    throw new Error("network down")
  },
}

describe("chooseModel hellgate", () => {
  test("[1] preference available → preference-available", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4"],
      availability: portOf(["gpt-5", "claude-4"]),
    })
    expect(r.chosen).toBe("gpt-5")
    expect(r.reason).toBe("preference-available")
    expect(r.fallbackIndex).toBeUndefined()
  })

  test("[2] preference unavail + first fallback available → fallback idx=0", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4", "gpt-4-mini"],
      availability: portOf(["claude-4"]),
    })
    expect(r.chosen).toBe("claude-4")
    expect(r.reason).toBe("fallback")
    expect(r.fallbackIndex).toBe(0)
  })

  test("[3] preference + first 2 fallbacks unavail + 3rd available → idx=2", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["m1", "m2", "m3"],
      availability: portOf(["m3"]),
    })
    expect(r.chosen).toBe("m3")
    expect(r.reason).toBe("fallback")
    expect(r.fallbackIndex).toBe(2)
  })

  test("[4] all unavailable → all-unavailable + chosen=preference", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4", "gpt-4-mini"],
      availability: portOf([]),
    })
    expect(r.reason).toBe("all-unavailable")
    expect(r.chosen).toBe("gpt-5")
  })

  test("[5] empty fallbacks + preference unavail → all-unavailable", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: [],
      availability: portOf([]),
    })
    expect(r.reason).toBe("all-unavailable")
  })

  test("[6] availability throws → treated as unavailable", async () => {
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4"],
      availability: throwingPort,
    })
    expect(r.reason).toBe("all-unavailable")
  })

  test("[7] preference duplicated in fallbacks → probed only once", async () => {
    let probeCount = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => {
        probeCount += 1
        return m === "claude-4"
      },
    }
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["gpt-5", "claude-4"],
      availability: port,
    })
    expect(r.chosen).toBe("claude-4")
    // gpt-5 probed once (not twice), claude-4 probed once. Total 2 probes.
    expect(probeCount).toBe(2)
  })

  test("[8] special chars in model name passthrough", async () => {
    const r = await chooseModel({
      preference: "anthropic/claude-3.5-sonnet@20241022",
      fallbacks: [],
      availability: portOf(["anthropic/claude-3.5-sonnet@20241022"]),
    })
    expect(r.chosen).toBe("anthropic/claude-3.5-sonnet@20241022")
  })

  test("[9] very long fallback chain — stops at first available", async () => {
    const chain = Array.from({ length: 100 }, (_, i) => `m${i}`)
    let probeCount = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => {
        probeCount += 1
        return m === "m50"
      },
    }
    const r = await chooseModel({
      preference: "preferred",
      fallbacks: chain,
      availability: port,
    })
    expect(r.chosen).toBe("m50")
    expect(r.fallbackIndex).toBe(50)
    // probe: preferred + m0..m50 = 52
    expect(probeCount).toBe(52)
  })

  test("[10] empty preference → all-unavailable without probing", async () => {
    let probed = false
    const port: ModelAvailabilityPort = {
      isAvailable: async () => {
        probed = true
        return true
      },
    }
    const r = await chooseModel({
      preference: "",
      fallbacks: ["claude-4"],
      availability: port,
    })
    expect(r.reason).toBe("all-unavailable")
    expect(probed).toBe(false)
  })

  // =========================================================================
  // ADVERSARIAL — Phase C hellgate hardening (round 3)
  //
  // 7+ scenarios that probe circular fallback, special chars, timeout,
  // concurrent invocation, network 5xx cascade, preference corruption.
  // Each assertion message names the attack.
  // =========================================================================

  test("[A1][adversarial] circular fallback chain (A → B → A → B) is NOT loop-forever — dedupe halts", async () => {
    // Attack: a misconfigured caller hands a circular fallbacks list. The
    // dedupe-keep invariant MUST collapse to {A,B} and probe each exactly
    // once. NO infinite loop, NO unbounded probe count.
    let probes = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => {
        probes += 1
        return m === "B" // B is available
      },
    }
    const r = await chooseModel({
      preference: "A",
      fallbacks: ["B", "A", "B", "A", "B"],
      availability: port,
    })
    expect(r.chosen).toBe("B")
    expect(r.reason).toBe("fallback")
    // A probed once (preference) + B probed once = 2 total, not 6.
    expect(probes).toBe(2)
  })

  test("[A2][adversarial] all-unavailable returns EXPLICIT reason, not silent empty/null", async () => {
    // Attack: a caller that branches on .chosen alone (without checking
    // .reason) would not know all models are unavailable. The contract is
    // explicit "all-unavailable" + .chosen = preference (preserve intent).
    const r = await chooseModel({
      preference: "gpt-5",
      fallbacks: ["claude-4", "gpt-4"],
      availability: portOf([]),
    })
    expect(r.reason).toBe("all-unavailable")
    expect(r.chosen).toBe("gpt-5") // preserves intent — NOT null / "" / undefined
    expect(r.fallbackIndex).toBeUndefined() // no fallback fired
  })

  test("[A3][adversarial] model id with control chars (NUL / newline / \\r) passes through verbatim", async () => {
    // Attack: a corrupt automation file delivers a model id containing
    // \0 / \n / \r. The reroute MUST NOT munge the id (would corrupt the
    // downstream wire payload silently); it MUST pass the id verbatim and
    // let the LLM adapter surface a 400 with the exact bad id visible.
    const evil = "anth\x00ropic\nclaude-3.5\rsonnet"
    const r = await chooseModel({
      preference: evil,
      fallbacks: [],
      availability: portOf([evil]),
    })
    expect(r.chosen).toBe(evil)
    expect(r.reason).toBe("preference-available")
  })

  test("[A4][adversarial] model id with Unicode (emoji + RTL + zalgo) passthrough", async () => {
    // Attack: an attacker submits a model id with unicode bidi / zero-width
    // chars trying to spoof telemetry. The reroute MUST be byte-faithful
    // (no NFC normalization, no width-handling) so the operator's logs
    // show exactly what was requested.
    const zalgo = "claude-3.5-🚀-‮sonnet-ž̴̧̢̛̮̗̪̬̦͖̟̬͚̋͊̍̃͠"
    const r = await chooseModel({
      preference: zalgo,
      fallbacks: [],
      availability: portOf([zalgo]),
    })
    expect(r.chosen).toBe(zalgo)
  })

  test("[A5][adversarial] availability probe that NEVER resolves (timeout simulation) — caller controls timeout", async () => {
    // Attack: a vendor health endpoint stalls indefinitely. The reroute
    // itself has no timeout (per design — caller wraps with AbortSignal).
    // We assert the function awaits the probe; caller's responsibility to
    // race with a timer. This pins the contract — if a future hardening
    // adds an internal timeout, this hellgate flips to verify it.
    const port: ModelAvailabilityPort = {
      isAvailable: async () => {
        // Simulate a 1ms-resolve to keep the test fast — the property
        // we check is "awaits async result" not "ms-precision".
        await new Promise((resolve) => setTimeout(resolve, 1))
        return true
      },
    }
    const r = await chooseModel({
      preference: "slow-model",
      fallbacks: [],
      availability: port,
    })
    expect(r.chosen).toBe("slow-model")
    expect(r.reason).toBe("preference-available")
  })

  test("[A6][adversarial] 100-concurrent chooseModel invocations — no state corruption", async () => {
    // Attack: a state-leak (module-scoped dedupe set, shared seen-array)
    // would cause concurrent invocations to interfere. We invoke 100 times
    // in parallel with overlapping model ids and assert each gets its
    // own correct answer.
    const port: ModelAvailabilityPort = {
      isAvailable: async (m) => m.endsWith("-ok"),
    }
    const calls = Array.from({ length: 100 }, async (_, i) => {
      const r = await chooseModel({
        preference: `m${i}`,
        fallbacks: [`m${i}-ok`],
        availability: port,
      })
      return { i, r }
    })
    const results = await Promise.all(calls)
    for (const { i, r } of results) {
      expect(r.chosen).toBe(`m${i}-ok`)
      expect(r.reason).toBe("fallback")
      expect(r.fallbackIndex).toBe(0)
    }
  })

  test("[A7][adversarial] availability probe REJECTS with stack-trace-leaking error → swallowed safely", async () => {
    // Attack: a vendor port throws an Error whose message contains a
    // bearer token (a common bug — http client errors carry the full
    // request URL with query-string credentials). The reroute MUST treat
    // as unavailable and MUST NOT propagate / log the secret.
    const secret = "Bearer-sk-LEAKY-FROM-PROBE-1234567"
    const port: ModelAvailabilityPort = {
      isAvailable: async () => {
        throw new Error(`401 Unauthorized — ${secret}`)
      },
    }
    const r = await chooseModel({
      preference: "m1",
      fallbacks: ["m2"],
      availability: port,
    })
    // Treated as all-unavailable (NO-THROW propagation).
    expect(r.reason).toBe("all-unavailable")
    expect(r.chosen).toBe("m1")
    // No secret in any field of the result — it's a closed structure so
    // this is verified by the absence of any field that could carry it,
    // but we assert structurally too.
    expect(JSON.stringify(r).includes(secret)).toBe(false)
  })

  test("[A8][adversarial] preference with leading/trailing whitespace is NOT trimmed (byte-faithful)", async () => {
    // Attack: a corrupted preferences file injects "  gpt-5  ". The
    // reroute MUST be byte-faithful — trimming would silently match a
    // legitimate "gpt-5" against the whitespace-decorated id (or vice
    // versa, masking a real upstream typo). Pass through as-is.
    const r = await chooseModel({
      preference: "  gpt-5  ",
      fallbacks: [],
      availability: portOf(["gpt-5"]), // NOT the whitespace-padded id
    })
    // Padded id is NOT available — drops through to all-unavailable.
    expect(r.reason).toBe("all-unavailable")
    expect(r.chosen).toBe("  gpt-5  ") // preserves the corrupted form
  })

  test("[A9][adversarial] network cascade — all 10 fallbacks throw, NONE silently succeeds", async () => {
    // Attack: a regional outage takes down every vendor in the fallback
    // chain. Each probe throws 503. The reroute MUST exhaust the chain
    // and return all-unavailable — never a silent success / null return.
    let probeCount = 0
    const port: ModelAvailabilityPort = {
      isAvailable: async () => {
        probeCount += 1
        throw new Error("503 Service Unavailable")
      },
    }
    const fallbacks = Array.from({ length: 10 }, (_, i) => `m${i}`)
    const r = await chooseModel({
      preference: "primary",
      fallbacks,
      availability: port,
    })
    expect(r.reason).toBe("all-unavailable")
    expect(probeCount).toBe(11) // 1 preference + 10 fallbacks, every one probed
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RFC02-3 (A8) — scheduler model_route_changed projection.
//
// The scheduler OWNS its route reason: ONLY the `fallback` arm (preference was
// down, a fallback was chosen) is a transition → `preferred_unavailable`. The
// `preference-available` / `all-unavailable` arms emit NOTHING.
// Crown proof: drive the REAL `assembleAutomation` handler (front door) with a
// wired sink + an availability probe that forces a fallback, and assert the
// scheduler-owned event reaches the sink. Red-on-injection: NO sink ⇒ no event.
// ═══════════════════════════════════════════════════════════════════════════

const RULE: RRule = { freq: "DAILY", interval: 1 }
const noopLoop: AgentLoopPort = { enqueueUserMessage: async () => {} }
const availabilityOf = (up: ReadonlySet<string>): ModelAvailabilityPort => ({
  isAvailable: async (m) => up.has(m),
})
const automationOf = (over: Partial<EngineAutomation>): EngineAutomation => ({
  id: "a1",
  title: "t",
  rule: RULE,
  prompt: "do it",
  nextRunAt: 0,
  status: "scheduled",
  createdAt: 0,
  fireCount: 0,
  ...over,
})

describe("RFC02-3 A8 — rerouteResultToRouteEvent (pure projection)", () => {
  test("[fallback] a rerouted-to-fallback result → preferred_unavailable event from→to", () => {
    const ev = rerouteResultToRouteEvent(
      { preference: "gpt-5", result: { chosen: "claude-4", reason: "fallback", fallbackIndex: 0 } },
      { at: 99, turnId: "auto-1" },
    )
    expect(ev).toEqual({
      type: "model_route_changed",
      fromModel: "gpt-5",
      toModel: "claude-4",
      reason: "preferred_unavailable",
      routeKind: "scheduler_reroute",
      at: 99,
      turnId: "auto-1",
    })
  })

  test("[non-transition] preference-available ⇒ null (nothing changed)", () => {
    const ev = rerouteResultToRouteEvent(
      { preference: "gpt-5", result: { chosen: "gpt-5", reason: "preference-available" } },
      { at: 1 },
    )
    expect(ev).toBeNull()
  })

  test("[non-transition] all-unavailable ⇒ null (no model ran)", () => {
    const ev = rerouteResultToRouteEvent(
      { preference: "gpt-5", result: { chosen: "gpt-5", reason: "all-unavailable" } },
      { at: 1 },
    )
    expect(ev).toBeNull()
  })
})

describe("RFC02-3 A8 — scheduler front-door route transition", () => {
  const makeEnv = (o: Record<string, string>): { get: (k: string) => string | undefined } => {
    const m = new Map(Object.entries(o))
    return { get: (k) => m.get(k) }
  }

  test("[crown] a fire whose preference is DOWN reroutes → handler emits the scheduler-owned event", async () => {
    const routeEvents: AgentEvent[] = []
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: noopLoop,
      // preference "gpt-5.5" is DOWN; fallback "gpt-5.4" is UP.
      modelAvailability: availabilityOf(new Set(["gpt-5.4"])),
      onModelReroute: (ev) => routeEvents.push(ev),
      now: () => 1234,
    })
    if (slot === null) throw new Error("unreachable")
    await slot.handler(automationOf({ model: "gpt-5.5", modelFallbacks: ["gpt-5.4", "gpt-5"] }))
    expect(routeEvents).toEqual([
      {
        type: "model_route_changed",
        fromModel: "gpt-5.5",
        toModel: "gpt-5.4",
        reason: "preferred_unavailable",
        routeKind: "scheduler_reroute",
        at: 1234,
      },
    ])
  })

  test("[no-transition] preference AVAILABLE ⇒ handler fires but emits NO route event", async () => {
    const routeEvents: AgentEvent[] = []
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: noopLoop,
      modelAvailability: availabilityOf(new Set(["gpt-5.5"])), // preference is UP
      onModelReroute: (ev) => routeEvents.push(ev),
    })
    if (slot === null) throw new Error("unreachable")
    await slot.handler(automationOf({ model: "gpt-5.5", modelFallbacks: ["gpt-5.4"] }))
    expect(routeEvents).toHaveLength(0) // used the preference ⇒ nothing changed
  })

  test("[gate-OFF parity + red-on-injection] NO onModelReroute sink ⇒ reroute still happens, ZERO observation", async () => {
    // Records the model actually dispatched so we PROVE the reroute happened
    // (behavior byte-identical) while emitting no observation.
    const calls: Array<string | undefined> = []
    const loop: AgentLoopPort = {
      enqueueUserMessage: async (_m, opts) => {
        calls.push(opts?.modelOverride)
      },
    }
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      modelAvailability: availabilityOf(new Set(["gpt-5.4"])),
      // onModelReroute deliberately ABSENT (the injection).
    })
    if (slot === null) throw new Error("unreachable")
    await slot.handler(automationOf({ model: "gpt-5.5", modelFallbacks: ["gpt-5.4"] }))
    // The reroute DID happen (fallback dispatched) — byte-identical behavior.
    expect(calls).toEqual(["gpt-5.4"])
  })

  test("[modelless parity] a fire with NO model emits NO route event and NO override", async () => {
    const routeEvents: AgentEvent[] = []
    const calls: Array<string | undefined> = []
    const loop: AgentLoopPort = {
      enqueueUserMessage: async (_m, opts) => {
        calls.push(opts?.modelOverride)
      },
    }
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      onModelReroute: (ev) => routeEvents.push(ev),
    })
    if (slot === null) throw new Error("unreachable")
    await slot.handler(automationOf({})) // no model
    expect(routeEvents).toHaveLength(0)
    expect(calls).toEqual([undefined]) // no override (host default)
  })
})
