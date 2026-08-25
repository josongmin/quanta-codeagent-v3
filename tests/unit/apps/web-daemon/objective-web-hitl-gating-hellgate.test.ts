/**
 * RFC-03 H1 (HITL bypass — web-daemon half) HELLGATE.
 *
 * BASE DEFECT: the web-daemon's per-session `wireSessionObservability` minted an
 * UNGATED objective authority (`buildObjectiveAuthority()`) onto the observability
 * handle whenever `QUANTA_OBSERVABILITY=on`. That instance flowed onto
 * `base.objective` (via `observabilitySlots`) and won `maybeWireObjective`'s
 * caller-override, so a model-originated `objective_set` committed with NO approval
 * even under `QUANTA_PROPOSE_GOAL`, AND `objective_*` tools leaked under
 * `QUANTA_OBSERVABILITY` alone (even with `QUANTA_OBJECTIVE_TOOLS` off).
 *
 * FIX (H1): the surface resolves the authority through the ONE gated builder
 * `resolveGatedObjectiveAuthority`: present only under `QUANTA_OBJECTIVE_TOOLS`,
 * GATED under `QUANTA_PROPOSE_GOAL`. The web daemon wires no per-tool `onConfirm`
 * (its approval path is the ASM / inline-approval channel, not the objective HITL
 * adapter), so `confirmationAvailable` is false ⇒ a gated model mutation is
 * FAIL-CLOSED (`approval-unavailable` ⇒ refused), never an ungated commit.
 *
 * FIX (web-parity follow-on): that mint moved OUT of `wireSessionObservability`
 * up to the factory (`buildProductionRuntimeFactory`), INDEPENDENT of the
 * observability gate, and is INJECTED into the wire (the SAME instance also lands
 * on `base.objective`). So this hellgate now exercises the pair as the factory
 * composes it: `resolveGatedObjectiveAuthority(env, {confirmationAvailable:false})`
 * → injected into `wireSessionObservability` → surfaced on `handle.objective` for
 * obs approval-attribution. The GATING invariants are unchanged; the wire is now a
 * faithful pass-through (no second authority, no split-brain).
 *
 * RED-on-injection: restoring an UNGATED `buildObjectiveAuthority()` at the mint
 * point flips [WEB-H1-1] (approvalRequired ⇒ false, commit ⇒ ok) and [WEB-H1-2]
 * (an authority present under OBSERVABILITY / OBJECTIVE_TOOLS-off).
 */

import { describe, expect, test } from "bun:test"
import { wireSessionObservability } from "@/../src/apps/web-daemon/runtime-factory"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"

const CWD = "/tmp/web-h1"
const modelSet = (goal: string) =>
  ({
    threadId: "t-web",
    actor: "model",
    mutation: { kind: "create", definition: { goal } },
  }) as const

/** Mint the session-stable objective EXACTLY as the factory does (web has no
 *  `onConfirm` ⇒ `confirmationAvailable:false`), then inject it into the obs wire
 *  the way `buildProductionRuntimeFactory` threads the single instance. */
const wireWithFactoryObjective = (env: Record<string, string | undefined>) => {
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  return { objective, ...wireSessionObservability(env, CWD, objective) }
}

describe("RFC-03 H1 — web-daemon objective authority is GATED (HITL bypass closed)", () => {
  test("[WEB-H1-1] OBSERVABILITY+OBJECTIVE_TOOLS+PROPOSE_GOAL ⇒ a model objective set is REFUSED (fail-closed; no ungated commit)", () => {
    const { objective, handle } = wireWithFactoryObjective({
      QUANTA_OBSERVABILITY: "on",
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_PROPOSE_GOAL: "1",
    })
    // The obs wire surfaces the SAME injected authority (single instance).
    expect(handle.objective).toBeDefined()
    expect(handle.objective).toBe(objective)
    const authority = asObjectiveAuthority(handle.objective as ObjectivePort)
    const prepared = authority.prepare(modelSet("autonomous pwn goal"))
    // GATED: the model mutation REQUIRES approval (was false ⇒ bypass).
    expect(prepared.approvalRequired).toBe(true)
    // Fail-closed: no confirm surface ⇒ the un-admitted commit is REFUSED
    // (`approval-unavailable`), never an ungated commit (was ok).
    expect(authority.commit(prepared, { admitted: false }).ok).toBe(false)
  })

  test("[WEB-H1-2] OBSERVABILITY on, OBJECTIVE_TOOLS off ⇒ NO objective authority leaks (no objective_* under observability alone)", () => {
    const { objective, handle } = wireWithFactoryObjective({ QUANTA_OBSERVABILITY: "on" })
    // The gated builder returns undefined when the TOOLS gate is off ⇒ nothing to
    // inject ⇒ the obs wire has no objective to attribute against.
    expect(objective).toBeUndefined()
    expect(handle.objective).toBeUndefined()
  })

  test("[WEB-H1-3] OBSERVABILITY+OBJECTIVE_TOOLS on, PROPOSE_GOAL off ⇒ authority present, model set UNGATED (legacy posture preserved when only the tools gate is on)", () => {
    const { handle } = wireWithFactoryObjective({
      QUANTA_OBSERVABILITY: "on",
      QUANTA_OBJECTIVE_TOOLS: "1",
    })
    expect(handle.objective).toBeDefined()
    const prepared = asObjectiveAuthority(handle.objective as ObjectivePort).prepare(modelSet("x"))
    expect(prepared.approvalRequired).toBe(false)
  })

  test("[WEB-H1-4] OBSERVABILITY off ⇒ noop handle, no objective on the wire (byte-identical default-OFF)", () => {
    // Even though OBJECTIVE_TOOLS is on (so the factory mints an authority for the
    // BASE), the obs wire itself is the noop handle when OBSERVABILITY is off — it
    // carries no objective (the base is where the authority lands; see the
    // web-daemon-objective-session-stability hellgate).
    const { handle, bus } = wireWithFactoryObjective({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(handle.objective).toBeUndefined()
    expect(bus).toBeUndefined()
  })
})
