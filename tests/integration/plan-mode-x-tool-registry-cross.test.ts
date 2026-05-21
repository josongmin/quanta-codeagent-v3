/**
 * CROSS-feature integration: a faux mini agent loop that interleaves
 * developer-message mode directives and model tool_use events, then runs
 * every step through the dispatch-seam guard. Asserts that mode transitions
 * propagate correctly, mutating tools are blocked in plan mode, and
 * malformed directives throw without corrupting the active mode.
 *
 * Then 5 concurrent harnesses run in parallel; each carries its own state.
 * Cross-contamination would surface as a wrong outcome on any single step.
 *
 * Hard rules honored: pure-fn surfaces only, no sleeps, no try/catch
 * swallowing (catches are exact-typed re-asserts), tmpdir only.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { checkDispatchAllowed, type DispatchTurnState } from "@/agent/dispatch-seam-guard"
import {
  applyDeveloperModeTransition,
  type CollaborationMode,
  InvalidModeTransitionError,
  PlanModeMutatingBlockedError,
} from "@/agent/mode"
import { __resetRuntimeConfig } from "@/shared"

/* ────────────────────────────── env baseline ─────────────────────────────── */

const QUANTA_ENV_BASELINE: Record<string, string | undefined> = Object.fromEntries(
  Object.keys(process.env)
    .filter((k) => k.startsWith("QUANTA_"))
    .map((k) => [k, process.env[k]]),
)
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("QUANTA_") && !(k in QUANTA_ENV_BASELINE)) delete process.env[k]
  }
  for (const [k, v] of Object.entries(QUANTA_ENV_BASELINE)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
})

/* ─────────────────────────── faux mini agent loop ────────────────────────── */

type DevEvent = { kind: "developer"; text: string }
type ToolEvent = { kind: "tool"; name: string }
type LoopEvent = DevEvent | ToolEvent

type StepOutcome =
  | { kind: "transition"; mode: CollaborationMode }
  | { kind: "transition_invalid"; attempted: string; modeAfter: CollaborationMode }
  | { kind: "tool_allowed"; name: string; mode: CollaborationMode }
  | { kind: "tool_blocked"; name: string; mode: CollaborationMode; reason: "plan_mutating" }
  | { kind: "tool_unknown"; name: string; mode: CollaborationMode }

interface MiniLoopState {
  mode: CollaborationMode
  ledger: StepOutcome[]
}

/** Drive one event against the mini-loop state, recording an outcome and
 *  updating `state.mode` only when an explicit valid directive transitions
 *  the collaboration mode. Throws ONLY for the malformed-directive case so
 *  the harness can re-assert that mode state is preserved (we catch + log
 *  exactly that path; everything else is non-throwing per dispatch contract). */
const step = (state: MiniLoopState, ev: LoopEvent): StepOutcome => {
  if (ev.kind === "developer") {
    const before = state.mode
    try {
      const next = applyDeveloperModeTransition(before, ev.text)
      state.mode = next
      const out: StepOutcome = { kind: "transition", mode: next }
      state.ledger.push(out)
      return out
    } catch (err) {
      if (err instanceof InvalidModeTransitionError) {
        // Mode is NOT mutated on invalid directive (preserved at `before`).
        const out: StepOutcome = {
          kind: "transition_invalid",
          attempted: err.attempted,
          modeAfter: before,
        }
        state.ledger.push(out)
        return out
      }
      throw err
    }
  }
  // tool event — drive through dispatch guard
  const guard = checkDispatchAllowed({ collaborationMode: state.mode } as DispatchTurnState, {
    name: ev.name,
  })
  if (guard.ok) {
    const out: StepOutcome = { kind: "tool_allowed", name: ev.name, mode: state.mode }
    state.ledger.push(out)
    return out
  }
  if (guard.reason instanceof PlanModeMutatingBlockedError) {
    const out: StepOutcome = {
      kind: "tool_blocked",
      name: ev.name,
      mode: state.mode,
      reason: "plan_mutating",
    }
    state.ledger.push(out)
    return out
  }
  const out: StepOutcome = { kind: "tool_unknown", name: ev.name, mode: state.mode }
  state.ledger.push(out)
  return out
}

const newState = (): MiniLoopState => ({ mode: "default", ledger: [] })

