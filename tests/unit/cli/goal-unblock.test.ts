/**
 * ★ HELLGATE (P0-B) — the operator can SEE why the goal is blocked, and get out.
 *
 * MEASURED DEFECT (2026-08-30, round-2 audit): `/goal resume` on a blocked goal
 * prints "Cannot resume: clear blocker first." and the `/goal` verb switch has
 * no verb that clears a blocker. The mutation exists and the policy table allows
 * it to the USER (`clearBlocker: row("allow", …)`); the only production caller
 * is the approval state machine clearing its OWN blocker id, which cannot touch
 * one promoted by the observation hysteresis. So the CLI instructed the operator
 * to perform an action it did not offer — the third dead end of this shape after
 * the manual criterion (P0-2) and the stuck attempt (P0-3).
 *
 * `/goal show` was also silent about the reasons: it rendered only the first
 * blocker's `waitingOn`. Clearing what you cannot see is not a front door, so
 * the renderer and the verb land together.
 *
 * Third rail: a persistent dependency promoted a NEW blocker every three
 * attempts, so the list the operator has to clear grew with the agent's
 * retries. One live blocker per (reason, waitingOn) is enough to say "stopped
 * here".
 */

import { describe, expect, test } from "bun:test"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl } from "@/apps/cli/slash/objective"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  type BlockerDependencyResolverPort,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAuthority,
} from "@/objective"

const blockerResolver: BlockerDependencyResolverPort = {
  resolve: ({ attemptId, target }) => ({
    kind: "resolved",
    dependencyId: `${target.kind}:${target.ref}`,
    occurrenceEvidenceId: `occ:${target.kind}:${target.ref}:${attemptId}`,
  }),
}

const harness = () => {
  let sequence = 0
  const authority = createObjectiveAuthority({
    idFactory: () => `goal-${++sequence}`,
    blockerDependencyResolver: blockerResolver,
  })
  const out: string[] = []
  const err: string[] = []
  const ctx: SlashContext = {
    cwd: "/tmp",
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    objectiveEditor: buildGoalControl(authority, "thread"),
    now: () => 10_000,
  }
  return { authority, ctx, out, err }
}

const run = async (ctx: SlashContext, ...args: string[]): Promise<number> =>
  await goalCmd.run(args, ctx)

/** Promote a blocker the way the agent does: one model observation in each of
 *  three HOST-reserved attempts. */
const promoteBlocker = (
  authority: ObjectiveAuthority,
  reason: string,
  ref: string,
  attemptIds: readonly string[],
): void => {
  const caps = createObjectiveCapabilities(authority)
  for (const attemptId of attemptIds) {
    const objective = authority.get("thread")
    if (objective === null) throw new Error("no objective")
    if (objective.attempts.started !== undefined) {
      caps.system.commit("thread", { kind: "abandonAttempt" })
    }
    caps.system.commit("thread", {
      kind: "beginAttempt",
      attempt: {
        objectiveId: objective.objectiveId,
        attemptId,
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: authority.readDomain("thread").revision,
      },
    })
    const prepared = authority.prepare({
      threadId: "thread",
      actor: "model",
      mutation: {
        kind: "addBlocker",
        reason,
        waitingOn: "user",
        target: { kind: "approval", ref },
      },
    })
    authority.commit(prepared, { admitted: true })
  }
  caps.system.commit("thread", { kind: "abandonAttempt" })
}

describe("GOAL P0-B — /goal show names the blockers", () => {
  test("every live blocker's reason reaches the operator", async () => {
    const { authority, ctx, out } = harness()
    await run(ctx, "ship the release")
    promoteBlocker(authority, "the deploy key is missing", "approval:deploy", ["a1", "a2", "a3"])
    promoteBlocker(authority, "staging is down", "external:staging", ["b1", "b2", "b3"])
    expect(authority.get("thread")?.blockers).toHaveLength(2)

    out.length = 0
    expect(await run(ctx, "show")).toBe(0)

    const text = out.join("")
    expect(text).toContain("the deploy key is missing")
    expect(text).toContain("staging is down")
  })
})

describe("GOAL P0-B — /goal unblock is the front door the resume message names", () => {
  test("unblock clears the live blockers and resume then works", async () => {
    const { authority, ctx, out, err } = harness()
    await run(ctx, "ship the release")
    promoteBlocker(authority, "the deploy key is missing", "approval:deploy", ["a1", "a2", "a3"])
    expect(authority.get("thread")?.status).toBe("blocked")
    expect(await run(ctx, "resume")).toBe(1)
    expect(err.join("")).toContain("clear blocker first")

    out.length = 0
    err.length = 0
    expect(await run(ctx, "unblock")).toBe(0)

    expect(authority.get("thread")?.blockers).toEqual([])
    expect(authority.get("thread")?.status).not.toBe("blocked")
    expect(out.join("")).toContain("1")
    expect(err.join("")).toBe("")
    expect(await run(ctx, "resume")).toBe(0)
  })

  test("unblock with nothing blocked says so and NEVER creates a goal named 'unblock'", async () => {
    const { authority, ctx, out, err } = harness()
    await run(ctx, "ship the release")

    out.length = 0
    expect(await run(ctx, "unblock")).toBe(0)

    expect(authority.get("thread")?.goal).toBe("ship the release")
    expect(authority.get("thread")?.blockers).toEqual([])
    expect(out.join("").toLowerCase()).toContain("no blocker")
    expect(err.join("")).toBe("")
  })
})

describe("GOAL P0-B — one live blocker per stopped dependency", () => {
  test("a dependency that keeps blocking does not stack duplicates the operator must clear", async () => {
    const { authority, ctx } = harness()
    await run(ctx, "ship the release")
    promoteBlocker(authority, "the deploy key is missing", "approval:deploy", [
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ])

    expect(authority.get("thread")?.blockers).toHaveLength(1)
    expect(authority.get("thread")?.status).toBe("blocked")
    // PAIRED CONTROL — a genuinely different dependency is still its own blocker.
    promoteBlocker(authority, "staging is down", "external:staging", ["b1", "b2", "b3"])
    expect(authority.get("thread")?.blockers).toHaveLength(2)
  })
})
