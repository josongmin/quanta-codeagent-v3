/**
 * ★ HELLGATE — the surface's mode derivation and the LOOP's must agree (MR-09/D1).
 *
 * The sticky key contains the MODE, so two functions decide it:
 *
 *   - the LOOP reads `@/agent/mode#resolveLiveAgentMode` — live cell > `mode` >
 *     `planMode`;
 *   - the SURFACE writes through `@/apps/cli/repl/sticky-model-boot#liveAgentMode`
 *     — live cell > `planMode`.
 *
 * They are two hand-written statements of one rule, and NOTHING cross-checked
 * them. Each had its own test (`model-compose-wire.hellgate` pins the surface one
 * with hand-built cells; `agent-mode-live-parity-hellgate` pins the loop one), so
 * reversing the precedence in either — cell-then-planMode to planMode-then-cell —
 * left every suite green while `/model` under `--plan` wrote one key and the turn
 * read another: the write reports success and the pick never applies, which is the
 * exact defect class this campaign exists to remove.
 *
 * This is the missing cross-check: the same inputs through both resolvers must
 * yield the same mode, over the whole 2×2 of {plan flag} × {live cell}, plus the
 * identity fact that makes the comparison meaningful in production — the cell the
 * surface derives from IS the cell the loop reads.
 *
 * RED-on-injection: swap the two branches in either resolver ⇒ the table reds.
 */

import { describe, expect, test } from "bun:test"
import { type AgentMode, resolveLiveAgentMode } from "@/agent"
import { DEFAULT_POSTURE, postureByKey } from "@/apps/cli/mode-cycle"
import { liveAgentMode } from "@/apps/cli/repl/sticky-model-boot"

/** The shape both sides consume: the mode-cycle store's posture projection. The
 *  REAL postures, from the production SSOT — a hand-built `{agentMode}` literal
 *  would not notice a rung whose projection changed. */
const cellFor = (key: "default" | "plan" | undefined) =>
  key === undefined ? undefined : { current: () => postureByKey(key) }

describe("the surface and the loop derive the SAME agent mode", () => {
  const combos: ReadonlyArray<{
    readonly planMode: boolean
    readonly cell: "default" | "plan" | undefined
    readonly expected: AgentMode
  }> = [
    // No cell wired ⇒ the flag decides, on both sides.
    { planMode: false, cell: undefined, expected: "default" },
    { planMode: true, cell: undefined, expected: "plan" },
    // A live cell WINS over the flag — in both directions. The second row is the
    // one that matters: `--plan` at launch, then shift+tab back to DEFAULT, and
    // the next `/model` must key `default`, not `plan`.
    { planMode: false, cell: "plan", expected: "plan" },
    { planMode: true, cell: "default", expected: "default" },
    { planMode: false, cell: "default", expected: "default" },
    { planMode: true, cell: "plan", expected: "plan" },
  ]

  for (const c of combos) {
    test(`planMode=${c.planMode} cell=${c.cell ?? "none"} ⇒ ${c.expected} on BOTH sides`, () => {
      const cell = cellFor(c.cell)
      const surface = liveAgentMode({
        planMode: c.planMode,
        ...(cell !== undefined ? { agentModeCell: cell } : {}),
      })()
      const loop = resolveLiveAgentMode({
        planMode: c.planMode,
        ...(cell !== undefined ? { agentModeState: { get: () => cell.current().agentMode } } : {}),
      })
      expect(surface).toBe(c.expected)
      expect(loop).toBe(c.expected)
      expect(surface).toBe(loop)
    })
  }

  test("the acceptEdits and bypass rungs both project `default` (only `plan` differs)", () => {
    // Four permission rungs, three of which mean the same PROMPT mode. A future
    // rung that projected a new mode would change which sticky key `/model` writes,
    // so pin the projection here rather than assuming it.
    for (const key of ["default", "acceptEdits", "bypass"] as const) {
      expect(postureByKey(key).agentMode).toBe("default")
    }
    expect(postureByKey("plan").agentMode).toBe("plan")
    expect(DEFAULT_POSTURE.agentMode).toBe("default")
  })
})
