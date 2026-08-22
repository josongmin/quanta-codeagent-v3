/**
 * HELLGATE — RFC03-4 SKILLS + MEMORY external-config converters.
 *
 * Two NEW import item types close the Codex `external_agent_memory_import`
 * coverage gap (skills, memory). The load-bearing safety contracts:
 *
 *   - convertSkills: an imported `.claude/skills/*​/SKILL.md` is validated
 *     through the SAME discovery schema, then routed through the RFC03-2/3
 *     STAGING/PROMOTE contract (`SkillProposalArtifactPort` + approval) — it is
 *     NEVER written straight into the live skills directory. A system-name
 *     collision is REFUSED (system cannot be shadowed).
 *   - convertMemory: an imported `~/.claude/CLAUDE.md` (memory form) is
 *     APPENDED to the existing `raw_memories.md` evidence trail — never written
 *     to MEMORY.md, and never CLOBBERING an existing raw_memories.md.
 *   - Detect: a `.claude/skills` dir probe + a `~/.claude/CLAUDE.md` MEMORY
 *     probe that is source-path-disambiguated from the `agents_md` probe so the
 *     SAME file is never double-imported as both rules and memory.
 *
 * These tests are RED before the converters exist (the item types are not in
 * MigrationItemType, the converters/persist paths are absent).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ALL_MIGRATION_ITEM_TYPES,
  type ConvertedItem,
  convertMemory,
  convertSkills,
  detectExternalConfigs,
  type MigrationItemType,
  persistConvertedItems,
  type SkillStagePort,
} from "@/migration/external-config"

let home: string
let project: string

const write = async (p: string, c: string): Promise<void> => {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(p, c, "utf8")
}

const VALID_SKILL = `---
name: imported-helper
description: an imported helper skill
userInvocable: true
allowedTools: []
category: skill
stability: experimental
---
Do the imported thing.
`

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rfc034-home-"))
  project = await mkdtemp(join(tmpdir(), "rfc034-proj-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

// ─── union ───────────────────────────────────────────────────────────────

describe("MigrationItemType union", () => {
  test("includes skills + memory", () => {
    expect(ALL_MIGRATION_ITEM_TYPES).toContain("skills")
    expect(ALL_MIGRATION_ITEM_TYPES).toContain("memory")
  })
})

// ─── detect ────────────────────────────────────────────────────────────────

describe("detect — skills dir + memory probe", () => {
  test("`.claude/skills` dir with a SKILL.md → skills item", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), VALID_SKILL)
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const skills = inv.items.filter((i) => i.type === "skills")
    expect(skills.length).toBe(1)
    expect(skills[0]?.path).toBe(join(project, ".claude", "skills"))
  })

  test("empty `.claude/skills` dir (no SKILL.md) → NO skills item", async () => {
    await mkdir(join(project, ".claude", "skills", "empty"), { recursive: true })
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    expect(inv.items.find((i) => i.type === "skills")).toBeUndefined()
  })

  test("home `~/.claude/CLAUDE.md` → MEMORY, NOT agents_md (source-path disambiguation)", async () => {
    await write(join(home, ".claude", "CLAUDE.md"), "# my global memory\nremember X")
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const memProbe = inv.items.find((i) => i.path === join(home, ".claude", "CLAUDE.md"))
    // The SAME file must NOT be imported as BOTH memory and agents_md.
    expect(memProbe?.type).toBe("memory")
    const dup = inv.items.filter((i) => i.path === join(home, ".claude", "CLAUDE.md"))
    expect(dup.length).toBe(1)
  })

  test("project CLAUDE.md stays agents_md (rules), NOT memory", async () => {
    await write(join(project, "CLAUDE.md"), "# project rules\nfail closed")
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const it = inv.items.find((i) => i.path === join(project, "CLAUDE.md"))
    expect(it?.type).toBe("agents_md")
  })
})

// ─── convertSkills ──────────────────────────────────────────────────────────

describe("convertSkills", () => {
  test("valid imported SKILL.md → ok skill item (experimental, provenance)", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), VALID_SKILL)
    const r = await convertSkills(join(project, ".claude", "skills"), {
      systemSkillNames: new Set<string>(),
    })
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "skills") return
    expect(r.value.length).toBe(1)
    const s = r.value[0]
    expect(s?.name).toBe("imported-helper")
    expect(s?.stability).toBe("experimental")
    expect(s?.sourcePath).toBe(join(project, ".claude", "skills", "imported-helper", "SKILL.md"))
    // The rendered SKILL.md bytes carry the frontmatter (used for staging).
    expect(s?.skillMd).toContain("name: imported-helper")
  })

  test("REFUSES a system-name collision (system cannot be shadowed)", async () => {
    const skill = VALID_SKILL.replace("imported-helper", "onboard")
    await write(join(project, ".claude", "skills", "onboard", "SKILL.md"), skill)
    const r = await convertSkills(join(project, ".claude", "skills"), {
      systemSkillNames: new Set<string>(["onboard"]),
    })
    // No usable skill survives the shadow refusal.
    expect(r.ok).toBe(false)
  })

  test("malformed SKILL.md (bad frontmatter) is skipped, not thrown", async () => {
    await write(
      join(project, ".claude", "skills", "bad", "SKILL.md"),
      "---\nname: Bad Name\n---\nbody",
    )
    const r = await convertSkills(join(project, ".claude", "skills"), {
      systemSkillNames: new Set<string>(),
    })
    expect(r.ok).toBe(false)
  })
})

// ─── convertMemory ──────────────────────────────────────────────────────────

describe("convertMemory", () => {
  test("home CLAUDE.md memory → ok memory item carrying the body", async () => {
    const p = join(home, ".claude", "CLAUDE.md")
    await write(p, "# global memory\nprefer casual tone")
    const r = await convertMemory(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "memory") return
    expect(r.value.body).toContain("prefer casual tone")
    expect(r.value.sourcePath).toBe(p)
  })

  test("empty memory file → ok:false (no phantom append)", async () => {
    const p = join(home, ".claude", "CLAUDE.md")
    await write(p, "   \n  ")
    const r = await convertMemory(p)
    expect(r.ok).toBe(false)
  })
})

// ─── persist: skills route through STAGING, memory APPENDS ──────────────────

describe("persist — skills route through staging (NOT live write)", () => {
  test("an imported skill is STAGED via the port, never written to a live skills dir", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), VALID_SKILL)
    const conv = await convertSkills(join(project, ".claude", "skills"), {
      systemSkillNames: new Set<string>(),
    })
    expect(conv.ok).toBe(true)

    const staged: Array<{ name: string; bytes: string }> = []
    const stagePort: SkillStagePort = {
      stage: async (args) => {
        staged.push({ name: args.name, bytes: args.bytes })
        return { proposalId: `pid-${args.name}` }
      },
    }

    const res = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [conv as ConvertedItem],
      skillStage: stagePort,
    })
    expect(res.persisted).toBe(true)
    expect(res.writtenTypes).toContain("skills")
    // The skill was STAGED (not live-written).
    expect(staged.length).toBe(1)
    expect(staged[0]?.name).toBe("imported-helper")
    // NO live skills directory was created under the project quanta dir.
    const quanta = await readdir(join(project, ".quanta")).catch(() => [] as string[])
    expect(quanta.includes("skills")).toBe(false)
  })

  test("with NO stage port wired, an imported skill is NOT written to disk (fail-closed)", async () => {
    await write(join(project, ".claude", "skills", "imported-helper", "SKILL.md"), VALID_SKILL)
    const conv = await convertSkills(join(project, ".claude", "skills"), {
      systemSkillNames: new Set<string>(),
    })
    const res = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [conv as ConvertedItem],
      // no skillStage
    })
    expect(res.writtenTypes).not.toContain("skills")
    const quanta = await readdir(join(project, ".quanta")).catch(() => [] as string[])
    expect(quanta.includes("skills")).toBe(false)
  })
})

describe("persist — memory APPENDS to raw_memories.md (never clobbers, never MEMORY.md)", () => {
  test("appends imported memory to raw_memories.md, preserving prior content", async () => {
    const rawPath = join(home, ".quanta", "memory", "raw_memories.md")
    await write(rawPath, "PRIOR EVIDENCE LINE\n")

    const conv: ConvertedItem = {
      type: "memory",
      ok: true,
      value: { sourcePath: join(home, ".claude", "CLAUDE.md"), body: "IMPORTED MEMORY LINE" },
    }
    const res = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [conv],
    })
    expect(res.persisted).toBe(true)
    expect(res.writtenTypes).toContain("memory")

    const after = await readFile(rawPath, "utf8")
    // APPEND — prior content preserved, imported content added.
    expect(after).toContain("PRIOR EVIDENCE LINE")
    expect(after).toContain("IMPORTED MEMORY LINE")
    expect(after.indexOf("PRIOR EVIDENCE LINE")).toBeLessThan(after.indexOf("IMPORTED MEMORY LINE"))

    // MEMORY.md is NEVER touched by an import (must pass consolidation).
    const memoryMd = await readFile(join(home, ".quanta", "memory", "MEMORY.md"), "utf8").catch(
      () => "__ABSENT__",
    )
    expect(memoryMd).toBe("__ABSENT__")
  })

  test("memory append is idempotent-safe: the SAME source is not double-appended", async () => {
    const rawPath = join(home, ".quanta", "memory", "raw_memories.md")
    const conv: ConvertedItem = {
      type: "memory",
      ok: true,
      value: { sourcePath: join(home, ".claude", "CLAUDE.md"), body: "ONCE ONLY" },
    }
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [conv],
    })
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [conv],
    })
    const after = await readFile(rawPath, "utf8")
    const occurrences = after.split("ONCE ONLY").length - 1
    expect(occurrences).toBe(1)
  })
})

// ─── gate-OFF parity ────────────────────────────────────────────────────────

describe("gate-OFF parity", () => {
  test("enabled:false ⇒ no stage call, no raw_memories write (byte-identical no-op)", async () => {
    let stageCalls = 0
    const stagePort: SkillStagePort = {
      stage: async (args) => {
        stageCalls++
        return { proposalId: args.name }
      },
    }
    const conv: ConvertedItem = {
      type: "memory",
      ok: true,
      value: { sourcePath: join(home, ".claude", "CLAUDE.md"), body: "X" },
    }
    const res = await persistConvertedItems({
      enabled: false,
      homeDir: home,
      projectDir: project,
      converted: [conv],
      skillStage: stagePort,
    })
    expect(res.persisted).toBe(false)
    expect(stageCalls).toBe(0)
    const exists = await readdir(join(home, ".quanta")).then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })
})

// keep MigrationItemType import used
const _typecheck: MigrationItemType = "skills"
void _typecheck
