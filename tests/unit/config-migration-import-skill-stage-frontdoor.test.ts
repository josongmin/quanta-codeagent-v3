/**
 * FRONT-DOOR PROOF — RFC03-4 startup skill IMPORT actually STAGES.
 *
 * The gap this pins: the CLI STARTUP import flow `runConfigMigrationImport`
 * (config-migration-notice.ts) previously called `importExternalConfig` WITHOUT
 * a `skillStage` port, so at real startup an imported `.claude/skills/*​/SKILL.md`
 * was fail-closed (silently dropped — nothing written anywhere). This drives the
 * REAL composition-root entry (`runConfigMigrationImport`, exactly as the REPL
 * calls it) over a real `$HOME`/project on disk and proves an imported skill is
 * STAGED into the CAS store + an approval opened — never live-written.
 *
 * It also proves the composer in isolation (`composeImportSkillStage`) stages via
 * the REAL artifact port + approval machine and that the staged bytes CAS-promote
 * only on approve — the load-bearing "staged not dropped, promoted only on
 * approve" contract, end-to-end through the front door.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalRequest } from "@/agent/approval-state-machine"
import { runConfigMigrationImport } from "@/apps/cli/config-migration-notice"
import { composeImportSkillStage, importSkillsDir } from "@/apps/cli/config-migration-skill-stage"
import { __resetRuntimeConfig } from "@/shared"
import {
  createSkillProposalArtifactPort,
  discoverSystemSkills,
  type PromoteStorageIo,
  type StagingStore,
} from "@/skill"
import {
  FsJailError,
  resolveJailed,
  sha256Hex,
  readFile as storageReadFile,
  writeFileAtomic,
} from "@/storage"

let home: string
let project: string
let prevHome: string | undefined
let prevMigrate: string | undefined
let prevImport: string | undefined

const write = async (p: string, c: string): Promise<void> => {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(p, c, "utf8")
}

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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rfc034-import-home-"))
  project = await mkdtemp(join(tmpdir(), "rfc034-import-proj-"))
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

describe("front door — runConfigMigrationImport STAGES an imported skill (not dropped)", () => {
  test("a project .claude/skills/*/SKILL.md rides the import → reported staged, live dir stays empty", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)

    // Drive the REAL startup import entry (both gates on, HOME → temp home).
    const { notice } = await runConfigMigrationImport(project)

    // The import ran and persisted (STAGED) — the summary mentions the skills
    // item. RED-ON-INJECTION: with the `skillStage` wire removed the skill fails
    // closed (persistSkills returns wrote:false), so `skills` never appears in
    // the summary (and with skills the only item, the notice is undefined).
    expect(notice).toBeDefined()
    expect(notice ?? "").toContain("skills")

    // STAGED, not live-written: the import NEVER promotes into the live skills
    // dir — promotion happens only on a later operator approve.
    const livePath = join(importSkillsDir(home), "imported-helper", "SKILL.md")
    await expect(stat(livePath)).rejects.toBeDefined()
  })

  test("RED baseline — WITHOUT a stage port the same import reports NO skills (fail-closed)", async () => {
    // This pins the pre-wire behavior the front door repairs: calling the slice
    // entry with NO skillStage leaves the imported skill unwritten, so `skills`
    // is absent from the persisted set. (Drives the slice directly with the same
    // fixture; the `runConfigMigrationImport` wire is what supplies the port.)
    const { importExternalConfig } = await import("@/migration/external-config")
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), SKILL)
    const res = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
    const okTypes = new Set(res.converted.filter((c) => c.ok).map((c) => c.type))
    // The skill converted OK but persisted NOTHING (no stage port) — so no live
    // write and it is NOT in the persisted skills set.
    expect(res.persisted).toBe(false)
    await expect(
      stat(join(importSkillsDir(home), "imported-helper", "SKILL.md")),
    ).rejects.toBeDefined()
    // convert succeeded (the skill was detected+converted) but staging is the gap.
    expect(okTypes.has("skills")).toBe(true)
  })
})

describe("composer — composeImportSkillStage stages via real artifact port + approval", () => {
  test("stage() puts bytes + opens an approval bound to the hash; promote only on approve", async () => {
    const liveSkillsDir = join(home, ".quanta", "skills")
    await mkdir(liveSkillsDir, { recursive: true })
    // Shared staging store so a sibling artifact port can promote the SAME bytes.
    const staging: StagingStore = new Map()
    const { stage, approval } = composeImportSkillStage(liveSkillsDir, staging)

    const bytes = "hello staged skill"
    const artifactHash = sha256Hex(bytes)
    const { proposalId } = await stage.stage({
      artifactHash,
      bytes,
      name: "s1",
      targetPath: "s1/SKILL.md",
      kind: "new",
    })
    // proposalId is deterministic content hash (mirrors the front-door contract).
    expect(proposalId).toBe(sha256Hex(bytes))

    // approval opened, bound to the EXACT staged artifact hash, still pending.
    const req = approval.pending().find((r: ApprovalRequest) => r.artifactHash === artifactHash)
    expect(req).toBeDefined()
    expect(req?.decision).toBeUndefined()

    // NO live write happened at stage time.
    await expect(stat(join(liveSkillsDir, "s1", "SKILL.md"))).rejects.toBeDefined()

    // On approve, the CAS promote writes the exact staged bytes into the jail.
    approval.settle(req?.id ?? "", "approve")
    const HOST_IO: PromoteStorageIo = {
      sha256: (c) => sha256Hex(c),
      resolveJailed: (rel, root) => resolveJailed(rel, root),
      writeFileAtomic: (abs, c) => writeFileAtomic(abs, c),
      readFile: (abs) => storageReadFile(abs),
      isJailError: (e) => e instanceof FsJailError,
      errMessage: () => "",
    }
    const artifact = createSkillProposalArtifactPort(liveSkillsDir, HOST_IO, staging)
    const promoted = await artifact.promote({
      hash: artifactHash,
      targetPath: "s1/SKILL.md",
      expectedPreimageHash: "absent",
    })
    expect(promoted.ok).toBe(true)
    expect(await readFile(join(liveSkillsDir, "s1", "SKILL.md"), "utf8")).toBe(bytes)
  })

  test("system-skill names are discoverable for shadow-refusal (non-empty bundled set)", async () => {
    // The wire passes a REAL system-skill name set so an imported skill that would
    // shadow a system skill is refused at convert time. Prove the set is populated
    // (a vacuous empty set would silence the shadow guard).
    const names = new Set((await discoverSystemSkills()).map((s) => s.name))
    expect(names.size).toBeGreaterThan(0)
  })
})
