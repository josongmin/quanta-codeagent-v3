import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverSkills } from "@/skill"
import { MAX_SKILL_SIZE_BYTES } from "@/skill/skill-size"

const tmpDirs: string[] = []
const tmpDir = async (prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of tmpDirs) {
    try {
      await rm(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

const writeSkill = async (dir: string, name: string, body: string): Promise<string> => {
  const sd = join(dir, name)
  await mkdir(sd, { recursive: true })
  const file = join(sd, "SKILL.md")
  await writeFile(file, body)
  return file
}

const writeFlat = async (dir: string, name: string, body: string): Promise<string> => {
  const file = join(dir, `${name}.md`)
  await writeFile(file, body)
  return file
}

// Capture console.warn output so we can assert structured skip logging
// without polluting CI output. Restored after each test.
let warnSpy: string[] = []
let originalWarn: typeof console.warn
beforeEach(() => {
  warnSpy = []
  originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnSpy.push(args.map((a) => String(a)).join(" "))
  }
})
afterEach(() => {
  console.warn = originalWarn
})

describe("discoverSkills — 30MB size cap", () => {
  test("small skill (under 30MB) is discovered as before", async () => {
    const d = await tmpDir("size-cap-small-")
    await writeSkill(d, "tiny", "---\nname: tiny\ndescription: t\n---\nbody\n")
    const skills = await discoverSkills(d)
    expect(skills.map((s) => s.name)).toEqual(["tiny"])
  })

  test("oversized skill (MAX+1 bytes, nested SKILL.md) is NOT discovered", async () => {
    const d = await tmpDir("size-cap-over-nested-")
    const file = await writeSkill(d, "huge", "---\nname: huge\ndescription: x\n---\nbody\n")
    await truncate(file, MAX_SKILL_SIZE_BYTES + 1)
    const skills = await discoverSkills(d)
    expect(skills.map((s) => s.name)).toEqual([])
    expect(warnSpy.some((l) => l.includes("[skill] skipped") && l.includes("huge"))).toBe(true)
  })

  test("oversized skill (MAX+1 bytes, flat *.md) is NOT discovered", async () => {
    const d = await tmpDir("size-cap-over-flat-")
    const file = await writeFlat(d, "bigflat", "---\nname: bigflat\ndescription: x\n---\nb\n")
    await truncate(file, MAX_SKILL_SIZE_BYTES + 1)
    const skills = await discoverSkills(d)
    expect(skills.map((s) => s.name)).toEqual([])
    expect(warnSpy.some((l) => l.includes("[skill] skipped") && l.includes("bigflat"))).toBe(true)
  })

  test("stat-error (unreadable flat file) is NOT in result", async () => {
    // chmod 000 on a flat file makes stat fail on some platforms; if it doesn't
    // (root, certain FS), the test simply asserts the file is absent or the
    // dirent path produced the right warn. Always tolerated.
    const d = await tmpDir("size-cap-staterr-")
    const file = await writeFlat(d, "perm", "---\nname: perm\ndescription: p\n---\nb\n")
    try {
      await chmod(file, 0o000)
    } catch {
      return // platform refused chmod — skip silently
    }
    try {
      const skills = await discoverSkills(d)
      // Either stat or readFile will fail; in both cases "perm" must not appear.
      expect(skills.some((s) => s.name === "perm")).toBe(false)
    } finally {
      try {
        await chmod(file, 0o644)
      } catch {
        // best-effort restore
      }
    }
  })

  test("mixed dir: 2 small + 1 oversized ⇒ result has 2 small only", async () => {
    const d = await tmpDir("size-cap-mixed-")
    await writeSkill(d, "alpha", "---\nname: alpha\ndescription: a\n---\nbody\n")
    await writeSkill(d, "beta", "---\nname: beta\ndescription: b\n---\nbody\n")
    const bigFile = await writeSkill(d, "gigant", "---\nname: gigant\ndescription: g\n---\nb\n")
    await truncate(bigFile, MAX_SKILL_SIZE_BYTES + 1)
    const skills = await discoverSkills(d)
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"])
    expect(warnSpy.some((l) => l.includes("gigant"))).toBe(true)
  })

  test("warn message includes byte count and cap reference", async () => {
    const d = await tmpDir("size-cap-warnfmt-")
    const file = await writeFlat(d, "loud", "---\nname: loud\ndescription: l\n---\nb\n")
    await truncate(file, MAX_SKILL_SIZE_BYTES + 5)
    await discoverSkills(d)
    const line = warnSpy.find((l) => l.includes("loud"))
    expect(line).toBeDefined()
    expect(line ?? "").toContain(String(MAX_SKILL_SIZE_BYTES + 5))
    expect(line ?? "").toContain(String(MAX_SKILL_SIZE_BYTES))
  })
})
