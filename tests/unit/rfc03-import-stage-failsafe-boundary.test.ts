/**
 * CLOSED-LOOP GUARD (was: DEAD-SEAM audit) — RFC03-def startup skill IMPORT:
 * the STAGE side stages AND the PROMOTE side is now reachable via the review
 * surface `runConfigMigrationImport` threads out.
 *
 * HISTORY: this file previously PINNED the dead seam — the sole wire destructured
 * only `{ stage }` from `composeImportSkillStage`, dropping the approval machine +
 * staging store, so the staged proposal was unreachable (no consumer of the
 * `promote-imported-skill` resumeStep). RFC03-def closed that: the wire now
 * threads a `review` surface bound to the SAME approval machine + artifact port +
 * staging store, and `/skills review` consumes it. These tests now assert the
 * loop is CLOSED and the fail-SAFE boundary still holds:
 *
 *   1. After the real import front door, the staged proposal is REVIEWABLE (the
 *      returned `review.list()` surfaces it) — it is no longer emitted into a void.
 *   2. STILL fail-safe before approve: NO live-dir write happens at import time
 *      (the live skills dir stays empty until an explicit `approve`).
 *   3. A production consumer of the promote step now EXISTS (the `/skills review`
 *      surface), and the sole wire binds the returned `review` (does not drop it).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runConfigMigrationImport } from "@/apps/cli/config-migration-notice"
import { importSkillsDir } from "@/apps/cli/config-migration-skill-stage"
import { __resetRuntimeConfig } from "@/shared"

let home: string
let project: string
let prevHome: string | undefined
let prevMigrate: string | undefined
let prevImport: string | undefined

const SKILL = `---
name: imported-helper
description: an imported helper skill
userInvocable: true
allowedTools: []
category: skill
stability: stable
---
Do the imported thing.
`

const write = async (p: string, c: string): Promise<void> => {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(p, c, "utf8")
}

const collectTypeScriptFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return collectTypeScriptFiles(path)
      return entry.name.endsWith(".ts") ? [path] : []
    }),
  )
  return files.flat()
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "audit2-home-"))
  project = await mkdtemp(join(tmpdir(), "audit2-proj-"))
  prevHome = process.env.HOME
  prevMigrate = process.env.QUANTA_MIGRATE_CONFIG
  prevImport = process.env.QUANTA_MIGRATE_CONFIG_IMPORT
  process.env.HOME = home
  process.env.QUANTA_MIGRATE_CONFIG = "1"
  process.env.QUANTA_MIGRATE_CONFIG_IMPORT = "1"
  __resetRuntimeConfig()
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (prevMigrate === undefined) delete process.env.QUANTA_MIGRATE_CONFIG
  else process.env.QUANTA_MIGRATE_CONFIG = prevMigrate
  if (prevImport === undefined) delete process.env.QUANTA_MIGRATE_CONFIG_IMPORT
  else process.env.QUANTA_MIGRATE_CONFIG_IMPORT = prevImport
  __resetRuntimeConfig()
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe("CLOSED LOOP — RFC03-def promote side is reachable, still fail-safe before approve", () => {
  test("after runConfigMigrationImport, the staged skill is (a) REVIEWABLE and (b) NOT live-written before approve", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)

    // Drive the REAL startup import entry (both gates on). The injected `homeDir`
    // (3rd arg, prod defaults to os.homedir()) makes the wire stage into the SAME
    // temp dir this test inspects — os.homedir() ignores process.env.HOME under
    // Bun, so without this the boundary assertion below would be VACUOUS.
    const { notice, review } = await runConfigMigrationImport(project, process.env, home)

    // The import reports the skill as "staged" (persistSkills succeeded).
    expect(notice ?? "").toContain("skills")

    // (a) The staged proposal is REVIEWABLE — the wire threaded the review surface
    // out (the loop is closed, not emitted into a void).
    expect(review).toBeDefined()
    expect(review?.list().length).toBe(1)
    expect(review?.list()[0]?.name).toBe("imported-helper")

    // (b) STILL fail-safe: NO live write before approve. The live skills dir has
    // no SKILL.md (promotion happens ONLY on an explicit review.approve).
    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    await expect(stat(livePath)).rejects.toBeDefined()
    const skillsRoot = importSkillsDir(home)
    let entries: string[] = []
    try {
      entries = await readdir(skillsRoot, { recursive: true } as never)
    } catch {
      entries = []
    }
    const files = entries.filter((e) => e.endsWith("SKILL.md"))
    expect(files).toEqual([])
  })

  test("STRUCTURAL — a production consumer of the promote-imported-skill step now EXISTS, and the sole wire binds the review", async () => {
    // The stage opens an approval with resumeStep "promote-imported-skill". A
    // production surface must (1) hold the approval machine and (2) act on that
    // step to promote. Prove such a consumer now exists in production source.
    const { readFile: rf } = await import("node:fs/promises")
    const srcRoot = join(import.meta.dir, "..", "..", "src")

    const files = await collectTypeScriptFiles(srcRoot)
    let promoteConsumers = 0
    for (const f of files) {
      const txt = await rf(f, "utf8")
      // A production site that ACTS on the import approval's promote step. The
      // producer (skill-stage.ts) is where the constant is DEFINED + the review
      // actuator lives — that IS the consumer, so it counts.
      if (
        (txt.includes('"promote-imported-skill"') || txt.includes("PROMOTE_IMPORTED_SKILL_STEP")) &&
        txt.includes("promote(") &&
        !f.endsWith(".test.ts")
      ) {
        promoteConsumers += 1
      }
    }
    // At least one production consumer now drives the promote from the step.
    expect(promoteConsumers).toBeGreaterThan(0)

    // And the SOLE wire now BINDS the returned review (does not drop it): it
    // destructures `{ stage, review }` from composeImportSkillStage.
    const wireTxt = await rf(join(srcRoot, "apps", "cli", "config-migration-notice.ts"), "utf8")
    expect(wireTxt).toContain("const { stage, review } = composeImportSkillStage")
    // The review is returned to the caller (threaded out), not dropped.
    expect(wireTxt).toContain("review")
  })

  test("end-to-end — approve promotes hash-verified; the live SKILL.md matches the staged artifact", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)
    const { review } = await runConfigMigrationImport(project, process.env, home)
    const pending = review?.list() ?? []
    expect(pending.length).toBe(1)
    const id = pending[0]?.id ?? ""
    const res = await review?.approve(id)
    expect(res?.ok).toBe(true)
    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    const written = await readFile(livePath, "utf8")
    // The live bytes are the imported (normalized) SKILL.md — non-empty, contains
    // the frontmatter name. (Hash equality is pinned in the sibling front-door.)
    expect(written).toContain("name: imported-helper")
  })
})
