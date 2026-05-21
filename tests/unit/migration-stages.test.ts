/**
 * ADR-0038: 4-stage event sequencing + halt-on-error semantics for the
 * external-agent importer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ImportEvent,
  type ImportStage,
  runImport,
  UnknownProviderRejectedError,
} from "@/migration"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "migration-stages-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const seedClaude = async (sessionCount: number, withSkills: boolean): Promise<void> => {
  await writeFile(join(home, ".claude/auth.json"), "{}", "utf8").catch(async () => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude/auth.json"), "{}", "utf8")
  })
  await mkdir(join(home, ".claude/projects"), { recursive: true })
  for (let i = 0; i < sessionCount; i++) {
    await writeFile(join(home, `.claude/projects/sess-${i}.json`), "{}", "utf8")
  }
  if (withSkills) {
    await mkdir(join(home, ".claude/skills"), { recursive: true })
    await writeFile(join(home, ".claude/skills/skill-1.md"), "skill", "utf8")
    await writeFile(join(home, ".claude/skills/skill-2.md"), "skill", "utf8")
  }
}

const collectEvents = (): { sink: (e: ImportEvent) => void; events: ImportEvent[] } => {
  const events: ImportEvent[] = []
  return { sink: (e) => events.push(e), events }
}

describe("runImport stage sequencing (ADR-0038)", () => {
  test("happy path: claude_code with 3 sessions + skills ⇒ 4 events, ok:true", async () => {
    await seedClaude(3, true)
    const { sink, events } = collectEvents()
    const r = await runImport("claude_code", { homeDir: home }, sink)
    expect(r.sessionsImported).toBe(3)
    expect(r.skillsImported).toBe(2)
    expect(r.errors).toEqual([])
    const stages: ImportStage[] = events.map((e) => e.stage)
    expect(stages).toEqual([
      "detect_finished",
      "provider_stage_finished",
      "session_completion_finished",
      "import_finished",
    ])
    expect(events.every((e) => e.ok)).toBe(true)
  })

  test("provider not present ⇒ halts after detect_finished with ok:false", async () => {
    // Empty home — no providers.
    const { sink, events } = collectEvents()
    const r = await runImport("claude_code", { homeDir: home }, sink)
    expect(r.errors).toEqual(["detect_finished failed"])
    const stages = events.map((e) => e.stage)
    expect(stages).toEqual(["detect_finished", "import_finished"])
    expect(events[0]?.ok).toBe(false)
    expect(events[1]?.ok).toBe(false)
  })

  test("provider present with 0 sessions ⇒ ok:true, counts are 0", async () => {
    await seedClaude(0, false)
    const { sink, events } = collectEvents()
    const r = await runImport("claude_code", { homeDir: home }, sink)
    expect(r.sessionsImported).toBe(0)
    expect(r.skillsImported).toBe(0)
    expect(events).toHaveLength(4)
    expect(events.every((e) => e.ok)).toBe(true)
  })

  test("includeSkills:false ⇒ skillsImported is 0 even if skills/ exists", async () => {
    await seedClaude(1, true)
    const { sink } = collectEvents()
    const r = await runImport("claude_code", { homeDir: home, includeSkills: false }, sink)
    expect(r.skillsImported).toBe(0)
  })

  test("provider='unknown' ⇒ throws UnknownProviderRejectedError (no silent path)", async () => {
    const { sink } = collectEvents()
    await expect(runImport("unknown", { homeDir: home }, sink)).rejects.toBeInstanceOf(
      UnknownProviderRejectedError,
    )
  })

  test("events are delivered in order, exactly once each", async () => {
    await seedClaude(1, false)
    const { sink, events } = collectEvents()
    await runImport("claude_code", { homeDir: home }, sink)
    const stageCounts = new Map<ImportStage, number>()
    for (const e of events) stageCounts.set(e.stage, (stageCounts.get(e.stage) ?? 0) + 1)
    expect(stageCounts.get("detect_finished")).toBe(1)
    expect(stageCounts.get("provider_stage_finished")).toBe(1)
    expect(stageCounts.get("session_completion_finished")).toBe(1)
    expect(stageCounts.get("import_finished")).toBe(1)
  })

  test("import_finished is ALWAYS terminal (success or failure)", async () => {
    // Success path
    await seedClaude(0, false)
    const ok = collectEvents()
    await runImport("claude_code", { homeDir: home }, ok.sink)
    expect(ok.events[ok.events.length - 1]?.stage).toBe("import_finished")

    // Failure path (new home, no provider)
    const home2 = await mkdtemp(join(tmpdir(), "migration-stages-fail-"))
    const fail = collectEvents()
    await runImport("claude_code", { homeDir: home2 }, fail.sink)
    expect(fail.events[fail.events.length - 1]?.stage).toBe("import_finished")
    expect(fail.events[fail.events.length - 1]?.ok).toBe(false)
    await rm(home2, { recursive: true, force: true })
  })
})
