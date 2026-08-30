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

const ROOT = resolve(import.meta.dir, "..", "..")
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8")

const APP = "apps/web-frontend/src/App.tsx"
const CATALOG = "apps/web-frontend/src/components/slash-catalog.ts"
const HOOKS = "apps/web-frontend/src/ws/session-hooks.ts"

describe("web /goal — the parse is non-degenerate", () => {
  test("all three files exist and are substantial", () => {
    for (const file of [APP, CATALOG, HOOKS]) {
      expect(read(file).length).toBeGreaterThan(1_000)
    }
  })
})

describe("web /goal — the composition root threads live senders", () => {
  test("the catalogue assembles the goal builder", () => {
    const catalog = read(CATALOG)

    expect(catalog).toContain("buildGoalSlashCommands")
    expect(catalog).toContain("sendObjectiveMutate")
    expect(catalog).toContain("sendGoalWork")
  })

  test("App hands the catalogue a real objective-mutate sender, not the fallback", () => {
    const app = read(APP)

    expect(app).toContain("useSendObjectiveMutate")
    expect(app).toMatch(/sendObjectiveMutate:\s*\(mutation\)\s*=>/)
  })

  test("App hands the catalogue the client's own goalWork sender", () => {
    expect(read(APP)).toMatch(/sendGoalWork:\s*\(text\)\s*=>\s*client\.sendGoalWork\(text\)/)
  })

  test("App subscribes the goalWork answer, so a refusal reaches the operator", () => {
    // The daemon answers every case now, including the ones it used to drop.
    // Without a subscriber the browser would send and show nothing either way.
    expect(read(APP)).toContain("client.onGoalWorkResult")
  })
})

describe("web /goal — the mutate command is the USER-actor route", () => {
  test("the hook sends session.objective.mutate and reports an undeliverable write", () => {
    const hooks = read(HOOKS)

    expect(hooks).toContain("useSendObjectiveMutate")
    expect(hooks).toContain('type: "session.objective.mutate"')
    // No session yet ⇒ the caller is told, rather than the write vanishing.
    expect(hooks).toMatch(
      /useSendObjectiveMutate[\s\S]{0,900}?if \(sessionId === null\) return false/,
    )
  })

  test("it does NOT invent an expectedObjectiveRevision the browser cannot know", () => {
    const hooks = read(HOOKS)
    const start = hooks.indexOf("export const useSendObjectiveMutate")
    const end = hooks.indexOf("export const useSendPermissionMode")

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(hooks.slice(start, end)).not.toContain("expectedObjectiveRevision")
  })
})
