/**
 * ★ HELLGATE — `/objective` is a DEPRECATED ALIAS of `/goal` (GOAL-05A).
 *
 *   - registration stays behind `QUANTA_PROPOSE_GOAL` (default-OFF byte-identical);
 *   - every `/objective` verb emits the SAME authority command as its `/goal`
 *     counterpart (rail 11: deep-equal mutations, one commit each) through the
 *     ONE control instance on `ctx.goal`;
 *   - the CAS race pinned by RFC-03 C3 still holds: a CLI edit that commits
 *     first leaves a model candidate prepared at the old revision `stale`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { buildGoalControl } from "@/apps/cli/goal/goal-control"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { objectiveCmd, translateObjectiveArgs } from "@/apps/cli/slash/objective"
import { SESSION_SLASH_COMMANDS } from "@/apps/cli/slash/registry-session"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import {
  asObjectiveAuthority,
  createObjectiveAuthority,
  type ObjectiveAuthority,
  type ObjectiveMutation,
} from "@/objective"

const ORIGINAL = process.env.QUANTA_PROPOSE_GOAL
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.QUANTA_PROPOSE_GOAL
  else process.env.QUANTA_PROPOSE_GOAL = ORIGINAL
})

const names = (): string[] =>
  buildSurfaceSlashCommands((): readonly SlashCommand[] => []).map((c) => c.name)
const sessionNames = (): string[] => SESSION_SLASH_COMMANDS.map((c) => c.name)

/** An authority whose commits are recorded (duck-typed spread wrapper). */
const spiedAuthority = () => {
  const raw = asObjectiveAuthority(createObjectiveAuthority({ now: () => 1 }))
  const mutations: ObjectiveMutation[] = []
  const spied: ObjectiveAuthority = {
    ...raw,
    commit: (prepared, approval) => {
      mutations.push(prepared.command.mutation)
      return raw.commit(prepared, approval)
    },
  }
  return { raw, spied, mutations }
}

const ctxFor = (port: ObjectiveAuthority, out: string[] = []): SlashContext => ({
  out: (s) => out.push(s),
  err: (s) => out.push(s),
  cwd: "/tmp",
  goal: { control: buildGoalControl({ port, threadId: "t" }) },
})

describe("RFC-03 C3 — /objective registration gate (OFF byte-identical)", () => {
  test("QUANTA_PROPOSE_GOAL unset ⇒ /objective is NOT registered", () => {
    delete process.env.QUANTA_PROPOSE_GOAL
    expect(names()).not.toContain("/objective")
  })
  test("QUANTA_PROPOSE_GOAL=1 ⇒ /objective IS registered (red-on-injection anchor)", () => {
    process.env.QUANTA_PROPOSE_GOAL = "1"
    expect(names()).toContain("/objective")
  })
  test("/goal lives in the session registry regardless (the alias never owns discovery)", () => {
    delete process.env.QUANTA_PROPOSE_GOAL
    expect(sessionNames()).toContain("/goal")
    expect(names()).not.toContain("/goal")
  })
})

describe("GOAL-05A — /objective is a deprecated alias of /goal", () => {
  test("argv translation onto the /goal grammar", () => {
    expect(translateObjectiveArgs([])).toEqual([])
    expect(translateObjectiveArgs(["show"])).toEqual([])
    expect(translateObjectiveArgs(["edit", "a", "b"])).toEqual(["edit", "a", "b"])
    expect(translateObjectiveArgs(["pause"])).toEqual(["pause"])
    expect(translateObjectiveArgs(["resume"])).toEqual(["resume"])
    expect(translateObjectiveArgs(["clear"])).toEqual(["clear"])
    expect(translateObjectiveArgs(["some", "goal"])).toEqual(["some", "goal"])
  })

  test("not wired ⇒ prints not-wired + exit 0", async () => {
    const out: string[] = []
    const code = await objectiveCmd.run(["edit", "x"], {
      out: (s) => out.push(s),
      err: (s) => out.push(s),
      cwd: "/tmp",
    })
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })

  test("rail 11 — /objective and /goal emit DEEP-EQUAL authority commands, one commit each", async () => {
    const scripts: { objective: string[]; goal: string[] }[] = [
      { objective: ["edit", "cli-goal"], goal: ["edit", "cli-goal"] },
      { objective: ["pause"], goal: ["pause"] },
      { objective: ["resume"], goal: ["resume"] },
      { objective: ["clear"], goal: ["clear"] },
    ]
    for (const script of scripts) {
      const a = spiedAuthority()
      const b = spiedAuthority()
      a.raw.create("t", { goal: "seed" })
      b.raw.create("t", { goal: "seed" })
      const codeA = await objectiveCmd.run(script.objective, ctxFor(a.spied))
      const codeB = await goalCmd.run(script.goal, ctxFor(b.spied))
      expect(codeA).toBe(codeB)
      expect(a.mutations).toHaveLength(1)
      expect(a.mutations).toEqual(b.mutations)
      expect(a.raw.readDomain("t").revision).toBe(b.raw.readDomain("t").revision)
    }
  })

  test("the alias prints a deprecation notice and the same fresh report", async () => {
    const { raw, spied } = spiedAuthority()
    raw.create("t", { goal: "seed" })
    const out: string[] = []
    const code = await objectiveCmd.run([], ctxFor(spied, out))
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("deprecated")
    expect(text).toContain("Pursuing goal: seed")
    expect(text).toContain("rev ")
  })

  test("SIMULTANEOUS CLI edit + model tool at one revision ⇒ exactly one commits, the other stale", async () => {
    const auth = createObjectiveAuthority({})
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "seed" } },
      }),
      { admitted: true },
    )
    const revN = auth.readDomain("t").revision
    const modelPrepared = auth.prepare({
      threadId: "t",
      actor: "system",
      mutation: { kind: "replace", definition: { goal: "model-goal" } },
    })
    expect(modelPrepared.expectedRevision).toBe(revN)
    const code = await objectiveCmd.run(["edit", "cli-goal"], ctxFor(auth))
    expect(code).toBe(0)
    expect(auth.get("t")?.goal).toBe("cli-goal")
    const modelCommit = auth.commit(modelPrepared, { admitted: true })
    expect(modelCommit.ok).toBe(false)
    if (!modelCommit.ok) expect(modelCommit.reason).toBe("stale")
    expect(auth.get("t")?.goal).toBe("cli-goal")
    expect(auth.readDomain("t").revision).toBe(revN + 1)
  })

  test("a bare /objective <text> over an active goal is the authority's objective-exists refusal (no clobber)", async () => {
    const { raw, spied } = spiedAuthority()
    raw.create("t", { goal: "seed" })
    const out: string[] = []
    const code = await objectiveCmd.run(["brand", "new"], ctxFor(spied, out))
    expect(code).toBe(1)
    expect(out.join("")).toContain("/goal edit")
    expect(raw.get("t")?.goal).toBe("seed")
  })

  test("a status verb with no objective yet reports no goal (not a silent create)", async () => {
    const { raw, spied } = spiedAuthority()
    const out: string[] = []
    const code = await objectiveCmd.run(["pause"], ctxFor(spied, out))
    expect(code).toBe(0)
    expect(out.join("")).toContain("No goal set")
    expect(raw.get("t")).toBeNull()
  })
})
