/**
 * RFC-03 H1 — `resolveGatedObjectiveAuthority` SSOT matrix HELLGATE.
 *
 * This is the ONE gate-reading builder both session-owning surfaces (the CLI
 * `/goal` core-state and the web-daemon observability wire) route through, and the
 * function `maybeWireObjective` delegates to. Pinning its full gate matrix keeps
 * the CLI, the web daemon, and the per-turn assembler from drifting apart.
 *
 *   - QUANTA_OBJECTIVE_TOOLS OFF ⇒ undefined (strict opt-in; no objective ⇒ no
 *     objective_* tools).
 *   - QUANTA_PROPOSE_GOAL ON ⇒ a model mutation requires approval; the
 *     confirmationAvailable input decides MEDIATED (has confirm) vs FAIL-CLOSED
 *     (no confirm) — never a bypass.
 *   - QUANTA_PROPOSE_GOAL OFF ⇒ legacy ungated (model mutations commit).
 */

import { describe, expect, test } from "bun:test"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"

const modelSet = () =>
  ({
    threadId: "t",
    actor: "model",
    mutation: { kind: "create", definition: { goal: "g" } },
  }) as const
const auth = (port: ObjectivePort) => asObjectiveAuthority(port)

describe("resolveGatedObjectiveAuthority — gate matrix (SSOT for CLI + web + assembler)", () => {
  test("OBJECTIVE_TOOLS off ⇒ undefined (opt-in) — even with PROPOSE_GOAL on", () => {
    expect(resolveGatedObjectiveAuthority({}, { confirmationAvailable: true })).toBeUndefined()
    expect(
      resolveGatedObjectiveAuthority({ QUANTA_PROPOSE_GOAL: "1" }, { confirmationAvailable: true }),
    ).toBeUndefined()
    expect(
      resolveGatedObjectiveAuthority(
        { QUANTA_OBJECTIVE_TOOLS: "0" },
        { confirmationAvailable: true },
      ),
    ).toBeUndefined()
  })

  test("TOOLS on + PROPOSE_GOAL off ⇒ authority present, model set UNGATED (legacy)", () => {
    const port = resolveGatedObjectiveAuthority(
      { QUANTA_OBJECTIVE_TOOLS: "1" },
      { confirmationAvailable: true },
    )
    expect(port).toBeDefined()
    expect(auth(port as ObjectivePort).prepare(modelSet()).approvalRequired).toBe(false)
  })

  test("TOOLS on + PROPOSE_GOAL on + confirmationAvailable ⇒ MEDIATED (approval-required, not fail-closed)", () => {
    const port = resolveGatedObjectiveAuthority(
      { QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" },
      { confirmationAvailable: true },
    ) as ObjectivePort
    const authority = auth(port)
    const prepared = authority.prepare(modelSet())
    expect(prepared.approvalRequired).toBe(true)
    // un-admitted ⇒ approval-required (curable by an admitted receipt), refused now
    const res = authority.commit(prepared, { admitted: false })
    expect(res.ok).toBe(false)
    // admitted ⇒ commits (the mediated path actually lets an approved set through)
    expect(authority.commit(authority.prepare(modelSet()), { admitted: true }).ok).toBe(true)
  })

  test("TOOLS on + PROPOSE_GOAL on + NO confirm ⇒ FAIL-CLOSED (an admitted receipt cannot cure approval-unavailable)", () => {
    const port = resolveGatedObjectiveAuthority(
      { QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" },
      { confirmationAvailable: false },
    ) as ObjectivePort
    const authority = auth(port)
    const prepared = authority.prepare(modelSet())
    expect(prepared.approvalRequired).toBe(true)
    // fail-closed: even a forged "admitted" receipt is refused (no confirm surface).
    expect(authority.commit(prepared, { admitted: true }).ok).toBe(false)
  })
})
