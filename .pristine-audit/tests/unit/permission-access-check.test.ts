/**
 * ADR-0135 — 2-layer AND access check + special-path cache hit rate.
 *
 * The four-way truth table (profile × sandbox × {allow, deny}) is locked
 * here. Any layer denying ⇒ overall denial. The LRU cache test asserts the
 * 95%+ hit-rate target by repeatedly resolving the same 8 kinds.
 */
import { describe, expect, test } from "bun:test"
import {
  canAccess,
  createCachedResolver,
  type FileSystemEntry,
  type FileSystemSandboxPolicy,
  type PermissionProfile,
  SPECIAL_PATH_KINDS,
} from "@/permission"

/* ---------------- builders ---------------- */

const mkResolver = (opts: { project?: string; tmp?: string } = {}) =>
  createCachedResolver({
    os: { family: () => "darwin", tmpdir: () => opts.tmp ?? "/var/folders/T" },
    cwd: { cwd: () => opts.project ?? "/repo", projectRoot: () => opts.project ?? "/repo" },
    git: { gitDir: () => undefined },
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

const litEntry = (p: string, access: "read" | "write" = "write"): FileSystemEntry => ({
  path: { type: "path", value: p },
  access,
})

/* ---------------- AND truth table ---------------- */

describe("ADR-0135 — 2-layer AND condition truth table", () => {
  test("profile allow + sandbox allow ⇒ allow", () => {
    const v = canAccess("/repo/x.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(true)
  })

  test("profile allow + sandbox deny ⇒ deny (with categorical reason)", () => {
    const v = canAccess("/repo/x.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
    expect(v.reason).toContain("file_system_sandbox_policy")
    expect(v.reason).toContain("write")
  })

  test("profile deny + sandbox allow ⇒ deny", () => {
    const v = canAccess("/repo/x.ts", "write", {
      profile: profileWith([]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
    expect(v.reason).toContain("permission_profile.fileSystem")
  })

  test("profile deny + sandbox deny ⇒ deny (profile reported first)", () => {
    const v = canAccess("/repo/x.ts", "write", {
      profile: profileWith([]),
      sandbox: sandboxWith([]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
    // Profile layer is checked first — its denial wins the message.
    expect(v.reason).toContain("permission_profile.fileSystem")
  })
})

/* ---------------- access-mode covering ---------------- */

describe("ADR-0135 — access mode covering", () => {
  test("write-typed entry covers read request (POSIX superset)", () => {
    const v = canAccess("/repo/a.ts", "read", {
      profile: profileWith([litEntry("/repo", "write")]),
      sandbox: sandboxWith([litEntry("/repo", "write")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(true)
  })

  test("read-typed entry does NOT cover write request", () => {
    const v = canAccess("/repo/a.ts", "write", {
      profile: profileWith([litEntry("/repo", "read")]),
      sandbox: sandboxWith([litEntry("/repo", "read")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })

  test("entry boundary respected — /repo does NOT cover /repository", () => {
    const v = canAccess("/repository/a.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })
})

/* ---------------- special-path entries ---------------- */

describe("ADR-0135 — special path entries", () => {
  test("special `project` entry resolves to <projectRoot> and matches", () => {
    const profile = profileWith([{ path: { type: "special", kind: "project" }, access: "write" }])
    const sandbox = sandboxWith([{ path: { type: "special", kind: "project" }, access: "write" }])
    const v = canAccess("/repo/sub/x.ts", "write", {
      profile,
      sandbox,
      resolver: mkResolver({ project: "/repo" }),
    })
    expect(v.allow).toBe(true)
  })

  test("special `tmpdir` matches a path under the OS tmp dir", () => {
    const profile = profileWith([{ path: { type: "special", kind: "tmpdir" }, access: "write" }])
    const sandbox = sandboxWith([{ path: { type: "special", kind: "tmpdir" }, access: "write" }])
    const v = canAccess("/var/folders/T/foo", "write", {
      profile,
      sandbox,
      resolver: mkResolver({ tmp: "/var/folders/T" }),
    })
    expect(v.allow).toBe(true)
  })
})

/* ---------------- LRU cache ---------------- */

describe("ADR-0135 — special-path resolver LRU cache", () => {
  test("same kind resolved twice → 1 miss + 1 hit", () => {
    const r = mkResolver()
    r.resolve("project")
    r.resolve("project")
    expect(r.totalCalls()).toBe(2)
    expect(r.cacheHits()).toBe(1)
  })

  test("resolving all 8 kinds N times achieves ≥95% hit rate (target)", () => {
    const r = mkResolver()
    const N = 50
    for (let i = 0; i < N; i++) {
      for (const k of SPECIAL_PATH_KINDS) r.resolve(k)
    }
    // Expected: 8 misses on the first pass + (N-1) * 8 hits.
    const total = N * SPECIAL_PATH_KINDS.length
    const hits = r.cacheHits()
    expect(r.totalCalls()).toBe(total)
    expect(hits).toBe(total - SPECIAL_PATH_KINDS.length)
    // 392 / 400 = 98% — well above the 95% floor documented in the ADR.
    expect(hits / total).toBeGreaterThanOrEqual(0.95)
  })
})
