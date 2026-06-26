/**
 * ADR-0068 Wave B — end-to-end integration for the Phase 2 writer +
 * real git.  Runs `git init`, `git add`, `git commit`, `git log` against
 * a real tmpdir + node:fs/promises so the writer's full happy path is
 * exercised exactly as it would be in production.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_DIR_MODE } from "@/memory/consolidate/constants"
import { ChildProcessGitPort } from "@/memory/consolidate/git"
import type { MemoryDirPaths } from "@/memory/consolidate/types"
import { MemoryWriter, type NodeFsLike } from "@/memory/consolidate/writer"

/** Bind node:fs/promises into the writer port. */
const realFs: NodeFsLike = {
  mkdir: (p, opts) => fsp.mkdir(p, opts),
  chmod: (p, mode) => fsp.chmod(p, mode),
  readFile: (p, enc) => fsp.readFile(p, enc),
  writeFile: (p, content, enc) => fsp.writeFile(p, content, enc),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (p) => fsp.unlink(p),
  access: (p) => fsp.access(p),
}

const buildPaths = (root: string): MemoryDirPaths => ({
  root,
  memoryMd: join(root, "MEMORY.md"),
  rawMemoriesMd: join(root, "raw_memories.md"),
  memorySummaryMd: join(root, "memory_summary.md"),
})

