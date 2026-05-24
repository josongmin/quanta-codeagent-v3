/**
 * ADR-0134 Phase D — pre-0134 ~/.claude/skills → ~/.quanta/skills migration.
 *
 * Coverage:
 *  1. Source absent ⇒ migrated:0 / no warnings / no entries
 *  2. dry-run mode (default) — entries marked "would-migrate", no fs writes
 *  3. --apply mode — entries marked "migrated", content copied byte-identical
 *  4. Conflict (target tree already exists) ⇒ "skipped-conflict" + warning
 *  5. Source dir without SKILL.md ⇒ "skipped-empty" + warning
 *  6. Multiple skills migrated, sorted alphabetically
 *  7. Flat .md files are NOT migrated (out of scope by design)
 *  8. Real filesystem round-trip (small fixture) — dry-run then apply
 *  9. apply=true preserves SKILL.md frontmatter byte-for-byte
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MigrationFs, migrateClaudeSkillsToQuanta } from "@/skill"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-migration-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

interface InMemoryFs extends MigrationFs {
  readonly written: Map<string, string>
}

interface FsState {
  files: Map<string, string>
  dirs: Set<string>
  written: Map<string, string>
}

const trackParents = (path: string, dirs: Set<string>): void => {
  let p = path
  while (p.lastIndexOf("/") > 0) {
    p = p.slice(0, p.lastIndexOf("/"))
    dirs.add(p)
  }
}

const initState = (initial: Record<string, string | { dir: true } | undefined>): FsState => {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  for (const [path, val] of Object.entries(initial)) {
    if (val === undefined) continue
    if (typeof val === "object" && "dir" in val) {
      dirs.add(path)
    } else {
      files.set(path, val)
      trackParents(path, dirs)
    }
  }
  return { files, dirs, written: new Map<string, string>() }
}

/** Resolve one child of `p` from a tracked path. Returns "" when the path
 *  IS p (caller should treat as "p exists, no new child") or when the
 *  tracked path doesn't sit under p. */
const childOf = (p: string, tracked: string, prefix: string): string => {
  if (tracked === p || !tracked.startsWith(prefix)) return ""
  const tail = tracked.slice(prefix.length)
  return tail.includes("/") ? tail.slice(0, tail.indexOf("/")) : tail
}

