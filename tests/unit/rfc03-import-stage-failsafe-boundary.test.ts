/**
 * ADVERSARIAL AUDIT (DEAD-SEAM) — RFC03-4 startup skill IMPORT: the STAGE side is
 * live but the PROMOTE side is an unreachable dead seam.
 *
 * CLAIM under test (docs/plans/aug-02-absorption/rfc-03 RFC03-4 DoD): imported
 * skills are "review 전 inert" and promote "on approve". The wire
 * `runConfigMigrationImport` stages an imported `.claude/skills/*​/SKILL.md`, but:
 *
 *   1. The staging store is an in-memory `Map` (promote.ts:22/49), created FRESH
 *      per import run inside `composeImportSkillStage` (production omits the
 *      `staging` arg). It is NOT persisted to disk.
 *   2. The `approval` machine that carries the pending proposal is likewise
 *      per-run and is DROPPED — the sole caller destructures only `{ stage }`
 *      (config-migration-notice.ts:162).
 *   3. There is NO production consumer of the `promote-imported-skill` resumeStep,
 *      and `runConfigMigrationImport` returns the staging store / approval to no
 *      one. So after the import returns, the staged bytes are unreachable and can
 *      NEVER be promoted through any real front door.
 *
 * This is not the documented "durable, inert" boundary the skill-stage docstring
 * claims (config-migration-skill-stage.ts:22-28). It is emitted-into-a-void: an
 * imported skill can never become live via any operator action.
 *
 * The tests below PROVE the deadness structurally (no production promote path)
 * and behaviorally (after the real front door, nothing is promotable and the live
 * dir stays empty forever). They do NOT modify production.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readdir } from "node:fs/promises"
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

describe("DEAD SEAM — RFC03-4 promote side is unreachable after the real import front door", () => {
  test("after runConfigMigrationImport, the staged skill is (a) never live and (b) leaves NO on-disk artifact to promote", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)

    // Drive the REAL startup import entry (both gates on). The injected `homeDir`
    // (3rd arg, prod defaults to os.homedir()) makes the wire stage into the SAME
    // temp dir this test inspects — os.homedir() ignores process.env.HOME under
    // Bun, so without this the boundary assertion below would be VACUOUS (it would
    // inspect a temp dir the wire never touched). Now an unapproved live-write
    // would land in `importSkillsDir(home)` and fail assertion (a).
    const notice = await runConfigMigrationImport(project, process.env, home)

    // The import reports the skill as "staged" (persistSkills succeeded).
    expect(notice ?? "").toContain("skills")

    // (a) The skill is NOT live-written (correct — inert before approve).
    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    await expect(stat(livePath)).rejects.toBeDefined()

    // (b) PROVE the deadness: the staging store is an in-memory Map created
    // per-run inside composeImportSkillStage. There is NO on-disk CAS artifact
    // anywhere under the home skills dir (the docstring's "durable" claim is
    // false — the Map died with the function return). Enumerate the entire
    // skills-dir subtree: it must contain NOTHING (no staged bytes, no live
    // skill). If any durable staged artifact existed, a future promote front
    // door could reach it; it does not.
    const skillsRoot = importSkillsDir(home)
    let entries: string[] = []
    try {
      entries = await readdir(skillsRoot, { recursive: true } as never)
    } catch {
      entries = [] // dir absent ⇒ nothing staged on disk at all
    }
    // No file was written under the skills dir at all — the staged bytes live
    // ONLY in a garbage-collected in-memory Map. Nothing is promotable.
    const files = entries.filter((e) => e.endsWith("SKILL.md"))
    expect(files).toEqual([])
  })

  test("STRUCTURAL — no production consumer exists for the promote-imported-skill resumeStep, and the sole wire drops the approval", async () => {
    // The stage opens an approval with resumeStep "promote-imported-skill"
    // (config-migration-skill-stage.ts:97). For that approval to ever promote,
    // some production surface must (1) hold the approval machine and (2) act on
    // that resumeStep. Prove neither exists by scanning production source.
    const { readFile: rf } = await import("node:fs/promises")
    const srcRoot = join(import.meta.dir, "..", "..", "src")

    // Walk src/**.ts collecting the text (excludes tests — we are under tests/).
    const collect = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      for (const ent of await rf(dir, "utf8").then(
        () => [] as string[],
        async () => {
          const { readdir } = await import("node:fs/promises")
          const items = await readdir(dir, { withFileTypes: true })
          const acc: string[] = []
          for (const it of items) {
            const p = join(dir, it.name)
            if (it.isDirectory()) acc.push(...(await collect(p)))
            else if (it.name.endsWith(".ts")) acc.push(p)
          }
          return acc
        },
      )) {
        out.push(ent)
      }
      return out
    }
    const files = await collect(srcRoot)
    let promoteConsumers = 0
    for (const f of files) {
      const txt = await rf(f, "utf8")
      // A production site that ACTS on the import approval's resumeStep. The
      // producer (skill-stage.ts) is the only legitimate mention.
      if (
        txt.includes('"promote-imported-skill"') &&
        !f.endsWith("config-migration-skill-stage.ts")
      ) {
        promoteConsumers += 1
      }
    }
    // ZERO production consumers of the promote step → nothing acts on the opened
    // approval; the staged proposal is emitted into a void.
    expect(promoteConsumers).toBe(0)

    // And confirm the SOLE wire drops the approval: it destructures ONLY `stage`
    // from composeImportSkillStage's `{ stage, approval }` return, so the machine
    // holding the pending proposal (and the in-memory staging Map behind it) is
    // unreachable the instant the import returns.
    const wireTxt = await rf(
      join(srcRoot, "apps", "cli", "config-migration-notice.ts"),
      "utf8",
    )
    expect(wireTxt).toContain("const { stage } = composeImportSkillStage")
    // The wire never binds the returned `approval` to a variable it could pass on
    // (the only "approval" occurrence is a prose comment, not a binding/use).
    expect(wireTxt).not.toContain("approval:")
    expect(wireTxt).not.toContain(", approval }")
    expect(wireTxt).not.toContain("stage, approval")
  })
})
