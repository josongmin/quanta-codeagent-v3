/**
 * ★ HELLGATE — the browser's `/goal` command is threaded to REAL senders.
 *
 * The palette's coverage of the daemon vocabulary is guarded elsewhere
 * (`readout-slug-parity-hellgate`). That guard is satisfied by a command that
 * exists — it says nothing about whether the host handed it a live socket. This
 * campaign has now hit that exact failure mode three times: `sendGoalWork` and
 * `onGoalWorkResult` shipped fully implemented and unit-tested with zero
 * callers; the `/model` readout shipped unthreaded; the objective pane read the
 * wrong thread id. A builder with an "unwired" fallback is precisely the shape
 * that passes every test while doing nothing.
 *
 * So this pins the composition ROOT. It is a source-text guard rather than an
 * import because `slash-catalog.ts` reaches `SlashPalette.tsx`, and the repo's
 * root typecheck has no `jsx` setting — importing it from `tests/` would red the
 * gate this test is meant to run inside. The parse is asserted non-degenerate so
 * a rename fails loud instead of passing vacuously.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { sliceBetween } from "./_shared/slice-between"
import { stripComments } from "./_shared/strip-comments"

const ROOT = resolve(import.meta.dir, "..", "..")
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8")

const APP = "apps/web-frontend/src/App.tsx"
const CATALOG = "apps/web-frontend/src/components/slash-catalog.ts"
const HOOKS = "apps/web-frontend/src/ws/session-hooks.ts"
const GOAL_BUILDER = "apps/web-frontend/src/components/slash-goal.ts"

describe("web /goal — the parse is non-degenerate", () => {
  test("all three files exist and are substantial", () => {
    for (const file of [APP, CATALOG, HOOKS, GOAL_BUILDER]) {
      expect(read(file).length).toBeGreaterThan(1_000)
    }
  })
})

describe("web /goal — the composition root threads live senders", () => {
  test("the catalogue assembles the goal builder", () => {
    const catalog = read(CATALOG)

    expect(catalog).toMatch(/buildGoalSlashCommands\s*\(/)
    expect(catalog).toContain("sendObjectiveMutate")
    expect(catalog).toContain("sendGoalWork")
    expect(catalog).toContain("requestGoalVerification")
  })

  test("App hands the catalogue a real objective-mutate sender, not the fallback", () => {
    const app = read(APP)

    expect(app).toContain("useSendObjectiveMutate")
    expect(app).toMatch(/sendObjectiveMutate:\s*\(mutation,\s*expectedObjectiveRevision\)\s*=>/)
  })

  test("App hands the catalogue the client's own goalWork sender", () => {
    expect(read(APP)).toMatch(/sendGoalWork:\s*\(text\)\s*=>\s*client\.sendGoalWork\(text\)/)
  })

  test("App subscribes the goalWork answer, so a refusal reaches the operator", () => {
    // The daemon answers every case now, including the ones it used to drop.
    // Without a subscriber the browser would send and show nothing either way.
    expect(read(APP)).toContain("client.onGoalWorkResult")
  })

  test("App threads the correlated verifier request into the catalogue", () => {
    const app = read(APP)

    expect(app).toMatch(/useRequestGoalVerification\s*\(client\)/)
    expect(app).toMatch(/requestGoalVerification\s*\(expectedObjectiveRevision\)/)
  })
})

describe("web /goal — the control verbs are threaded, not stubbed", () => {
  test("the catalogue gives the goal builder the structured reader", () => {
    // COMMENTS STRIPPED FIRST, and the window anchored on NAMED KEYS.
    //
    // This asserted `/readGoalReadout\(/` over `slice(0, indexOf("})"))`, which was
    // wrong in both directions. Measured: replacing the wiring with
    // `readGoal: displayOnlyGoalReader` while leaving the identifier in a nearby
    // COMMENT left the test green (a false PASS on the thing it is named for), and
    // adding one benign line containing `})` before `readGoal:` moved the window end
    // in front of the key and turned it red with the wiring untouched (a false RED).
    const catalog = stripComments(read(CATALOG))
    const goalEntry = sliceBetween(catalog, "buildGoalSlashCommands({", "sendObjectiveMutate:", {
      label: "slash-catalog.ts buildGoalSlashCommands entry",
    })

    // The ASSIGNMENT, not the identifier: a mention cannot satisfy this.
    expect(goalEntry).toMatch(/readGoal:\s*\(\)\s*=>\s*readGoalReadout\(/)
  })

  test("the builder owns the control verbs, not just show/set/work", () => {
    const builder = read(GOAL_BUILDER)

    for (const mutation of [
      '"setExplicitStatus"',
      '"clear"',
      '"replace"',
      '"create"',
      '"abandonAttempt"',
      '"amendBudget"',
    ]) {
      expect(builder).toContain(mutation)
    }
  })

  test("the send truth is forwarded into a correlated receipt", () => {
    const hooks = read(HOOKS)
    const start = hooks.indexOf("export const sendObjectiveMutation")
    const end = hooks.indexOf("export const useSendPermissionMode")
    const body = hooks.slice(start, end)

    // The defect this pins: the hook returned a bare `true` on the strength of
    // having a session id, while `client.send` silently drops on a closed or
    // pre-handshake socket.
    expect(body).toContain("const sent = client.send(")
    expect(body).toContain('finish({ kind: "undelivered" })')
    expect(body).toContain("event.causedByCommandId === commandId")
    expect(body).toContain("frame.commandId === commandId")
  })

  test("budget reuses the CLI's own flag syntax rather than inventing a second one", () => {
    // Two surfaces, one syntax: an operator who learned `--max-turns=` in the
    // terminal must not have to learn a different one in the browser.
    const pattern = "^--max-(tokens|turns)=(\\d+)$"

    expect(read(GOAL_BUILDER)).toContain(pattern)
    expect(read("src/apps/cli/slash/goal-cmd.ts")).toContain(pattern)
  })

  test("an objective refusal is not called a rejected TURN", () => {
    const hooks = read(HOOKS)

    expect(hooks).toContain("goal change refused")
    // The generic copy survives for everything that really is a turn.
    expect(hooks).toContain("turn rejected: ")
  })
})

describe("web /goal — the mutate command is the USER-actor route", () => {
  test("the hook sends session.objective.mutate and reports an undeliverable write", () => {
    const hooks = read(HOOKS)

    expect(hooks).toContain("useSendObjectiveMutate")
    expect(hooks).toContain('type: "session.objective.mutate"')
    // No session yet ⇒ the caller is told, rather than the write vanishing.
    expect(hooks).toMatch(
      /sendObjectiveMutation[\s\S]{0,900}?if \(sessionId === null\)[\s\S]{0,80}?undelivered/,
    )
  })

  test("it sends the objective revision from the structured read", () => {
    const hooks = read(HOOKS)
    const start = hooks.indexOf("export const useSendObjectiveMutate")
    const end = hooks.indexOf("export const useSendPermissionMode")

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(hooks.slice(start, end)).toContain("expectedObjectiveRevision")
    const builder = read(GOAL_BUILDER)
    expect(builder).toContain("snapshot.revision")
    expect(builder).not.toContain("parseGoalReadout")
  })

  test("verify uses its dedicated correlated channel, not a user mutation", () => {
    const builder = read(GOAL_BUILDER)
    const start = builder.indexOf("const runVerify")
    const end = builder.indexOf("const runControl")
    const verifyBody = builder.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(verifyBody).toMatch(/requestGoalVerification\s*\(snapshot\.revision\)/)
    expect(verifyBody).not.toContain("sendObjectiveMutate")

    const hooks = read(HOOKS)
    const hookStart = hooks.indexOf("export const requestGoalVerification")
    const hookEnd = hooks.indexOf("export const useRequestGoalVerification")
    const hookBody = hooks.slice(hookStart, hookEnd)
    expect(hookBody).toMatch(/sendGoalVerify\s*\(requestId,\s*expectedObjectiveRevision\)/)
    expect(hookBody).toMatch(/frame\.requestId\s*===\s*requestId/)
  })
})
