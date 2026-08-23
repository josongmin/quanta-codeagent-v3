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
 * FIX: the wire resolves the authority through the ONE gated surface builder
 * (`resolveGatedObjectiveAuthority`): present only under `QUANTA_OBJECTIVE_TOOLS`,
 * GATED under `QUANTA_PROPOSE_GOAL`. The web daemon wires no per-tool `onConfirm`
 * (its approval path is the ASM / inline-approval channel, not the objective HITL
 * adapter), so `confirmationAvailable` is false ⇒ a gated model mutation is
 * FAIL-CLOSED (`approval-unavailable` ⇒ refused), never an ungated commit.
 *
 * RED-on-injection: restoring the ungated `buildObjectiveAuthority()` mint flips
 * [WEB-H1-1] (approvalRequired ⇒ false, commit ⇒ ok) and [WEB-H1-2]
 * (handle.objective defined under OBSERVABILITY alone).
 */

import { describe, expect, test } from "bun:test"
import { wireSessionObservability } from "@/../src/apps/web-daemon/runtime-factory"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"

const CWD = "/tmp/web-h1"
const modelSet = (goal: string) =>
  ({ threadId: "t-web", actor: "model", mutation: { kind: "set", goal } }) as const

describe("RFC-03 H1 — web-daemon objective authority is GATED (HITL bypass closed)", () => {
  test("[WEB-H1-1] OBSERVABILITY+OBJECTIVE_TOOLS+PROPOSE_GOAL ⇒ a model objective set is REFUSED (fail-closed; no ungated commit)", () => {
    const { handle } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on", QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" },
      CWD,
    )
    expect(handle.objective).toBeDefined()
    const authority = asObjectiveAuthority(handle.objective as ObjectivePort)
    const prepared = authority.prepare(modelSet("autonomous pwn goal"))
    // GATED: the model mutation REQUIRES approval (was false ⇒ bypass).
    expect(prepared.approvalRequired).toBe(true)
    // Fail-closed: no confirm surface ⇒ the un-admitted commit is REFUSED
    // (`approval-unavailable`), never an ungated commit (was ok).
    expect(authority.commit(prepared, { admitted: false }).ok).toBe(false)
  })

  test("[WEB-H1-2] OBSERVABILITY on, OBJECTIVE_TOOLS off ⇒ NO objective authority leaks (no objective_* under observability alone)", () => {
    const { handle } = wireSessionObservability({ QUANTA_OBSERVABILITY: "on" }, CWD)
    expect(handle.objective).toBeUndefined()
  })

  test("[WEB-H1-3] OBSERVABILITY+OBJECTIVE_TOOLS on, PROPOSE_GOAL off ⇒ authority present, model set UNGATED (legacy posture preserved when only the tools gate is on)", () => {
    const { handle } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on", QUANTA_OBJECTIVE_TOOLS: "1" },
      CWD,
    )
    expect(handle.objective).toBeDefined()
    const prepared = asObjectiveAuthority(handle.objective as ObjectivePort).prepare(modelSet("x"))
    expect(prepared.approvalRequired).toBe(false)
  })

  test("[WEB-H1-4] OBSERVABILITY off ⇒ noop handle, no objective (byte-identical default-OFF)", () => {
    const { handle, bus } = wireSessionObservability({ QUANTA_OBJECTIVE_TOOLS: "1" }, CWD)
    expect(handle.objective).toBeUndefined()
    expect(bus).toBeUndefined()
  })
})