/* ────────────────────── 20-step scripted sequence ────────────────────────── */

describe("cross-feature: 20-step mini agent loop", () => {
  test("scripted sequence produces the expected ledger", () => {
    const s = newState()
    const script: LoopEvent[] = [
      { kind: "tool", name: "read" }, // 1: default, allowed
      { kind: "tool", name: "write" }, // 2: default, allowed (mutating but default)
      { kind: "developer", text: "mode=plan" }, // 3: transition
      { kind: "tool", name: "write" }, // 4: plan + mutating → blocked
      { kind: "tool", name: "edit" }, // 5: plan + mutating → blocked
      { kind: "tool", name: "read" }, // 6: plan + read-only → allowed
      { kind: "tool", name: "grep" }, // 7: plan + read-only → allowed
      { kind: "tool", name: "bash" }, // 8: plan + bash → blocked
      { kind: "developer", text: "mode=default" }, // 9: transition
      { kind: "tool", name: "write" }, // 10: default + mutating → allowed
      { kind: "tool", name: "update_working_state" }, // 11: default + mutating → allowed
      { kind: "developer", text: "mode=plan" }, // 12: transition
      { kind: "tool", name: "update_working_state" }, // 13: plan + mutating → blocked
      { kind: "tool", name: "scripted_replace" }, // 14: plan + mutating → blocked
      { kind: "tool", name: "diagnostics" }, // 15: plan + read-only → allowed
      { kind: "developer", text: "mode=plan" }, // 16: no-op transition
      { kind: "tool", name: "lsp_definition" }, // 17: plan + read-only → allowed
      { kind: "developer", text: "mode=default" }, // 18: transition
      { kind: "tool", name: "git_status" }, // 19: default + read-only → allowed
      { kind: "tool", name: "bash" }, // 20: default + bash → allowed
    ]
    for (const ev of script) step(s, ev)

    const expected: StepOutcome[] = [
      { kind: "tool_allowed", name: "read", mode: "default" },
      { kind: "tool_allowed", name: "write", mode: "default" },
      { kind: "transition", mode: "plan" },
      { kind: "tool_blocked", name: "write", mode: "plan", reason: "plan_mutating" },
      { kind: "tool_blocked", name: "edit", mode: "plan", reason: "plan_mutating" },
      { kind: "tool_allowed", name: "read", mode: "plan" },
      { kind: "tool_allowed", name: "grep", mode: "plan" },
      { kind: "tool_blocked", name: "bash", mode: "plan", reason: "plan_mutating" },
      { kind: "transition", mode: "default" },
      { kind: "tool_allowed", name: "write", mode: "default" },
      { kind: "tool_allowed", name: "update_working_state", mode: "default" },
      { kind: "transition", mode: "plan" },
      { kind: "tool_blocked", name: "update_working_state", mode: "plan", reason: "plan_mutating" },
      { kind: "tool_blocked", name: "scripted_replace", mode: "plan", reason: "plan_mutating" },
      { kind: "tool_allowed", name: "diagnostics", mode: "plan" },
      { kind: "transition", mode: "plan" },
      { kind: "tool_allowed", name: "lsp_definition", mode: "plan" },
      { kind: "transition", mode: "default" },
      { kind: "tool_allowed", name: "git_status", mode: "default" },
      { kind: "tool_allowed", name: "bash", mode: "default" },
    ]
    expect(s.ledger).toEqual(expected)
    expect(s.mode).toBe("default")
  })
})

/* ────────────────────── malformed-directive preservation ────────────────── */

describe("cross-feature: malformed directive preserves prior mode state", () => {
  test("invalid directive recorded as transition_invalid, mode unchanged", () => {
    const s = newState()
    step(s, { kind: "developer", text: "mode=plan" })
    expect(s.mode).toBe("plan")
    step(s, { kind: "tool", name: "read" })
    // malformed directive mid-sequence
    const out = step(s, { kind: "developer", text: "mode=audit" })
    expect(out.kind).toBe("transition_invalid")
    if (out.kind === "transition_invalid") {
      expect(out.attempted).toBe("audit")
      expect(out.modeAfter).toBe("plan")
    }
    expect(s.mode).toBe("plan")
    // subsequent step still operates on prior valid mode (plan)
    const next = step(s, { kind: "tool", name: "write" })
    expect(next.kind).toBe("tool_blocked")
    if (next.kind === "tool_blocked") {
      expect(next.mode).toBe("plan")
      expect(next.reason).toBe("plan_mutating")
    }
    // another malformed
    step(s, { kind: "developer", text: "mode=foo" })
    expect(s.mode).toBe("plan")
    // valid transition back to default works
    step(s, { kind: "developer", text: "mode=default" })
    expect(s.mode).toBe("default")
    const w = step(s, { kind: "tool", name: "write" })
    expect(w.kind).toBe("tool_allowed")
  })
})

