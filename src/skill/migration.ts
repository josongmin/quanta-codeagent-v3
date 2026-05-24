/**
 * ADR-0134 Phase D — Migration helper for pre-0134 `~/.claude/skills/` to
 * the canonical `~/.quanta/skills/` location.
 *
 * Two modes:
 *  - dry-run (default): scan + report what WOULD migrate; no fs writes
 *  - apply: copy each SKILL.md tree under the new location, leaving the old
 *    in place (non-destructive — the legacy registry fallback in
 *    {@link buildSkillRegistry} continues to surface it too, but is shadowed
 *    by the new canonical bucket per precedence)
 *
 * Closed-port: every fs operation goes through {@link MigrationFs} so unit
 * tests assert behaviour without touching the real disk. The default
 * adapter {@link nodeMigrationFs} is a one-shot wrapper over
 * node:fs/promises.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface MigrationFs {
  /** List directory entries (names only) or return null on ENOENT. */
  readDir(path: string): Promise<readonly string[] | null>
  /** True iff the path exists and is a directory. */
  isDirectory(path: string): Promise<boolean>
  /** True iff the path exists (any type). */
  exists(path: string): Promise<boolean>
  /** Read file as utf8 string. */
  readFile(path: string): Promise<string>
  /** Write file (creates parents). */
  writeFile(path: string, content: string): Promise<void>
  /** Ensure directory exists (mkdir -p). */
  mkdirp(path: string): Promise<void>
}

export const nodeMigrationFs: MigrationFs = {
  readDir: async (p) => {
    try {
      return await readdir(p)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory()
    } catch {
      return false
    }
  },
  exists: async (p) => {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  },
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, c) => {
    await mkdir(join(p, "..").replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {})
    await writeFile(p, c, "utf8")
  },
  mkdirp: async (p) => {
    await mkdir(p, { recursive: true })
  },
}

export interface MigrationReport {
  /** Number of SKILL.md files that would migrate (dry-run) or did (apply). */
  readonly migrated: number
  /** Conflict / skip warnings — surfaced verbatim so CLI can render. */
  readonly warnings: readonly string[]
  /** When apply=false this is what WOULD migrate; when apply=true it's the
   *  set that was just written. */
  readonly entries: readonly MigrationEntry[]
}

export interface MigrationEntry {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly outcome: "would-migrate" | "migrated" | "skipped-conflict" | "skipped-empty"
}

export interface MigrationOptions {
  /** User home dir — source is `<homeDir>/.claude/skills/`, target is `<homeDir>/.quanta/skills/`. */
  readonly homeDir: string
  /** When true, actually perform the copy. Default false (dry-run). */
  readonly apply?: boolean
  /** Test seam — defaults to {@link nodeMigrationFs}. */
  readonly fs?: MigrationFs
}

/**
 * Scan `<homeDir>/.claude/skills/` for SKILL.md trees and migrate them to
 * `<homeDir>/.quanta/skills/`. Idempotent: if the target tree already exists
 * the entry is skipped with a conflict warning (the legacy fallback in
 * {@link buildSkillRegistry} continues to surface the source — no
 * silent overwrite).
 *
 * The function operates on entries one level deep (each SKILL.md must live
 * in its own subdirectory, mirroring the {@link discoverSkills} contract).
 * Flat `<dir>/<name>.md` files are NOT migrated by design — those are the
 * legacy command form and not the SKILL.md convention.
 */
export const migrateClaudeSkillsToQuanta = async (
  opts: MigrationOptions,
): Promise<MigrationReport> => {
  const fs = opts.fs ?? nodeMigrationFs
  const apply = opts.apply ?? false
  const src = join(opts.homeDir, ".claude", "skills")
  const dst = join(opts.homeDir, ".quanta", "skills")
  const entries: MigrationEntry[] = []
  const warnings: string[] = []

  const srcEntries = await fs.readDir(src)
  if (srcEntries === null) {
    // No legacy location ⇒ nothing to do (the common case for fresh installs).
    return { migrated: 0, warnings: [], entries: [] }
  }
  const names = [...srcEntries].sort()
  let migrated = 0
  for (const name of names) {
    const fromDir = join(src, name)
    const toDir = join(dst, name)
    const fromFile = join(fromDir, "SKILL.md")
    const isDir = await fs.isDirectory(fromDir)
    if (!isDir) {
      // Flat .md files are not migrated (out of scope) — skip silently.
      continue
    }
    const hasSkill = await fs.exists(fromFile)
    if (!hasSkill) {
      entries.push({ name, from: fromFile, to: join(toDir, "SKILL.md"), outcome: "skipped-empty" })
      warnings.push(`${name}: no SKILL.md under legacy dir`)
      continue
    }
    if (await fs.exists(toDir)) {
      entries.push({
        name,
        from: fromFile,
        to: join(toDir, "SKILL.md"),
        outcome: "skipped-conflict",
      })
      warnings.push(`${name}: target ${toDir} already exists — left in place`)
      continue
    }
    if (!apply) {
      entries.push({
        name,
        from: fromFile,
        to: join(toDir, "SKILL.md"),
        outcome: "would-migrate",
      })
      migrated++
      continue
    }
    const body = await fs.readFile(fromFile)
    await fs.mkdirp(toDir)
    await fs.writeFile(join(toDir, "SKILL.md"), body)
    entries.push({ name, from: fromFile, to: join(toDir, "SKILL.md"), outcome: "migrated" })
    migrated++
  }
  return { migrated, warnings, entries }
}
