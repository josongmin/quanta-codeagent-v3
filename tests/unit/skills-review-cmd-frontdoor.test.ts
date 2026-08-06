/**
 * FRONT-DOOR PROOF — `/skills review` CLI command over the REAL review surface.
 *
 * Drives `runSlashCommand("/skills review …", ctx)` exactly as the REPL surface
 * dispatches it, with `ctx.skillReview` bound to a REAL `composeImportSkillStage`
 * review surface (same approval machine + artifact port + staging store). Proves:
 *   - `/skills review` LISTS a staged pending proposal.
 *   - `/skills review approve <id>` runs the hash-verified CAS promote (writes
 *     the live SKILL.md) — the ONLY live-dir write path.
 *   - `/skills review deny <id>` drops (no live write).
 *   - default-OFF: with NO `skillReview` slot, `/skills review` prints
 *     "no staged skill proposals" + exit 0 (byte-identical to no-import).
 *   - a bare `/skills` (no args) still lists the inventory (unchanged).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeImportSkillStage } from "@/apps/cli/config-migration-skill-stage"
import type { StagingStore } from "@/skill"
import { sha256Hex } from "@/storage"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import type { SkillRow } from "../../src/apps/cli/slash-contract"

interface Cap {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (cwd: string, over?: Partial<SlashContext>): Cap => {
  const cap: Cap = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        cap.out += s
      },
      err: (s) => {
        cap.err += s
      },
      cwd,
      ...over,
    },
  }
  return cap
}

const SKILL_BODY = "---\nname: s1\ndescription: d\n---\nbody\n"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-review-cmd-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Stage one proposal into a real review surface over `<dir>/skills`. */
const stageOne = async (): Promise<{
  review: NonNullable<SlashContext["skillReview"]>
  liveSkillsDir: string
}> => {
  const liveSkillsDir = join(dir, "skills")
  await mkdir(liveSkillsDir, { recursive: true })
  const staging: StagingStore = new Map()
  const { stage, review } = composeImportSkillStage(liveSkillsDir, staging)
  await stage.stage({
    artifactHash: sha256Hex(SKILL_BODY),
    bytes: SKILL_BODY,
    name: "s1",
    targetPath: "s1/SKILL.md",
    kind: "new",
  })
  return { review, liveSkillsDir }
}

describe("/skills review — front door", () => {
  test("lists a pending staged proposal", async () => {
    const { review } = await stageOne()
    const cap = buildCtx(dir, { skillReview: review })
    const code = await runSlashCommand("/skills review", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("1 pending")
    expect(cap.out).toContain("s1")
    expect(cap.out).toContain("s1/SKILL.md")
  })

  test("approve <id> promotes the live SKILL.md (hash-verified); id is required", async () => {
    const { review, liveSkillsDir } = await stageOne()
    const id = review.list()[0]?.id ?? ""
    const cap = buildCtx(dir, { skillReview: review })

    // No id ⇒ refused (exit 1), no write.
    const bad = await runSlashCommand("/skills review approve", cap.ctx)
    expect(bad).toBe(1)
    await expect(stat(join(liveSkillsDir, "s1", "SKILL.md"))).rejects.toBeDefined()

    const code = await runSlashCommand(`/skills review approve ${id}`, cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("promoted")
    const written = await readFile(join(liveSkillsDir, "s1", "SKILL.md"), "utf8")
    expect(written).toBe(SKILL_BODY)
    expect(sha256Hex(written)).toBe(sha256Hex(SKILL_BODY))
    // No longer pending.
    expect(review.list().length).toBe(0)
  })

  test("deny <id> drops (no live write)", async () => {
    const { review, liveSkillsDir } = await stageOne()
    const id = review.list()[0]?.id ?? ""
    const cap = buildCtx(dir, { skillReview: review })
    const code = await runSlashCommand(`/skills review deny ${id}`, cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("dropped")
    await expect(stat(join(liveSkillsDir, "s1", "SKILL.md"))).rejects.toBeDefined()
    expect(review.list().length).toBe(0)
  })

  test("default-OFF — no skillReview slot ⇒ 'no staged skill proposals' + exit 0", async () => {
    const cap = buildCtx(dir)
    const code = await runSlashCommand("/skills review", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no staged skill proposals")
  })

  test("bare /skills (no args) still lists the inventory (review is additive)", async () => {
    const rows: SkillRow[] = [{ name: "alpha", description: "the alpha skill" }]
    const cap = buildCtx(dir, { skills: async () => rows })
    const code = await runSlashCommand("/skills", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("alpha")
  })
})
