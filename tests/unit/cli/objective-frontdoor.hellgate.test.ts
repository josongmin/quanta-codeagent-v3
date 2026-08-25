/**
 * RFC-03 C3 — `/objective` CLI front-door hellgate (REAL CAS editor receipt).
 *
 * Drives the REAL production rail: the REAL objective AUTHORITY (the same
 * instance the `objective_*` tools + `/goal` share), the REAL
 * `buildObjectiveSlashState` wire, and the REAL `/objective` command.
 *
 * Pins:
 *  1. REGISTRATION GATE (OFF byte-identical) — `/objective` is registered ONLY
 *     under `QUANTA_PROPOSE_GOAL` (red-on-injection: drop the guard ⇒ the OFF
 *     command table gains `/objective`).
 *  2. edit → the goal + revision advance; a "revision request" (edit) is a NEW
 *     prepare cycle.
 *  3. SIMULTANEOUS CLI edit + model tool at ONE revision ⇒ exactly one commits,
 *     the other is `stale` (CAS), and the loser never clobbers the winner.
 *  4. REPLACE-GUARD: a bare `/objective <text>` over an active goal refuses.
 */

import { describe, expect, test } from "bun:test"
import { attentionCmd } from "@/apps/cli/slash/attention-cmd"
import { buildObjectiveSlashState, objectiveCmd } from "@/apps/cli/slash/objective"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import { createObjectiveAuthority } from "@/objective"

const withEnv = <T>(key: string, val: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

const names = (): string[] =>
  buildSurfaceSlashCommands((): readonly SlashCommand[] => []).map((c) => c.name)

const capture = () => {
  const out: string[] = []
  const err: string[] = []
  const ctx = (state: SlashContext["objectiveEditor"]): SlashContext =>
    ({
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      cwd: "/tmp",
      now: () => 1_000_000,
      objectiveEditor: state,
    }) as SlashContext
  return { out, err, ctx }
}

describe("RFC-03 C3 — /objective registration gate (OFF byte-identical)", () => {
  test("QUANTA_PROPOSE_GOAL unset ⇒ /objective is NOT registered", () => {
    withEnv("QUANTA_PROPOSE_GOAL", undefined, () => {
      expect(names()).not.toContain("/objective")
    })
  })
  test("QUANTA_PROPOSE_GOAL=1 ⇒ /objective IS registered (red-on-injection anchor)", () => {
    withEnv("QUANTA_PROPOSE_GOAL", "1", () => {
      expect(names()).toContain("/objective")
    })
  })
  // anchor `attentionCmd` import so an unrelated refactor cannot silently drop
  // the sibling gated-command precedent this mirrors.
  test("sibling gated command still exists", () => {
    expect(attentionCmd.name).toBe("/attention")
  })
})

describe("RFC-03 C3 — /objective CAS editor", () => {
  test("not wired ⇒ prints not-wired + exit 0", async () => {
    const { out, ctx } = capture()
    const code = await objectiveCmd.run([], ctx(undefined))
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })

  test("edit sets the goal and advances the revision (fresh prepare cycle)", async () => {
    const auth = createObjectiveAuthority({})
    const state = buildObjectiveSlashState(auth, "t")
    const { out, ctx } = capture()
    const code = await objectiveCmd.run(["edit", "ship", "the", "release"], ctx(state))
    expect(code).toBe(0)
    expect(auth.get("t")?.goal).toBe("ship the release")
    expect(auth.readDomain("t").revision).toBe(1)
    expect(out.join("")).toContain("rev 1")
  })

  test("pause/resume flip the explicit status through the authority", async () => {
    const auth = createObjectiveAuthority({})
    const state = buildObjectiveSlashState(auth, "t")
    const { ctx } = capture()
    await objectiveCmd.run(["edit", "goal"], ctx(state))
    await objectiveCmd.run(["pause"], ctx(state))
    expect(auth.get("t")?.status).toBe("paused")
    await objectiveCmd.run(["resume"], ctx(state))
    expect(auth.get("t")?.status).toBe("active")
  })

  test("SIMULTANEOUS CLI edit + model tool at one revision ⇒ exactly one commits, the other stale", async () => {
    const auth = createObjectiveAuthority({})
    // seed so both surfaces read the same revision N
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "seed" } },
      }),
      { admitted: true },
    )
    const revN = auth.readDomain("t").revision
    // the MODEL prepares at N (e.g. holds a prepared candidate across an approval)
    const modelPrepared = auth.prepare({
      threadId: "t",
      actor: "system",
      mutation: { kind: "replace", definition: { goal: "model-goal" } },
    })
    expect(modelPrepared.expectedRevision).toBe(revN)
    // meanwhile the CLI edit commits first (fresh prepare cycle at N ⇒ N+1)
    const state = buildObjectiveSlashState(auth, "t")
    const { ctx } = capture()
    const code = await objectiveCmd.run(["edit", "cli-goal"], ctx(state))
    expect(code).toBe(0)
    expect(auth.get("t")?.goal).toBe("cli-goal")
    // the model's post-approval commit at the OLD revision is stale — no clobber
    const modelCommit = auth.commit(modelPrepared, { admitted: true })
    expect(modelCommit.ok).toBe(false)
    if (!modelCommit.ok) expect(modelCommit.reason).toBe("stale")
    expect(auth.get("t")?.goal).toBe("cli-goal")
    expect(auth.readDomain("t").revision).toBe(revN + 1)
  })

  test("REPLACE-GUARD: a bare /objective <text> over an active goal refuses", async () => {
    const auth = createObjectiveAuthority({})
    const state = buildObjectiveSlashState(auth, "t")
    const { err, ctx } = capture()
    await objectiveCmd.run(["edit", "existing goal"], ctx(state))
    const code = await objectiveCmd.run(["brand", "new", "goal"], ctx(state))
    expect(code).toBe(1)
    expect(err.join("")).toContain("already set")
    // the active goal is NOT silently overwritten
    expect(auth.get("t")?.goal).toBe("existing goal")
  })

  test("a status verb with no objective yet reports no-objective (not a silent create)", async () => {
    const auth = createObjectiveAuthority({})
    const state = buildObjectiveSlashState(auth, "t")
    const { err, ctx } = capture()
    const code = await objectiveCmd.run(["pause"], ctx(state))
    expect(code).toBe(1)
    expect(err.join("")).toContain("no objective set")
  })
})
