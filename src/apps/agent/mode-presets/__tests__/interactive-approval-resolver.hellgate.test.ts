/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-1-04): the `apps/agent`
 *   interactive preset must be able to ANSWER approvals.
 *
 * Pinned bug: the interactive prompt loop ran bare `session.turn.run` with no
 * approval resolution — a tool that requested approval parked the session at
 * `awaiting_approval` forever, on the one surface whose whole point is having
 * an operator present.
 *
 * Contract under test:
 *   1. `buildInteractiveApprovalResolver` speaks the standard 3-verb CLI
 *      dialect ([y]es / [a]lways session / [N]o, fail-closed default deny).
 *   2. WIRING: `interactive.ts` drives turns through `driveSessionTurn` (the
 *      SSOT approval-draining driver), not a bare `session.turn.run` (source
 *      scan — the loop is a composition root; the driver's own suite covers
 *      the drain behavior).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildInteractiveApprovalResolver } from "../interactive"

const resolverWith = (answer: string) =>
  buildInteractiveApprovalResolver(
    { question: async () => answer },
    new AbortController().signal,
  )

const approval = { approvalId: "a1", reason: "shell wants git push" } as Parameters<
  ReturnType<typeof buildInteractiveApprovalResolver>
>[0]

describe("HELLGATE WS-A — interactive approval resolver (3-verb dialect)", () => {
  test("'y' ⇒ approve", async () => {
    expect(await resolverWith("y")(approval)).toBe("approve")
  })

  test("'yes' (with whitespace/case noise) ⇒ approve", async () => {
    expect(await resolverWith("  YES ")(approval)).toBe("approve")
  })

  test("'a' ⇒ rich session-scoped approve (the standing grant verb)", async () => {
    expect(await resolverWith("a")(approval)).toEqual({ decision: "approve", scope: "session" })
  })

  test("'n' ⇒ deny", async () => {
    expect(await resolverWith("n")(approval)).toBe("deny")
  })

  test("EMPTY answer ⇒ deny (fail-closed default)", async () => {
    expect(await resolverWith("")(approval)).toBe("deny")
  })

  test("garbage answer ⇒ deny (never a silent allow)", async () => {
    expect(await resolverWith("sure whatever")(approval)).toBe("deny")
  })
})

describe("HELLGATE WS-A — wiring: the prompt loop uses the SSOT driver", () => {
  test("interactive.ts calls driveSessionTurn and has NO bare in-loop turn.run", () => {
    const src = readFileSync(join(import.meta.dir, "..", "interactive.ts"), "utf8")
    expect(src).toContain("driveSessionTurn({")
    expect(src).toContain("resolveApproval")
    // The bug shape: appending input then running the turn WITHOUT the driver.
    expect(/await session\.input\.append[\s\S]{0,120}await session\.turn\.run/.test(src)).toBe(
      false,
    )
  })
})
