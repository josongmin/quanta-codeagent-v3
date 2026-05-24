/**
 * ADR-0135 — type catalogue + special-path resolver coverage.
 *
 * Locks the discriminated unions, the 4-tier scope precedence, and the
 * 8-kind special-path resolution across the two POSIX OS families.
 */
import { describe, expect, test } from "bun:test"
import {
  type CwdPort,
  DEFAULT_FILE_SYSTEM_SANDBOX_POLICY,
  DEFAULT_PERMISSION_PROFILE,
  type FileSystemEntry,
  type FileSystemPath,
  type FileSystemSandboxPolicy,
  type GitPort,
  isPermissionScope,
  isSpecialPathKind,
  type OsFamily,
  type OsPort,
  PERMISSION_SCOPE_PRECEDENCE_DESC,
  type PermissionProfile,
  type PermissionScope,
  resolveSpecialPath,
  SPECIAL_PATH_KINDS,
  strongerScope,
} from "@/permission"

/* ---------------- helper builders ---------------- */

const mkOs = (family: OsFamily, tmp: string): OsPort => ({
  family: () => family,
  tmpdir: () => tmp,
})

const mkCwd = (cwd: string, project: string): CwdPort => ({
  cwd: () => cwd,
  projectRoot: () => project,
})

const mkGit = (dir: string | undefined): GitPort => ({
  gitDir: () => dir,
})

/* ---------------- type-union shape ---------------- */

describe("ADR-0135 — type catalogue", () => {
  test("FileSystemPath discriminant accepts both variants", () => {
    const special: FileSystemPath = { type: "special", kind: "project" }
    const literal: FileSystemPath = { type: "path", value: "/repo/x.ts" }
    // Switch is exhaustive — compile-time check that the union has exactly
    // two members.
    const tag = (p: FileSystemPath): string => (p.type === "special" ? p.kind : p.value)
    expect(tag(special)).toBe("project")
    expect(tag(literal)).toBe("/repo/x.ts")
  })

  test("FileSystemEntry composes path + access mode", () => {
    const e: FileSystemEntry = { path: { type: "path", value: "/repo" }, access: "write" }
    expect(e.access).toBe("write")
  })

  test("PermissionProfile aggregates the 4 pillars + fileSystem layer", () => {
    const p: PermissionProfile = DEFAULT_PERMISSION_PROFILE
    // All 4 pillars are present.
    expect(p.approval.mode).toBe("once")
    expect(p.network.mode).toBe("deny-all")
    expect(p.sandbox.osSandbox).toBe("none")
    expect(p.control.auditRequired).toBe(false)
    // File-system table is restricted + empty (deny-by-default).
    expect(p.fileSystem.type).toBe("restricted")
    expect(p.fileSystem.entries).toEqual([])
  })

  test("FileSystemSandboxPolicy shares the same shape as fileSystem table", () => {
    const s: FileSystemSandboxPolicy = DEFAULT_FILE_SYSTEM_SANDBOX_POLICY
    expect(s.type).toBe("restricted")
    expect(s.entries).toEqual([])
  })
})

/* ---------------- 4-tier scope ---------------- */

describe("ADR-0135 — PermissionScope 4-tier precedence", () => {
  test("PERMISSION_SCOPE_PRECEDENCE_DESC is managed > project > user > open", () => {
    expect([...PERMISSION_SCOPE_PRECEDENCE_DESC]).toEqual(["managed", "project", "user", "open"])
  })

  test("strongerScope returns the higher precedence member", () => {
    const cases: Array<[PermissionScope, PermissionScope, PermissionScope]> = [
      ["managed", "project", "managed"],
      ["project", "user", "project"],
      ["user", "open", "user"],
      ["open", "managed", "managed"],
      ["user", "user", "user"], // idempotent
    ]
    for (const [a, b, expected] of cases) expect(strongerScope(a, b)).toBe(expected)
  })

  test("isPermissionScope narrows valid strings and rejects garbage", () => {
    expect(isPermissionScope("user")).toBe(true)
    expect(isPermissionScope("project")).toBe(true)
    expect(isPermissionScope("managed")).toBe(true)
    expect(isPermissionScope("open")).toBe(true)
    expect(isPermissionScope("admin")).toBe(false)
    expect(isPermissionScope("")).toBe(false)
  })
})

/* ---------------- 8 special path kinds ---------------- */

describe("ADR-0135 — SpecialPathKind exhaustive resolution", () => {
  test("SPECIAL_PATH_KINDS lists exactly 8 kinds in canonical order", () => {
    expect([...SPECIAL_PATH_KINDS]).toEqual([
      "root",
      "project",
      "tmpdir",
      "git",
      "agents",
      "quanta",
      "slash_tmp",
      "tmp",
    ])
    expect(SPECIAL_PATH_KINDS.length).toBe(8)
  })

  test("isSpecialPathKind narrows all 8 kinds + rejects unknown", () => {
    for (const k of SPECIAL_PATH_KINDS) expect(isSpecialPathKind(k)).toBe(true)
    expect(isSpecialPathKind("home")).toBe(false)
    expect(isSpecialPathKind("ROOT")).toBe(false)
  })

  test("macOS resolution: tmpdir vs /tmp differ (the whole reason both kinds exist)", () => {
    const os = mkOs("darwin", "/var/folders/abc/T")
    const cwd = mkCwd("/repo", "/repo")
    const git = mkGit(undefined)
    const opts = { os, cwd, git }
    expect(resolveSpecialPath("root", opts)).toBe("/")
    expect(resolveSpecialPath("project", opts)).toBe("/repo")
    expect(resolveSpecialPath("tmpdir", opts)).toBe("/var/folders/abc/T")
    expect(resolveSpecialPath("git", opts)).toBe("/repo/.git")
    expect(resolveSpecialPath("agents", opts)).toBe("/repo/.agents")
    expect(resolveSpecialPath("quanta", opts)).toBe("/repo/.quanta")
    expect(resolveSpecialPath("slash_tmp", opts)).toBe("/tmp")
    // On macOS, "tmp" prefers tmpdir (sandboxed user-private).
    expect(resolveSpecialPath("tmp", opts)).toBe("/var/folders/abc/T")
  })

  test("Linux resolution: tmpdir and /tmp same value, but `tmp` kind prefers /tmp", () => {
    const os = mkOs("linux", "/tmp")
    const opts = { os, cwd: mkCwd("/repo", "/repo"), git: mkGit(undefined) }
    expect(resolveSpecialPath("tmpdir", opts)).toBe("/tmp")
    expect(resolveSpecialPath("slash_tmp", opts)).toBe("/tmp")
    expect(resolveSpecialPath("tmp", opts)).toBe("/tmp")
    expect(resolveSpecialPath("root", opts)).toBe("/")
  })

  test("explicit GitPort.gitDir overrides <projectRoot>/.git (worktree case)", () => {
    const opts = {
      os: mkOs("darwin", "/tmp"),
      cwd: mkCwd("/wt", "/wt"),
      git: mkGit("/repo/.git/worktrees/wt"),
    }
    expect(resolveSpecialPath("git", opts)).toBe("/repo/.git/worktrees/wt")
  })

  test("empty/undefined GitPort.gitDir falls through to default", () => {
    const noGit = { os: mkOs("linux", "/tmp"), cwd: mkCwd("/r", "/r") }
    expect(resolveSpecialPath("git", noGit)).toBe("/r/.git")
    const blankGit = { ...noGit, git: mkGit("") }
    expect(resolveSpecialPath("git", blankGit)).toBe("/r/.git")
  })
})
