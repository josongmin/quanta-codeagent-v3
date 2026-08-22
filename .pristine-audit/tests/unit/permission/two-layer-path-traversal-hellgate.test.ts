/**
 * HELLGATE — 2-layer access checker: lexical path-traversal escape (ADR-0135).
 *
 * `containsPath` is the security primitive both layers route through. Its
 * module comment records a REAL fail-OPEN regression it was written to close:
 * the prior implementation prefix-matched RAW byte strings, so a candidate
 * `/repo/../etc/passwd` byte-prefix-matched the allow-root `/repo/` and was
 * GRANTED even though it escapes the root. The fix `resolve()`s both sides and
 * asks `is-path-inside`.
 *
 * `permission-access-check.test.ts` locks the AND truth-table + the
 * prefix-SIBLING boundary (`/repo` ∌ `/repository`) — but it has NO test
 * pinning the `..` TRAVERSAL denial. Without one, a revert to byte-prefix
 * matching re-opens the hole silently. This battery is that regression seal.
 *
 * RED-ON-INJECTION (teeth, verified in-session): replacing the `containsPath`
 * body with the legacy byte-prefix check
 *   `return resolve(candidate).startsWith(resolve(entryPath))`
 * makes the `..`-escape cases FAIL (they leak through to allow).
 */

import { describe, expect, test } from "bun:test"
import {
  canAccess,
  containsPath,
  createCachedResolver,
  type FileSystemEntry,
  type FileSystemSandboxPolicy,
  type PermissionProfile,
} from "@/permission"

const mkResolver = (opts: { project?: string; tmp?: string } = {}) =>
  createCachedResolver({
    os: { family: () => "darwin", tmpdir: () => opts.tmp ?? "/var/folders/T" },
    cwd: { cwd: () => opts.project ?? "/repo", projectRoot: () => opts.project ?? "/repo" },
    git: { gitDir: () => undefined },
  })

const litEntry = (p: string, access: "read" | "write" = "write"): FileSystemEntry => ({
  path: { type: "path", value: p },
  access,
})

const profileWith = (entries: FileSystemEntry[]): PermissionProfile => ({
  fileSystem: { type: "restricted", entries },
  approval: { mode: "once", promptUser: true },
  network: { mode: "deny-all" },
  sandbox: { osSandbox: "none", readOnly: true, workspaceWrite: false, networkIsolated: true },
  control: { auditRequired: false },
})

const sandboxWith = (entries: FileSystemEntry[]): FileSystemSandboxPolicy => ({
  type: "restricted",
  entries,
})

describe("HELLGATE: containsPath — lexical `..` traversal cannot escape an allow-root", () => {
  test("a single `..` segment that climbs out of the root is REJECTED", () => {
    // Byte-prefix matching would say true (the string starts with "/repo");
    // the resolved path is "/etc/passwd" — outside the root.
    expect(containsPath("/repo", "/repo/../etc/passwd")).toBe(false)
  })

  test("nested `../../` climbing is REJECTED", () => {
    expect(containsPath("/repo/sub", "/repo/sub/../../etc/shadow")).toBe(false)
  })

  test("a path genuinely inside the root is ALLOWED (no over-correction)", () => {
    expect(containsPath("/repo", "/repo/src/app.ts")).toBe(true)
    expect(containsPath("/repo", "/repo")).toBe(true) // the root itself
    // a `..` that stays inside resolves back under the root
    expect(containsPath("/repo", "/repo/a/../b.ts")).toBe(true)
  })

  test("prefix-SIBLING never matches (`/repo` ∌ `/repository`)", () => {
    expect(containsPath("/repo", "/repository/secret")).toBe(false)
  })

  test("a relative entry or candidate is fail-CLOSED (refuse to guess against cwd)", () => {
    expect(containsPath("repo", "/repo/x.ts")).toBe(false)
    expect(containsPath("/repo", "repo/x.ts")).toBe(false)
  })
})

describe("HELLGATE: 2-layer canAccess — traversal denied even when BOTH layers root the same allow", () => {
  test("`/repo/../etc/passwd` is DENIED though both layers allow `/repo`", () => {
    // The dangerous case: both the profile AND sandbox grant `/repo`. Under
    // byte-prefix matching the escaping candidate would satisfy BOTH layers and
    // be granted. The lexical guard denies at layer 1.
    const v = canAccess("/repo/../etc/passwd", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
    expect(v.reason).toContain("permission_profile.fileSystem")
  })

  test("a write genuinely inside `/repo` still passes both layers (no over-correction)", () => {
    const v = canAccess("/repo/src/x.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(true)
  })

  test("a `..`-escape that lands in a DIFFERENT allowed sibling root is still denied by the climbed-from root", () => {
    // entry covers /repo only; the candidate climbs to /repo-evil — denied.
    const v = canAccess("/repo/../repo-evil/x.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })
})
