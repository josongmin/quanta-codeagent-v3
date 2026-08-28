/**
 * RFC-03 H1 (HITL bypass — CLI half) HELLGATE.
 *
 * BASE DEFECT: the interactive CLI's `core-state` minted an UNGATED objective
 * authority (`buildObjectiveAuthority()` with NO args ⇒ `gateOn` undefined) and
 * threaded it DOWN via the compose seam onto `config.objective`. Because a pre-set
 * `config.objective` wins `maybeWireObjective`'s caller-override, the gated
 * assembler wiring never applied: on the interactive CLI — the one surface with a
 * live `onConfirm` — `QUANTA_PROPOSE_GOAL` never gated a model-originated
 * objective mutation, and `objective_*` tools were ALWAYS present regardless of
 * `QUANTA_OBJECTIVE_TOOLS` (the `objective_set` SSOT `cli: "opt-in"` default was
 * silently violated).
 *
 * FIX: `core-state` resolves the objective authority through the ONE gated surface
 * builder (`resolveGatedObjectiveAuthority`): present only under
 * `QUANTA_OBJECTIVE_TOOLS`, GATED under `QUANTA_PROPOSE_GOAL`, with
 * `confirmationAvailable` derived from the interactive REPL's always-present
 * `onConfirm`. The SAME instance still threads down to the LLM tools (single
 * authority).
 *
 * These tests drive the REAL composition root (`composeSurfaceWires`) so they pin
 * the actual surface wiring, not a re-implementation. RED-on-injection: restoring
 * the ungated `buildObjectiveAuthority()` mint in `core-state` flips [CLI-H1-1]
 * (approvalRequired ⇒ false, commit ⇒ ok) and [CLI-H1-2] (objectiveStore defined).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"
import {
  cleanupHermeticQuantaHomes,
  hermeticQuantaHomeEnv,
} from "../../../_support/hermetic-quanta-home"
import { makeFakeSessionSetup } from "./_cli-fakes"

afterEach(cleanupHermeticQuantaHomes)

/** Scratch Quanta home per case — `env = {}` would resolve to the developer's
 *  real `~/.quanta` (see the helper's header). */
const compose = (env: NodeJS.ProcessEnv = {}) => {
  const setup = makeFakeSessionSetup()
  const convStore = defaultConversationCheckpointStore()
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  return composeSurfaceWires(setup, state, hermeticQuantaHomeEnv(env), { convStore })
}

const authorityOf = (port: ObjectivePort) => asObjectiveAuthority(port)
const modelSet = (goal: string) =>
  ({
    threadId: "t-cli",
    actor: "model",
    mutation: { kind: "create", definition: { goal } },
  }) as const

describe("RFC-03 H1 — interactive CLI objective authority is GATED (HITL bypass closed)", () => {
  test("[CLI-H1-1] OBJECTIVE_TOOLS+PROPOSE_GOAL ⇒ a model objective set is APPROVAL-GATED (no silent commit)", () => {
    const wires = compose({ QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" })
    expect(wires.objectiveStore).toBeDefined()
    const authority = authorityOf(wires.objectiveStore as ObjectivePort)
    const prepared = authority.prepare(modelSet("autonomous pwn goal"))
    // GATED: the model mutation REQUIRES an admitted approval (was false ⇒ bypass).
    expect(prepared.approvalRequired).toBe(true)
    // And an un-admitted commit is REFUSED (was ok ⇒ ungated commit).
    expect(authority.commit(prepared, { admitted: false }).ok).toBe(false)
  })

  test("[CLI-H1-2] OBJECTIVE_TOOLS off (default) ⇒ NO objective authority ⇒ no objective_* tools (opt-in default)", () => {
    const wires = compose({})
    expect(wires.objectiveStore).toBeUndefined()
    // Nothing threaded down to the LLM tools either (compose key omitted).
    expect(wires.runtimeFacadeCompose.objective).toBeUndefined()
  })

  test("[CLI-H1-3] OBJECTIVE_TOOLS on + PROPOSE_GOAL off ⇒ authority present, model set UNGATED (legacy posture preserved when only the tools gate is on)", () => {
    const wires = compose({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(wires.objectiveStore).toBeDefined()
    const prepared = authorityOf(wires.objectiveStore as ObjectivePort).prepare(modelSet("x"))
    expect(prepared.approvalRequired).toBe(false)
  })

  test("[CLI-H1-4] single authority — the surface store IS the exact instance threaded to the LLM tools", () => {
    const wires = compose({ QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" })
    // identity (NOT deep-equal): the /goal slash + ticker + chip and the tools
    // mutate ONE object, so a model completing the goal stops the pursuit.
    expect(wires.runtimeFacadeCompose.objective).toBe(wires.objectiveStore)
  })
})
