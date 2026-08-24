/**
 * C2b (codex/aug22-c2c-objective-prompt) HELLGATE — close the model-visibility
 * gap left by objective durable-resume.
 *
 * THE GAP: C2b wired objective save→restore, but the restored/active goal lives
 * ONLY in the authority (reachable via `objective_get`). Nothing in the model's
 * per-turn `<system-reminder>` context told it a goal is active, so a restore was
 * INERT to the model — it had to proactively call `objective_get` (unproven).
 *
 * THE FIX: a per-turn `## Current objective` reminder block, mirroring
 * `## Active skills`, rendered from a LIVE per-turn read of the SAME objective
 * authority the `objective_*` tools use (`config.objective.get(sessionId)`),
 * projected to `{ goal, status }` and threaded as the `objective` thunk on
 * `TurnContextInput`.
 *
 * Invariants pinned here:
 *   - RED→GREEN: an active goal now APPEARS in the per-turn reminder (before this
 *     wire it never did — no objective content-key existed).
 *   - LIVE per-turn read (not a construction-time snapshot): a pause/edit on the
 *     authority between two builds changes the RENDERED status.
 *   - RESTORED goal: an authority rebuilt from a restore snapshot renders its
 *     restored goal — the resume is no longer invisible-to-model.
 *   - GATE + ABSENCE gate: no `objective` thunk (no authority) OR no goal ⇒ NO
 *     block ⇒ the dynamic tail is BYTE-IDENTICAL to today.
 *   - CONCISE: goal + status only — never the criteria / blockers / nextActions
 *     the tool streams (no context-bloat dump).
 */
import { describe, expect, test } from "bun:test"
import { buildTurnContext, type ObjectiveContextView, type TurnContextInput } from "@/agent"
import type { Message } from "@/llm"
import { createObjectiveStore, type ObjectivePort } from "@/objective"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "do it" }] }]
const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})
const dynamicTail = (out: { messages: readonly Message[] }): string => {
  const m = out.messages[out.messages.length - 1]
  const block = m?.content[0]
  return block?.type === "text" ? block.text : ""
}

const THREAD = "sess-objective-1"
/** A LIVE thunk over the authority — exactly what the loop threads (a per-turn
 *  read of `config.objective.get(sessionId)`, projected to {goal,status}). */
const liveThunk =
  (port: ObjectivePort, threadId = THREAD) =>
  (): ObjectiveContextView | undefined => {
    const o = port.get(threadId)
    return o === null ? undefined : { goal: o.goal, status: o.status }
  }

const GOAL = "Structurally close the C2b model-visibility gap for objectives"

describe("C2b — active objective is visible in the per-turn reminder", () => {
  test("an active goal APPEARS (goal + status) in the dynamic reminder", () => {
    const port = createObjectiveStore()
    port.set(THREAD, { goal: GOAL })
    const tail = dynamicTail(buildTurnContext(base({ objective: liveThunk(port) })))
    expect(tail).toContain("## Current objective")
    expect(tail).toContain(GOAL)
    expect(tail).toContain("status: active")
  })

  test("RED-guard: WITHOUT the objective thunk the SAME goal is INVISIBLE (the pre-fix state)", () => {
    // The gap this whole feature closes: the goal lives only in the authority.
    const port = createObjectiveStore()
    port.set(THREAD, { goal: GOAL })
    const tail = dynamicTail(buildTurnContext(base())) // no objective thunk wired
    expect(tail).not.toContain("## Current objective")
    expect(tail).not.toContain(GOAL)
  })

  test("LIVE per-turn read: a pause on the authority between builds changes the rendered status", () => {
    const port = createObjectiveStore()
    port.set(THREAD, { goal: GOAL })
    const input = base({ objective: liveThunk(port) })
    const before = dynamicTail(buildTurnContext(input))
    expect(before).toContain("status: active")
    // Same input object — only the AUTHORITY changed. A construction-time snapshot
    // would be frozen at "active"; a live per-turn read tracks the edit.
    port.updateStatus(THREAD, "paused")
    const after = dynamicTail(buildTurnContext(input))
    expect(after).toContain("status: paused")
    expect(after).not.toBe(before)
  })

  test("LIVE per-turn read: an edited goal is reflected on the next build", () => {
    const port = createObjectiveStore()
    port.set(THREAD, { goal: GOAL })
    const input = base({ objective: liveThunk(port) })
    expect(dynamicTail(buildTurnContext(input))).toContain(GOAL)
    port.set(THREAD, { goal: "A totally different objective now" })
    const after = dynamicTail(buildTurnContext(input))
    expect(after).toContain("A totally different objective now")
    expect(after).not.toContain(GOAL)
  })

  test("RESTORED goal: a fresh authority carrying the goal renders it (resume no longer invisible)", () => {
    // Mirrors durable-resume: a NEW authority instance already holds the goal.
    const restored = createObjectiveStore()
    restored.set(THREAD, { goal: "Restored objective after --resume" })
    const tail = dynamicTail(buildTurnContext(base({ objective: liveThunk(restored) })))
    expect(tail).toContain("## Current objective")
    expect(tail).toContain("Restored objective after --resume")
  })

  test("CONCISE: only goal + status — NOT criteria / blockers / nextActions", () => {
    const port = createObjectiveStore()
    port.set(THREAD, {
      goal: GOAL,
      successCriteria: ["CRITERION_WITNESS_SHOULD_NOT_APPEAR"],
    })
    port.setNextActions(THREAD, ["NEXTACTION_WITNESS_SHOULD_NOT_APPEAR"])
    port.addBlocker(THREAD, { reason: "BLOCKER_WITNESS_SHOULD_NOT_APPEAR", waitingOn: "user" })
    const tail = dynamicTail(buildTurnContext(base({ objective: liveThunk(port) })))
    expect(tail).toContain("## Current objective")
    expect(tail).toContain(GOAL)
    expect(tail).not.toContain("CRITERION_WITNESS_SHOULD_NOT_APPEAR")
    expect(tail).not.toContain("NEXTACTION_WITNESS_SHOULD_NOT_APPEAR")
    expect(tail).not.toContain("BLOCKER_WITNESS_SHOULD_NOT_APPEAR")
  })
})

describe("C2b — gated + absence-gated ⇒ byte-identical dynamic tail", () => {
  test("no objective thunk (authority absent) ⇒ tail byte-identical to today", () => {
    const withNothing = dynamicTail(buildTurnContext(base()))
    const port = createObjectiveStore()
    port.set(THREAD, { goal: GOAL })
    const withGoal = dynamicTail(buildTurnContext(base({ objective: liveThunk(port) })))
    // Sanity: the block genuinely CHANGED the prompt when wired.
    expect(withGoal).not.toBe(withNothing)
    // Absence gate: the thunk-less tail carries no objective block.
    expect(withNothing).not.toContain("## Current objective")
  })

  test("authority present but NO goal ⇒ NO block ⇒ byte-identical to the thunk-less tail", () => {
    const emptyPort = createObjectiveStore() // no goal set for THREAD
    const withEmptyThunk = dynamicTail(buildTurnContext(base({ objective: liveThunk(emptyPort) })))
    const withNoThunk = dynamicTail(buildTurnContext(base()))
    expect(withEmptyThunk).toBe(withNoThunk) // byte-identical
    expect(withEmptyThunk).not.toContain("## Current objective")
  })

  test("thunk returns undefined ⇒ NO block (absence gate at the render seam)", () => {
    const tail = dynamicTail(buildTurnContext(base({ objective: () => undefined })))
    expect(tail).not.toContain("## Current objective")
  })
})
