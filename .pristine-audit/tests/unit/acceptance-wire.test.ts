/**
 * jun-28 SOTA++ Phase-A — the SINGLE toggle seam.
 *
 * `maybeAcceptanceSelector` is the one gated decision point the toggle architecture
 * (RFC §4.5) demands: knob OFF ⇒ `undefined` ⇒ the orchestrator keeps its legacy
 * selection (byte-identical); knob ON ⇒ a `selectCandidates` port built from the
 * injected sandbox oracle runners. `buildSandboxAcceptanceOracles` is the thin
 * bridge that turns patch→verdict runners into the candidate-shaped AcceptanceOracles.
 * All sandbox I/O is in the injected runners ⇒ hermetic.
 */

import { describe, expect, test } from "bun:test"
import {
  buildSandboxAcceptanceOracles,
  maybeAcceptanceSelector,
} from "../../src/runner/batch/eval/acceptance-wire"
import type { RepairCandidateOutcome } from "../../src/runner/batch/eval/repair/types"

const outcome = (patch: string): RepairCandidateOutcome => ({
  run: { patch, turns: 1 },
  validator: { ok: false },
  adopt: async () => {},
})

describe("maybeAcceptanceSelector — single toggle seam", () => {
  test("OFF: enabled=false ⇒ undefined (orchestrator keeps legacy selection)", () => {
    const sel = maybeAcceptanceSelector({
      enabled: false,
      runReproOnPatch: async () => true,
    })
    expect(sel).toBeUndefined()
  })

  test("ON: enabled=true ⇒ a selectCandidates port wired to the runners", async () => {
    const reproSeen: string[] = []
    const sel = maybeAcceptanceSelector({
      enabled: true,
      runReproOnPatch: async (patch) => {
        reproSeen.push(patch)
        return patch === "P2"
      },
    })
    expect(sel).toBeDefined()
    const winner = await (sel as NonNullable<typeof sel>)([
      outcome("P1"),
      outcome("P2"),
      outcome("P3"),
    ])
    expect(winner.run.patch).toBe("P2") // the repro-passing candidate
    expect(reproSeen).toEqual(["P1", "P2", "P3"]) // scored once each via the runner
  })

  test("ON with both runners ⇒ dual-guard (repro + regression failure count)", async () => {
    const sel = maybeAcceptanceSelector({
      enabled: true,
      runReproOnPatch: async () => true,
      runRegressionOnPatch: async (patch) => (patch === "A" ? 0 : 5),
    })
    const winner = await (sel as NonNullable<typeof sel>)([outcome("A"), outcome("B")])
    expect(winner.run.patch).toBe("A") // min regression failures wins
  })
})

describe("buildSandboxAcceptanceOracles — patch-runner → oracle bridge", () => {
  test("only the provided runners become oracle guards", () => {
    expect(buildSandboxAcceptanceOracles({}).runRepro).toBeUndefined()
    expect(buildSandboxAcceptanceOracles({}).runRegression).toBeUndefined()
    const o = buildSandboxAcceptanceOracles({ runReproOnPatch: async () => true })
    expect(o.runRepro).toBeDefined()
    expect(o.runRegression).toBeUndefined()
  })

  test("oracle forwards the candidate's patch to the runner", async () => {
    let seen = ""
    const o = buildSandboxAcceptanceOracles({
      runReproOnPatch: async (patch) => {
        seen = patch
        return true
      },
    })
    await o.runRepro?.({ patch: "THE_PATCH", patchKey: "k" })
    expect(seen).toBe("THE_PATCH")
  })
})
