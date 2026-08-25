/**
 * ★ HELLGATE — GOAL-05A `buildGoalControl`: the ONE CLI adapter over the
 * authority / read / verifier ports. Every command is exactly one authority
 * commit (rail 8); the control never decides transitions itself — every
 * verdict is the authority's typed rejection re-rendered (rail 7); the result
 * always carries a FRESH re-read report (never a predicted status).
 */

import { describe, expect, test } from "bun:test"
import { buildGoalControl, type GoalControl } from "@/apps/cli/goal/goal-control"
import type { CliPromptInput } from "@/apps/cli/repl/prompt-types"
import {
  asObjectiveAuthority,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  MAX_GOAL_CHARS,
  type ObjectiveAuthority,
  type ObjectiveVerificationPort,
  PRODUCT_BUDGET_CEILING,
} from "@/objective"
import { settleTurns } from "../objective/v2-helpers"

const NOW = 5_000_000

const make = (
  over: {
    verifier?: ObjectiveVerificationPort
    enqueue?: (i: CliPromptInput) => void
    enforce?: boolean
  } = {},
) => {
  const authority = createObjectiveAuthority({
    now: () => NOW,
    enforceBudget: over.enforce ?? false,
  })
  const commits: string[] = []
  const raw = asObjectiveAuthority(authority)
  // Duck-typed authority: a spread wrapper with a spying `commit` (methods are
  // closure-bound, so the spread keeps the live core).
  const spied: ObjectiveAuthority = {
    ...raw,
    commit: (prepared, approval) => {
      commits.push(prepared.command.mutation.kind)
      return raw.commit(prepared, approval)
    },
  }
  let mutations = 0
  const control: GoalControl = buildGoalControl({
    port: spied,
    threadId: "t",
    onMutation: () => {
      mutations += 1
    },
    now: () => NOW,
    ...(over.verifier !== undefined ? { verifier: over.verifier } : {}),
    ...(over.enqueue !== undefined ? { enqueueWork: over.enqueue } : {}),
    workAttemptId: () => "user-work:fixed",
  })
  return { authority, control, commits, mutationCount: () => mutations }
}

const okReport = (r: Awaited<ReturnType<GoalControl["run"]>>) => {
  if (r.kind !== "ok" || r.report === null) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.report
}