/* ────────────────────── 5 concurrent harnesses ─────────────────────────── */

describe("cross-feature: 5 concurrent harnesses, no cross-contamination", () => {
  test("each harness drives its own mode + ledger in parallel", async () => {
    // Each harness gets a DIFFERENT script. If turnState leaked between them,
    // a tool that's mutating in plan mode in one harness would be wrongly
    // blocked/allowed in another. The ledger of each harness is checked
    // independently against its scripted expectation.
    interface Harness {
      script: LoopEvent[]
      expectedFinalMode: CollaborationMode
      expectedLedger: StepOutcome[]
    }
    const harnesses: Harness[] = [
      {
        script: [
          { kind: "tool", name: "read" },
          { kind: "developer", text: "mode=plan" },
          { kind: "tool", name: "write" },
        ],
        expectedFinalMode: "plan",
        expectedLedger: [
          { kind: "tool_allowed", name: "read", mode: "default" },
          { kind: "transition", mode: "plan" },
          { kind: "tool_blocked", name: "write", mode: "plan", reason: "plan_mutating" },
        ],
      },
      {
        script: [
          { kind: "tool", name: "write" },
          { kind: "tool", name: "edit" },
        ],
        expectedFinalMode: "default",
        expectedLedger: [
          { kind: "tool_allowed", name: "write", mode: "default" },
          { kind: "tool_allowed", name: "edit", mode: "default" },
        ],
      },
      {
        script: [
          { kind: "developer", text: "mode=plan" },
          { kind: "tool", name: "read" },
          { kind: "tool", name: "bash" },
          { kind: "developer", text: "mode=default" },
          { kind: "tool", name: "bash" },
        ],
        expectedFinalMode: "default",
        expectedLedger: [
          { kind: "transition", mode: "plan" },
          { kind: "tool_allowed", name: "read", mode: "plan" },
          { kind: "tool_blocked", name: "bash", mode: "plan", reason: "plan_mutating" },
          { kind: "transition", mode: "default" },
          { kind: "tool_allowed", name: "bash", mode: "default" },
        ],
      },
      {
        script: [
          { kind: "developer", text: "mode=plan" },
          { kind: "tool", name: "update_working_state" },
          { kind: "tool", name: "scripted_replace" },
        ],
        expectedFinalMode: "plan",
        expectedLedger: [
          { kind: "transition", mode: "plan" },
          {
            kind: "tool_blocked",
            name: "update_working_state",
            mode: "plan",
            reason: "plan_mutating",
          },
          { kind: "tool_blocked", name: "scripted_replace", mode: "plan", reason: "plan_mutating" },
        ],
      },
      {
        script: [
          { kind: "developer", text: "mode=plan" },
          { kind: "tool", name: "lsp_hover" },
          { kind: "tool", name: "git_log" },
          { kind: "tool", name: "grep" },
        ],
        expectedFinalMode: "plan",
        expectedLedger: [
          { kind: "transition", mode: "plan" },
          { kind: "tool_allowed", name: "lsp_hover", mode: "plan" },
          { kind: "tool_allowed", name: "git_log", mode: "plan" },
          { kind: "tool_allowed", name: "grep", mode: "plan" },
        ],
      },
    ]

    const results = await Promise.all(
      harnesses.map(async (h) => {
        const s = newState()
        for (const ev of h.script) step(s, ev)
        return { s, h }
      }),
    )

    for (const { s, h } of results) {
      expect(s.mode).toBe(h.expectedFinalMode)
      expect(s.ledger).toEqual(h.expectedLedger)
    }
  })
})
