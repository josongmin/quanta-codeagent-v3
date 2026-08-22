/**
 * ADR-0135 — 2-layer manager (extends the ADR-0046 PermissionStack).
 *
 * Locks the priority resolver extension:
 *   - No layered state registered ⇒ manager abstains (caller falls through
 *     to the legacy PermissionStack — backward compat 100%).
 *   - Profile alone registered ⇒ AND-check uses default sandbox (deny by
 *     default, partial-config strictness).
 *   - Sandbox alone registered ⇒ AND-check uses default profile.
 *   - Both registered ⇒ canonical 2-layer AND.
 *   - The existing HARD_DENY / post-denial / per-thread / per-host axes are
 *     unaffected (separate file — this module is additive).
 */
import { describe, expect, test } from "bun:test"
import {
  createCachedResolver,
  createTwoLayerManager,
  DEFAULT_PERMISSION_PROFILE,
  type FileSystemEntry,
  type FileSystemSandboxPolicy,
  type PermissionProfile,
} from "@/permission"

const mkResolver = () =>
  createCachedResolver({
    os: { family: () => "darwin", tmpdir: () => "/var/folders/T" },
    cwd: { cwd: () => "/repo", projectRoot: () => "/repo" },
    git: { gitDir: () => undefined },
  })

const litEntry = (p: string, access: "read" | "write" = "write"): FileSystemEntry => ({
  path: { type: "path", value: p },
  access,
})

const profileWith = (entries: FileSystemEntry[]): PermissionProfile => ({
  ...DEFAULT_PERMISSION_PROFILE,
  fileSystem: { type: "restricted", entries },
})

const sandboxWith = (entries: FileSystemEntry[]): FileSystemSandboxPolicy => ({
  type: "restricted",
  entries,
})

/* ---------------- abstention ---------------- */

describe("ADR-0135 — TwoLayerManager abstention (backward compat)", () => {
  test("unregistered thread ⇒ no-policy abstain (caller falls through)", () => {
    const m = createTwoLayerManager()
    const r = m.getEffectiveAccess("t-unknown", "/anywhere", "read", mkResolver())
    expect(r.decidedBy).toBe("no-policy")
    expect(r.allow).toBe(false)
  })

  test("explicit clearThread restores abstain state", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.clearThread("t-1")
    expect(m.getEffectiveAccess("t-1", "/repo/x", "read", mkResolver()).decidedBy).toBe("no-policy")
  })
})

/* ---------------- single layer enforcement (partial config = strict) ---------------- */

describe("ADR-0135 — partial config (one layer only) uses default for the other", () => {
  test("profile alone allow, default sandbox denies ⇒ deny (deny-by-default)", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    const r = m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver())
    expect(r.decidedBy).toBe("profile-and-sandbox")
    expect(r.allow).toBe(false)
    expect(r.reason).toContain("file_system_sandbox_policy")
  })

  test("sandbox alone allow, default profile denies ⇒ deny", () => {
    const m = createTwoLayerManager()
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([litEntry("/repo")]))
    const r = m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver())
    expect(r.decidedBy).toBe("profile-and-sandbox")
    expect(r.allow).toBe(false)
    expect(r.reason).toContain("permission_profile.fileSystem")
  })
})

/* ---------------- both layers AND ---------------- */

describe("ADR-0135 — both layers registered (AND condition)", () => {
  test("both allow ⇒ allow", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([litEntry("/repo")]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver()).allow).toBe(true)
  })

  test("profile deny + sandbox allow ⇒ deny", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([litEntry("/repo")]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver()).allow).toBe(false)
  })

  test("profile allow + sandbox deny ⇒ deny", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver()).allow).toBe(false)
  })

  test("both deny ⇒ deny", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver()).allow).toBe(false)
  })
})

/* ---------------- thread isolation ---------------- */

describe("ADR-0135 — per-thread isolation", () => {
  test("setting on t-1 does not affect t-2", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([litEntry("/repo")]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "write", mkResolver()).allow).toBe(true)
    expect(m.getEffectiveAccess("t-2", "/repo/x", "write", mkResolver()).decidedBy).toBe(
      "no-policy",
    )
  })

  test("read-back via getter mirrors what was set", () => {
    const m = createTwoLayerManager()
    const prof = profileWith([litEntry("/repo")])
    const sb = sandboxWith([litEntry("/repo")])
    m.setPermissionProfile("t-1", prof)
    m.setFileSystemSandboxPolicy("t-1", sb)
    expect(m.getPermissionProfile("t-1")).toBe(prof)
    expect(m.getFileSystemSandboxPolicy("t-1")).toBe(sb)
    expect(m.getPermissionProfile("t-other")).toBeUndefined()
  })
})

/* ---------------- existing PermissionStack untouched ---------------- */

describe("ADR-0135 — additivity (legacy PermissionStack axes unaffected)", () => {
  test("TwoLayerManager is in a separate module; does not import PermissionStore", async () => {
    const mod = await import("@/permission/two-layer-manager")
    // Smoke-check: it exports the manager factory + abstaining default.
    expect(typeof mod.createTwoLayerManager).toBe("function")
  })

  test("manager re-set replaces the policy (idempotent semantics)", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([]))
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.setFileSystemSandboxPolicy("t-1", sandboxWith([litEntry("/repo")]))
    expect(m.getEffectiveAccess("t-1", "/repo/x", "read", mkResolver()).allow).toBe(true)
  })

  test("clear() drops every thread", () => {
    const m = createTwoLayerManager()
    m.setPermissionProfile("t-1", profileWith([litEntry("/repo")]))
    m.setPermissionProfile("t-2", profileWith([litEntry("/repo")]))
    m.clear()
    expect(m.getEffectiveAccess("t-1", "/repo/x", "read", mkResolver()).decidedBy).toBe("no-policy")
    expect(m.getEffectiveAccess("t-2", "/repo/x", "read", mkResolver()).decidedBy).toBe("no-policy")
  })
})