describe("GOAL-05A — goal control", () => {
  test("rail 1 — create once; a second create is the authority's `objective-exists` and keeps the id", async () => {
    const { authority, control, commits } = make()
    const first = okReport(await control.run({ kind: "create", text: "ship it" }))
    expect(first.goal).toBe("ship it")
    expect(first.validationContract).toBe("missing")
    const again = await control.run({ kind: "create", text: "ship it again" })
    expect(again.kind).toBe("rejected")
    if (again.kind === "rejected") expect(again.reason).toBe("objective-exists")
    expect(authority.get("t")?.objectiveId).toBe(first.objectiveId)
    expect(commits).toEqual(["create", "create"]) // one commit per command, refused by the authority
  })

  test("rail 15 — 4000 chars pass, 4001 fail identically to the domain (goal-too-long)", async () => {
    const { control } = make()
    expect((await control.run({ kind: "create", text: "x".repeat(MAX_GOAL_CHARS) })).kind).toBe(
      "ok",
    )
    const { control: c2 } = make()
    const r = await c2.run({ kind: "create", text: "x".repeat(MAX_GOAL_CHARS + 1) })
    expect(r.kind).toBe("rejected")
    if (r.kind === "rejected") expect(r.reason).toBe("goal-too-long")
  })

  test("rail 2 — edit mints a new id, clears definitions + evidence by default, leaves the contract missing", async () => {
    const { authority, control } = make()
    await control.run({ kind: "create", text: "v1" })
    await control.run({ kind: "criterion-add", text: "c1" })
    const cid = authority.get("t")?.successCriteria[0]?.id ?? ""
    await control.run({ kind: "criterion-complete", criterionId: cid })
    const before = authority.get("t")
    expect(before?.status).toBe("completed")
    const edited = okReport(await control.run({ kind: "edit", text: "v2", keepContract: false }))
    expect(edited.objectiveId).not.toBe(before?.objectiveId)
    expect(edited.goal).toBe("v2")
    expect(edited.counts.total).toBe(0)
    expect(edited.validationContract).toBe("missing")
    expect(edited.status).toBe("active")
  })

  test("rail 3 — edit --keep-contract carries the declarations (fresh ids), evidence starts from zero", async () => {
    const { authority, control } = make()
    await control.run({ kind: "create", text: "v1" })
    await control.run({ kind: "criterion-add", text: "manual" })
    await control.run({
      kind: "check-add",
      text: "tests",
      check: { kind: "command", argv: ["true"], timeoutMs: 1000, successExitCodes: [0] },
    })
    const manualId = authority.get("t")?.successCriteria.find((c) => c.kind === "manual")?.id ?? ""
    await control.run({ kind: "criterion-complete", criterionId: manualId })
    const oldCheckId = authority
      .get("t")
      ?.successCriteria.flatMap((c) => (c.kind === "checked" ? [c.check.id] : []))[0]
    const kept = okReport(await control.run({ kind: "edit", text: "v2", keepContract: true }))
    expect(kept.validationContract).toBe("checked")
    expect(kept.counts).toEqual({
      total: 2,
      manualMet: 0,
      verified: 0,
      checkedUnverified: 1,
      remaining: 2,
    })
    const o = authority.get("t")
    expect(o?.successCriteria.every((c) => !c.met)).toBe(true)
    const newCheckId = o?.successCriteria.flatMap((c) =>
      c.kind === "checked" ? [c.check.id] : [],
    )[0]
    expect(newCheckId).not.toBe(oldCheckId)
    expect(o?.successCriteria.find((c) => c.kind === "checked")?.text).toBe("tests")
  })

  test("criterion / check add/edit/remove: ONE replacement commit each, new id, contract re-derived", async () => {
    const { authority, control, commits } = make()
    await control.run({ kind: "create", text: "g" })
    const id0 = authority.get("t")?.objectiveId
    okReport(await control.run({ kind: "criterion-add", text: "first" }))
    const id1 = authority.get("t")?.objectiveId
    expect(id1).not.toBe(id0)
    const cid = authority.get("t")?.successCriteria[0]?.id ?? ""
    okReport(await control.run({ kind: "criterion-edit", criterionId: cid, text: "renamed" }))
    expect(authority.get("t")?.successCriteria[0]?.text).toBe("renamed")
    const added = okReport(
      await control.run({
        kind: "check-add",
        text: "lint",
        check: { kind: "command", argv: ["true"], timeoutMs: 500, successExitCodes: [0] },
      }),
    )
    expect(added.validationContract).toBe("checked")
    const checkId =
      authority
        .get("t")
        ?.successCriteria.flatMap((c) => (c.kind === "checked" ? [c.check.id] : []))[0] ?? ""
    okReport(
      await control.run({
        kind: "check-edit",
        checkId,
        text: "lint2",
        check: { kind: "command", argv: ["false"], timeoutMs: 600, successExitCodes: [1] },
      }),
    )
    const edited = authority.get("t")?.successCriteria.find((c) => c.kind === "checked")
    expect(edited?.text).toBe("lint2")
    expect(edited?.kind === "checked" ? edited.check.argv : []).toEqual(["false"])
    const newCheckId = edited?.kind === "checked" ? edited.check.id : ""
    okReport(await control.run({ kind: "check-remove", checkId: newCheckId }))
    expect(authority.get("t")?.successCriteria.some((c) => c.kind === "checked")).toBe(false)
    const cid2 = authority.get("t")?.successCriteria[0]?.id ?? ""
    okReport(await control.run({ kind: "criterion-remove", criterionId: cid2 }))
    expect(authority.get("t")?.successCriteria).toHaveLength(0)
    expect(commits).toEqual([
      "create",
      "replace",
      "replace",
      "replace",
      "replace",
      "replace",
      "replace",
    ])
    // unknown ids are typed `invalid` results BEFORE any commit
    const before = commits.length
    expect((await control.run({ kind: "criterion-remove", criterionId: "nope" })).kind).toBe(
      "invalid",
    )
    expect((await control.run({ kind: "check-remove", checkId: "nope" })).kind).toBe("invalid")
    expect(commits.length).toBe(before)
  })

  test("two checks: remove/edit address the check by ITS id (the other survives untouched)", async () => {
    const { authority, control } = make()
    await control.run({ kind: "create", text: "g" })
    const decl = (argv: string) => ({
      kind: "command" as const,
      argv: [argv],
      timeoutMs: 1000,
      successExitCodes: [0],
    })
    await control.run({ kind: "check-add", text: "first", check: decl("first-cmd") })
    await control.run({ kind: "check-add", text: "second", check: decl("second-cmd") })
    const ids = () =>
      (authority.get("t")?.successCriteria ?? []).flatMap((c) =>
        c.kind === "checked" ? [{ id: c.check.id, text: c.text, argv: c.check.argv[0] }] : [],
      )
    const second = ids().find((c) => c.text === "second")?.id ?? ""
    okReport(
      await control.run({
        kind: "check-edit",
        checkId: second,
        text: "second*",
        check: decl("second-cmd2"),
      }),
    )
    expect(ids().map((c) => `${c.text}:${c.argv}`)).toEqual([
      "first:first-cmd",
      "second*:second-cmd2",
    ])
    const secondAgain = ids().find((c) => c.text === "second*")?.id ?? ""
    okReport(await control.run({ kind: "check-remove", checkId: secondAgain }))
    expect(ids().map((c) => c.text)).toEqual(["first"])
  })

  test("rail 5 — manual complete/reopen route to markCriterion; a checked criterion is verifier-only", async () => {
    const { authority, control } = make()
    await control.run({ kind: "create", text: "g" })
    await control.run({ kind: "criterion-add", text: "m" })
    await control.run({
      kind: "check-add",
      text: "chk",
      check: { kind: "command", argv: ["true"], timeoutMs: 1000, successExitCodes: [0] },
    })
    const manual = authority.get("t")?.successCriteria.find((c) => c.kind === "manual")?.id ?? ""
    const checked = authority.get("t")?.successCriteria.find((c) => c.kind === "checked")?.id ?? ""
    const done = okReport(await control.run({ kind: "criterion-complete", criterionId: manual }))
    expect(done.counts.manualMet).toBe(1)
    expect(done.status).toBe("active") // the checked one is still open — derived, not predicted
    const reopened = okReport(await control.run({ kind: "criterion-reopen", criterionId: manual }))
    expect(reopened.counts.manualMet).toBe(0)
    const refused = await control.run({ kind: "criterion-complete", criterionId: checked })
    expect(refused.kind).toBe("rejected")
    if (refused.kind === "rejected") expect(refused.reason).toBe("checked-verifier-only")
  })

  test("rail 4 — budget amend: same id, evidence kept, clamped, reactivates user-limit exhaustion, rejected when completed", async () => {
    const { authority, control } = make({ enforce: true })
    await control.run({ kind: "create", text: "g" })
    await control.run({ kind: "criterion-add", text: "m" })
    const id = authority.get("t")?.objectiveId
    okReport(await control.run({ kind: "budget", budget: { maxTurns: 1 } }))
    settleTurns(authority, "t", 1)
    expect(authority.get("t")?.status).toBe("budget_limited")
    const amended = okReport(
      await control.run({
        kind: "budget",
        budget: { maxTurns: PRODUCT_BUDGET_CEILING.maxTurns + 50 },
      }),
    )
    expect(amended.objectiveId).toBe(id ?? "")
    expect(amended.status).toBe("active")
    expect(amended.budget.maxTurns).toBe(PRODUCT_BUDGET_CEILING.maxTurns)
    const cid = authority.get("t")?.successCriteria[0]?.id ?? ""
    okReport(await control.run({ kind: "criterion-complete", criterionId: cid }))
    const refused = await control.run({ kind: "budget", budget: { maxTurns: 3 } })
    expect(refused.kind).toBe("rejected")
    if (refused.kind === "rejected") expect(refused.reason).toBe("terminal-objective")
  })

  test("rail 6/7 — clear is deletion; pause/resume are explicit; blocked resume is the authority's typed refusal", async () => {
    const { authority, control } = make()
    await control.run({ kind: "create", text: "g" })
    expect(okReport(await control.run({ kind: "pause" })).status).toBe("paused")
    expect(okReport(await control.run({ kind: "resume" })).status).toBe("active")
    createObjectiveCapabilities(authority).user.commit("t", {
      kind: "addBlocker",
      reason: "needs a decision",
      waitingOn: "user",
    })
    const blocked = await control.run({ kind: "resume" })
    expect(blocked.kind).toBe("rejected")
    if (blocked.kind === "rejected") expect(blocked.reason).toBe("invalid-transition")
    const cleared = await control.run({ kind: "clear" })
    expect(cleared.kind).toBe("ok")
    expect(authority.get("t")).toBeNull()
    expect(authority.list().filter((o) => o.threadId === "t")).toHaveLength(0)
    expect((await control.run({ kind: "pause" })).kind).toBe("no-objective")
    expect((await control.run({ kind: "clear" })).kind).toBe("no-objective")
  })

  test("onMutation fires once per successful commit and never on a refusal", async () => {
    const { control, mutationCount } = make()
    await control.run({ kind: "create", text: "g" })
    await control.run({ kind: "create", text: "again" })
    await control.run({ kind: "pause" })
    expect(mutationCount()).toBe(2)
  })

  test("verify: no verifier ⇒ typed invalid; with a verifier ⇒ the outcome + a fresh report, no agent turn", async () => {
    const calls: string[] = []
    const verifier: ObjectiveVerificationPort = {
      verify: async (threadId) => {
        calls.push(`verify:${threadId}`)
        return { kind: "no-checks" }
      },
      reconcile: async () => ({ kind: "no-objective" }),
    }
    const { control } = make()
    await control.run({ kind: "create", text: "g" })
    expect((await control.run({ kind: "verify" })).kind).toBe("invalid")
    const { control: withVerifier, commits } = make({ verifier })
    await withVerifier.run({ kind: "create", text: "g" })
    const r = await withVerifier.run({ kind: "verify" })
    expect(r.kind).toBe("verified")
    if (r.kind === "verified") expect(r.outcome).toEqual({ kind: "no-checks" })
    expect(calls).toEqual(["verify:t"])
    expect(commits).toEqual(["create"]) // verify itself commits nothing from the CLI
  })

  test("work: enqueues ONE foreground prompt with user-requested provenance bound to the live revision", async () => {
    const queued: CliPromptInput[] = []
    const { authority, control } = make({ enqueue: (i) => queued.push(i) })
    await control.run({ kind: "create", text: "g" })
    const r = await control.run({ kind: "work", instruction: "fix the flake" })
    expect(r.kind).toBe("work-queued")
    expect(queued).toHaveLength(1)
    const q = queued[0]
    if (q === undefined || typeof q === "string") throw new Error("expected structured prompt")
    expect(q.text).toContain("fix the flake")
    expect(q.goalContinuation).toEqual({
      threadId: "t",
      objectiveRevision: authority.readDomain("t").revision,
      attemptKey: "user-work:fixed",
      provenance: "user-requested-goal-work",
    })
    const { control: unwired } = make()
    await unwired.run({ kind: "create", text: "g" })
    expect((await unwired.run({ kind: "work", instruction: "x" })).kind).toBe("invalid")
  })
})