const runGitInDir = async (
  dir: string,
  argv: ReadonlyArray<string>,
): Promise<{ stdout: string; exitCode: number }> => {
  const proc = Bun.spawn(["git", ...argv], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

describe("Phase 2 writer end-to-end (real fs + git)", () => {
  let root: string
  let paths: MemoryDirPaths

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quanta-mem-e2e-"))
    paths = buildPaths(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("ensureDir creates dir with 0700, initializes git repo", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => 1_700_000_000_000,
    })
    await writer.ensureDir()
    const st = statSync(root)
    // mask to permission bits — file mode includes type bits.
    expect(st.mode & 0o777).toBe(MEMORY_DIR_MODE)
    // .git dir is created.
    const head = statSync(join(root, ".git"))
    expect(head.isDirectory()).toBe(true)
  })

  test("writeAtomic writes 3 files and commits to git", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => 1_700_000_000_000,
    })
    await writer.ensureDir()
    const res = await writer.writeAtomic({
      memoryMd: "# Memory\nfrom e2e\n",
      rawMemoriesMd: "raw e2e\n",
      memorySummaryMd: "summary e2e\n",
    })
    expect(res.gitCommitSha).not.toBeNull()
    expect(res.gitCommitSha?.length).toBeGreaterThanOrEqual(40)
    // Roundtrip content.
    expect(await fsp.readFile(paths.memoryMd, "utf8")).toBe("# Memory\nfrom e2e\n")
    expect(await fsp.readFile(paths.rawMemoriesMd, "utf8")).toBe("raw e2e\n")
    expect(await fsp.readFile(paths.memorySummaryMd, "utf8")).toBe("summary e2e\n")
    // git log shows at least one commit.
    const log = await runGitInDir(root, ["log", "--oneline"])
    expect(log.exitCode).toBe(0)
    expect(log.stdout.trim().length).toBeGreaterThan(0)
  })

  test("two consecutive runs produce two commits", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => Date.now(),
    })
    await writer.ensureDir()
    await writer.writeAtomic({
      memoryMd: "# v1\n",
      rawMemoriesMd: "raw v1\n",
      memorySummaryMd: "sum v1\n",
    })
    await writer.writeAtomic({
      memoryMd: "# v2 (changed)\n",
      rawMemoriesMd: "raw v1\nraw v2\n",
      memorySummaryMd: "sum v2\n",
    })
    const log = await runGitInDir(root, ["log", "--oneline"])
    expect(log.exitCode).toBe(0)
    expect(log.stdout.trim().split("\n").length).toBe(2)
  })

  test("second run with byte-identical content yields null sha (clean tree)", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => Date.now(),
    })
    await writer.ensureDir()
    const content = {
      memoryMd: "# stable\n",
      rawMemoriesMd: "raw stable\n",
      memorySummaryMd: "sum stable\n",
    }
    await writer.writeAtomic(content)
    const res2 = await writer.writeAtomic(content)
    expect(res2.gitCommitSha).toBeNull()
  })

  test("readExisting roundtrips content written by writeAtomic", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => Date.now(),
    })
    await writer.ensureDir()
    await writer.writeAtomic({
      memoryMd: "ROUND-MEM\n",
      rawMemoriesMd: "ROUND-RAW\n",
      memorySummaryMd: "ROUND-SUM\n",
    })
    const got = await writer.readExisting()
    expect(got.memoryMd).toBe("ROUND-MEM\n")
    expect(got.rawMemoriesMd).toBe("ROUND-RAW\n")
    expect(got.memorySummaryMd).toBe("ROUND-SUM\n")
  })

  test("readExisting returns null for files absent on disk", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => Date.now(),
    })
    await writer.ensureDir()
    const got = await writer.readExisting()
    expect(got.memoryMd).toBeNull()
    expect(got.rawMemoriesMd).toBeNull()
    expect(got.memorySummaryMd).toBeNull()
  })

  test("ensureDir is idempotent (second call on existing repo is a no-op)", async () => {
    const writer = new MemoryWriter(paths, realFs, new ChildProcessGitPort(), {
      gitEnabled: true,
      now: () => Date.now(),
    })
    await writer.ensureDir()
    // Second call must not throw.
    await writer.ensureDir()
    // .git still present.
    expect(statSync(join(root, ".git")).isDirectory()).toBe(true)
  })

  // jun-26 SE-audit HIGH#2: when ~/.quanta/memory is NESTED inside an ancestor
  // repo (the dotfiles-wrap case isRepo deliberately supports), consolidation's
  // commit MUST NOT sweep the user's unrelated pre-staged changes into our
  // fire-and-forget `consolidate` commit. The pathspec-scoped `git commit -- .`
  // confines the commit to the memory subtree.
  test("nested-in-ancestor-repo: addCommit does NOT sweep the user's unrelated staged changes", async () => {
    const outer = mkdtempSync(join(tmpdir(), "quanta-outer-repo-"))
    try {
      await runGitInDir(outer, ["init"])
      await runGitInDir(outer, ["config", "user.email", "u@example.com"])
      await runGitInDir(outer, ["config", "user.name", "User"])
      // The user's OWN unrelated work, pre-staged in the outer repo.
      await fsp.writeFile(join(outer, "user-secret.txt"), "do not commit me\n")
      await runGitInDir(outer, ["add", "user-secret.txt"])

      // Memory lives nested inside the outer repo; write a memory file there.
      const memDir = join(outer, ".quanta", "memory")
      await fsp.mkdir(memDir, { recursive: true })
      await fsp.writeFile(join(memDir, "MEMORY.md"), "# mem\n")

      // isRepo sees the ancestor repo (deliberate) → no inner init; addCommit
      // commits into the outer repo BUT only the memory pathspec.
      const git = new ChildProcessGitPort()
      expect(await git.isRepo(memDir)).toBe(true)
      const sha = await git.addCommit(memDir, "consolidate test")
      expect(sha).not.toBeNull()

      // The consolidate commit contains ONLY the memory file, NOT the user's file.
      const show = await runGitInDir(outer, ["show", "--name-only", "--format=", "HEAD"])
      expect(show.stdout).toContain(".quanta/memory/MEMORY.md")
      expect(show.stdout).not.toContain("user-secret.txt")
      // The user's file is still staged + uncommitted (untouched by us).
      const status = await runGitInDir(outer, ["status", "--porcelain"])
      expect(status.stdout).toContain("A  user-secret.txt")
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
})
