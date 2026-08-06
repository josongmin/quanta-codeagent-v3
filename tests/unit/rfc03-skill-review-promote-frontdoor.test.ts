/**
 * FRONT-DOOR PROOF — RFC03-4 CLOSED LOOP: startup import STAGES a skill →
 * `/skills review` surface LISTS it → approve → the EXISTING CAS `promote`
 * writes the live SKILL.md (hash-verified) → deny / wrong-hash → REFUSED.
 *
 * This closes the dead seam the sibling `rfc03-import-stage-failsafe-boundary`
 * audit documented: previously `runConfigMigrationImport` destructured only
 * `{ stage }`, dropping the approval machine + staging store, so the staged
 * proposal was unreachable (no consumer of the `promote-imported-skill`
 * resumeStep). Now the wire THREADS the review surface out (bound to the SAME
 * approval machine + artifact port + staging store) and this test drives it
 * end-to-end through the real front door.
 *
 * Security invariants pinned here:
 *   - NO live-dir write happens at stage time or on `list()` (inert before approve).
 *   - promote fires ONLY on an explicit `approve` — `deny` drops (no write).
 *   - the promote is hash-verified: a tampered staged artifact ⇒ REFUSED (the
 *     red-on-injection rail — drop the hash re-verify in promote.ts and the
 *     tampered write flips refuse→write).
 *   - the approval is bound by artifact HASH, never by a tool-name string.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { runConfigMigrationImport } from "@/apps/cli/config-migration-notice"
import {
  buildImportSkillReview,
  composeImportSkillStage,
  importSkillsDir,
} from "@/apps/cli/config-migration-skill-stage"
import { __resetRuntimeConfig } from "@/shared"
import type { StagingStore } from "@/skill"
import { sha256Hex } from "@/storage"

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
  home = await mkdtemp(join(tmpdir(), "rfc034-review-home-"))
  project = await mkdtemp(join(tmpdir(), "rfc034-review-proj-"))
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

describe("front door — runConfigMigrationImport threads a review surface out", () => {
  test("stage → review lists PENDING → approve → live SKILL.md written; live dir empty until approve", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)

    // Drive the REAL startup import; the wire returns the review surface bound
    // to the SAME approval machine + artifact port the stage populated (3rd arg
    // homeDir so the wire stages into the dir we inspect — os.homedir() ignores
    // process.env.HOME under Bun).
    const { notice, review } = await runConfigMigrationImport(project, process.env, home)
    expect(notice ?? "").toContain("skills")
    expect(review).toBeDefined()

    // The review surface LISTS the staged proposal as PENDING.
    const pending = review?.list() ?? []
    expect(pending.length).toBe(1)
    expect(pending[0]?.name).toBe("imported-helper")
    expect(pending[0]?.targetPath).toBe("imported-helper/SKILL.md")
    // Bound by content HASH (not a tool-name string).
    expect(pending[0]?.artifactHash).toMatch(/^[0-9a-f]{64}$/)

    // NO live write before approve.
    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    await expect(stat(livePath)).rejects.toBeDefined()

    // Approve → the EXISTING CAS promote writes the live SKILL.md verbatim.
    const id = pending[0]?.id ?? ""
    const res = await review?.approve(id)
    expect(res?.ok).toBe(true)
    const written = await readFile(livePath, "utf8")
    // The live bytes are EXACTLY the imported (normalized) SKILL.md, hash-matched.
    expect(sha256Hex(written)).toBe(pending[0]?.artifactHash)
    // The converter force-stamps `stability: experimental` — the promoted live
    // file carries it (an imported skill lands experimental, never `stable`).
    expect(written).toContain("stability: experimental")

    // Idempotent list: the approved proposal is no longer pending.
    expect(review?.list().length).toBe(0)
  })

  test("deny → drops (no live write, ever)", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)
    const { review } = await runConfigMigrationImport(project, process.env, home)
    const pending = review?.list() ?? []
    expect(pending.length).toBe(1)
    const id = pending[0]?.id ?? ""

    const res = review?.deny(id)
    expect(res?.ok).toBe(true)

    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    await expect(stat(livePath)).rejects.toBeDefined()
    // A subsequent approve on a denied proposal must NOT promote (fail-closed).
    const late = await review?.approve(id)
    expect(late?.ok).toBe(false)
    await expect(stat(livePath)).rejects.toBeDefined()
    expect(review?.list().length).toBe(0)
  })
})

describe("composer — buildImportSkillReview promotes hash-verified, fail-closed", () => {
  test("wrong-hash / tampered staged artifact ⇒ REFUSED, no live write (red-on-injection rail)", async () => {
    const liveSkillsDir = join(home, ".quanta", "skills")
    await mkdir(liveSkillsDir, { recursive: true })
    const staging: StagingStore = new Map()
    const { stage, review } = composeImportSkillStage(liveSkillsDir, staging)

    const bytes = "hello staged skill body"
    const artifactHash = sha256Hex(bytes)
    await stage.stage({
      artifactHash,
      bytes,
      name: "s1",
      targetPath: "s1/SKILL.md",
      kind: "new",
    })

    // TAMPER the staging store: overwrite the value under the approved key with
    // DIFFERENT bytes (the key no longer content-addresses its value). The CAS
    // promote MUST re-verify sha256(staged) === hash and refuse.
    staging.set(artifactHash, "TAMPERED BYTES — not the approved artifact")

    const id = review.list()[0]?.id ?? ""
    const res = await review.approve(id)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("hash_mismatch")
    // No live write happened despite the approve (fail-closed).
    await expect(stat(join(liveSkillsDir, "s1", "SKILL.md"))).rejects.toBeDefined()
  })

  test("SECURITY — a foreign (non-import) approval in the SAME machine is never listed nor approvable", async () => {
    // The review must promote ONLY staged-skill proposals (resumeStep guard) — a
    // co-resident permission/escalation approval must NEVER be promotable through
    // this surface (no tool-name-string / arbitrary-approval promotion).
    const liveSkillsDir = join(home, ".quanta", "skills")
    await mkdir(liveSkillsDir, { recursive: true })
    const staging: StagingStore = new Map()
    const approval = createApprovalStateMachine()
    // Make the resumeStep guard the ONLY thing standing between this foreign
    // approval and a live write: stage REAL bytes under its exact hash (so the
    // promote's own `unknown_artifact` backstop would PASS), and point the target
    // at a valid `<name>/SKILL.md`. Without the resumeStep guard, approving this
    // would promote — the guard is load-bearing, not defense-in-depth only.
    const evilBytes = "malicious skill body"
    const evilHash = sha256Hex(evilBytes)
    staging.set(evilHash, evilBytes)
    const foreign = approval.request({
      threadId: "t",
      kind: "permission",
      reason: "some unrelated gate",
      proposedAction: "write evil/SKILL.md",
      resumeStep: "some-other-step",
      artifactHash: evilHash,
    })
    const review = buildImportSkillReview(approval, liveSkillsDir, staging)
    expect(review.list().length).toBe(0)
    const res = await review.approve(foreign.id)
    expect(res.ok).toBe(false)
    await expect(stat(join(liveSkillsDir, "evil", "SKILL.md"))).rejects.toBeDefined()
  })

  test("buildImportSkillReview binds by hash and never writes on list()", async () => {
    const liveSkillsDir = join(home, ".quanta", "skills")
    await mkdir(liveSkillsDir, { recursive: true })
    const staging: StagingStore = new Map()
    const { stage, approval } = composeImportSkillStage(liveSkillsDir, staging)
    // A review built standalone over the SAME machine + staging store lists the
    // pending proposal without any live write.
    await stage.stage({
      artifactHash: sha256Hex("b"),
      bytes: "b",
      name: "s2",
      targetPath: "s2/SKILL.md",
      kind: "new",
    })
    const review = buildImportSkillReview(approval, liveSkillsDir, staging)
    expect(review.list().length).toBe(1)
    await expect(stat(join(liveSkillsDir, "s2", "SKILL.md"))).rejects.toBeDefined()
  })
})