const memoryFs = (initial: Record<string, string | { dir: true } | undefined>): InMemoryFs => {
  const { files, dirs, written } = initState(initial)
  const fs: InMemoryFs = {
    written,
    readDir: async (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`
      const all = [...dirs, ...files.keys(), ...written.keys()]
      const anyHit = all.some((path) => path === p || path.startsWith(prefix))
      if (!anyHit && !dirs.has(p)) return null
      const children = new Set<string>()
      for (const path of all) {
        const child = childOf(p, path, prefix)
        if (child !== "") children.add(child)
      }
      return [...children].sort()
    },
    isDirectory: async (p) => dirs.has(p),
    exists: async (p) => files.has(p) || dirs.has(p) || written.has(p),
    readFile: async (p) => {
      const v = files.get(p) ?? written.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeFile: async (p, c) => {
      written.set(p, c)
      trackParents(p, dirs)
    },
    mkdirp: async (p) => {
      dirs.add(p)
      trackParents(p, dirs)
    },
  }
  return fs
}

describe("migrateClaudeSkillsToQuanta — no-op cases", () => {
  test("source absent ⇒ migrated:0 / no warnings / no entries", async () => {
    const fs = memoryFs({})
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs })
    expect(r).toEqual({ migrated: 0, warnings: [], entries: [] })
    expect(fs.written.size).toBe(0)
  })

  test("source dir exists but empty ⇒ migrated:0", async () => {
    const fs = memoryFs({ "/home/u/.claude/skills": { dir: true } })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs })
    expect(r.migrated).toBe(0)
    expect(r.entries).toEqual([])
  })
})

describe("migrateClaudeSkillsToQuanta — dry-run", () => {
  test("default mode is dry-run (no writes)", async () => {
    const fs = memoryFs({
      "/home/u/.claude/skills/foo": { dir: true },
      "/home/u/.claude/skills/foo/SKILL.md": "---\nname: foo\n---\nbody",
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs })
    expect(r.migrated).toBe(1)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]?.outcome).toBe("would-migrate")
    expect(fs.written.size).toBe(0) // dry-run ⇒ no writes
  })

  test("dry-run reports source + target paths verbatim", async () => {
    const fs = memoryFs({
      "/home/u/.claude/skills/foo": { dir: true },
      "/home/u/.claude/skills/foo/SKILL.md": "---\nname: foo\n---\nbody",
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs })
    expect(r.entries[0]).toEqual({
      name: "foo",
      from: "/home/u/.claude/skills/foo/SKILL.md",
      to: "/home/u/.quanta/skills/foo/SKILL.md",
      outcome: "would-migrate",
    })
  })
})

describe("migrateClaudeSkillsToQuanta — apply", () => {
  test("apply=true copies content byte-identical", async () => {
    const body = "---\nname: bar\ndescription: d\nuserInvocable: true\n---\nhello world"
    const fs = memoryFs({
      "/home/u/.claude/skills/bar": { dir: true },
      "/home/u/.claude/skills/bar/SKILL.md": body,
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs, apply: true })
    expect(r.migrated).toBe(1)
    expect(r.entries[0]?.outcome).toBe("migrated")
    expect(fs.written.get("/home/u/.quanta/skills/bar/SKILL.md")).toBe(body)
  })

  test("multiple skills migrated, alphabetically sorted", async () => {
    const fs = memoryFs({
      "/home/u/.claude/skills/zeta": { dir: true },
      "/home/u/.claude/skills/zeta/SKILL.md": "z",
      "/home/u/.claude/skills/alpha": { dir: true },
      "/home/u/.claude/skills/alpha/SKILL.md": "a",
      "/home/u/.claude/skills/mid": { dir: true },
      "/home/u/.claude/skills/mid/SKILL.md": "m",
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs, apply: true })
    expect(r.migrated).toBe(3)
    expect(r.entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"])
  })

  test("target already exists ⇒ skipped-conflict + warning, no overwrite", async () => {
    const fs = memoryFs({
      "/home/u/.claude/skills/clash": { dir: true },
      "/home/u/.claude/skills/clash/SKILL.md": "old",
      "/home/u/.quanta/skills/clash": { dir: true },
      "/home/u/.quanta/skills/clash/SKILL.md": "new-from-elsewhere",
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs, apply: true })
    expect(r.entries[0]?.outcome).toBe("skipped-conflict")
    expect(r.warnings[0]).toContain("clash")
    expect(r.warnings[0]).toContain("already exists")
    expect(fs.written.size).toBe(0) // no overwrite
  })

  test("source dir without SKILL.md ⇒ skipped-empty + warning", async () => {
    const fs = memoryFs({
      "/home/u/.claude/skills/empty": { dir: true },
    })
    const r = await migrateClaudeSkillsToQuanta({ homeDir: "/home/u", fs, apply: true })
    expect(r.entries[0]?.outcome).toBe("skipped-empty")
    expect(r.warnings[0]).toContain("no SKILL.md")
  })
})

describe("migrateClaudeSkillsToQuanta — real fs round-trip", () => {
  test("apply preserves SKILL.md byte-for-byte on real disk", async () => {
    const home = join(root, "real-fs-home")
    const src = join(home, ".claude", "skills", "test-skill")
    await mkdir(src, { recursive: true })
    const body = [
      "---",
      "name: test-skill",
      "description: round-trip test",
      "userInvocable: false",
      "allowedTools: [Read]",
      "category: skill",
      "stability: stable",
      "---",
      "Test body.",
      "",
      "Second paragraph.",
    ].join("\n")
    await writeFile(join(src, "SKILL.md"), body)
    const dry = await migrateClaudeSkillsToQuanta({ homeDir: home })
    expect(dry.migrated).toBe(1)
    expect(dry.entries[0]?.outcome).toBe("would-migrate")
    const applied = await migrateClaudeSkillsToQuanta({ homeDir: home, apply: true })
    expect(applied.migrated).toBe(1)
    const target = join(home, ".quanta", "skills", "test-skill", "SKILL.md")
    const copied = await readFile(target, "utf8")
    expect(copied).toBe(body)
  })
})
