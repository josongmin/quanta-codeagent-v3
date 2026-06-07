/**
 * ★ HELLGATE — T08 Permission Fail-Closed Base (May-31 gqlang bugbash, L8).
 *
 * Seals the fail-OPEN holes the L8 audit named across the permission slice.
 * Every case is adversarial: it constructs the exact input that the prior code
 * resolved toward ALLOW and asserts the fail-CLOSED verdict now.
 *
 * Sections:
 *   A. Protected-branch destructive reset        (L8 H1)
 *   B. Lexical `..` traversal in access-check     (L8 H3)
 *   C. Empty writableRoots = deny, not anywhere   (L8 H4)
 *   D. `custom` host mode = defer, not allow      (L8 H5)
 *   E. Persistence-failure is observable          (L8 M5/M6)
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canAccess, containsPath } from "../access-check"
import { DEFAULT_PROTECTED_BRANCHES, decideBranchOnly } from "../branch-only"
import { createJsonStateFile } from "../json-state-file"
import { hostAllowsMutation, hostMutationVerdict } from "../per-host-mode"
import { threadAllowsMutation } from "../per-thread-store"
import type {
  FileSystemEntry,
  FileSystemSandboxPolicy,
  PermissionProfile,
} from "../permission-profile"
import type { ThreadPermission } from "../permission-store"
import { createCachedResolver } from "../special-path-resolver"

/* ─── builders ─────────────────────────────────────────────────────────── */

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

/* ─── A. Protected-branch destructive reset (L8 H1) ──────────────────────── */

describe("A. branch-only — destructive reset on a protected branch", () => {
  test("bare `git reset --hard HEAD~3` on main is DENIED (rewrites protected branch)", () => {
    const v = decideBranchOnly("git reset --hard HEAD~3", DEFAULT_PROTECTED_BRANCHES, "main")
    expect(v.allowed).toBe(false)
  })

  test("`git reset --hard` (no ref) on main is DENIED", () => {
    const v = decideBranchOnly("git reset --hard", DEFAULT_PROTECTED_BRANCHES, "main")
    expect(v.allowed).toBe(false)
  })

  test("`git reset --keep @{u}` on main is DENIED", () => {
    const v = decideBranchOnly("git reset --keep @{u}", DEFAULT_PROTECTED_BRANCHES, "main")
    expect(v.allowed).toBe(false)
  })

  test("destructive reset on a FEATURE branch is allowed (no protected rewrite)", () => {
    const v = decideBranchOnly("git reset --hard HEAD~3", DEFAULT_PROTECTED_BRANCHES, "feature/x")
    expect(v.allowed).toBe(true)
  })

  test("soft reset (`--soft`) on main is allowed (non-destructive, keeps tree)", () => {
    const v = decideBranchOnly("git reset --soft HEAD~1", DEFAULT_PROTECTED_BRANCHES, "main")
    expect(v.allowed).toBe(true)
  })

  test("explicit protected-ref reset still denied even off a feature branch", () => {
    const v = decideBranchOnly(
      "git reset --hard origin/main",
      DEFAULT_PROTECTED_BRANCHES,
      "feature/x",
    )
    expect(v.allowed).toBe(false)
  })
})

/* ─── B. Lexical `..` traversal (L8 H3) ──────────────────────────────────── */

describe("B. access-check — lexical traversal cannot escape an allow-root", () => {
  test("`/repo/../etc/passwd` is DENIED despite byte-prefixing `/repo`", () => {
    const v = canAccess("/repo/../etc/passwd", "read", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })

  test("`/repo/sub/../../etc/shadow` is DENIED (multi-hop escape)", () => {
    const v = canAccess("/repo/sub/../../etc/shadow", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })

  test("sibling-prefix `/repo2/x.ts` is DENIED (not under `/repo`)", () => {
    const v = canAccess("/repo2/x.ts", "read", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(false)
  })

  test("a genuine in-root path `/repo/src/a.ts` is still ALLOWED", () => {
    const v = canAccess("/repo/src/a.ts", "write", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(true)
  })

  test("an in-root path that lexically dips out then back stays ALLOWED", () => {
    const v = canAccess("/repo/src/../lib/b.ts", "read", {
      profile: profileWith([litEntry("/repo")]),
      sandbox: sandboxWith([litEntry("/repo")]),
      resolver: mkResolver(),
    })
    expect(v.allow).toBe(true)
  })

  test("containsPath primitive: root === candidate is inside; escape is outside", () => {
    expect(containsPath("/repo", "/repo")).toBe(true)
    expect(containsPath("/repo", "/repo/x")).toBe(true)
    expect(containsPath("/repo", "/repo/../etc")).toBe(false)
    expect(containsPath("/repo", "/repo2")).toBe(false)
    // Relative inputs are refused (fail-closed) — never resolved against cwd.
    expect(containsPath("relative/root", "/repo/x")).toBe(false)
    expect(containsPath("/repo", "relative/x")).toBe(false)
  })
})

/* ─── C. Empty writableRoots (L8 H4) ─────────────────────────────────────── */

const workspaceWrite = (roots: string[]): ThreadPermission => ({
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "workspace-write", writableRoots: roots },
})

describe("C. per-thread — empty writableRoots is DENY, not writable-anywhere", () => {
  test("workspace-write with EMPTY writableRoots denies a write", () => {
    expect(threadAllowsMutation(workspaceWrite([]), "/anywhere/at/all")).toBe(false)
  })

  test("workspace-write with a populated root allows only inside it", () => {
    const perm = workspaceWrite(["/repo"])
    expect(threadAllowsMutation(perm, "/repo/x")).toBe(true)
    expect(threadAllowsMutation(perm, "/repo")).toBe(true)
    expect(threadAllowsMutation(perm, "/other")).toBe(false)
  })

  test("sibling-prefix `/repo2` is NOT inside `/repo`", () => {
    expect(threadAllowsMutation(workspaceWrite(["/repo"]), "/repo2/x")).toBe(false)
  })
})

/* ─── D. custom host mode (L8 H5) ────────────────────────────────────────── */

describe("D. per-host — `custom` mode is DEFER, not implicit allow", () => {
  test("hostMutationVerdict('custom') === 'defer'", () => {
    expect(hostMutationVerdict("custom")).toBe("defer")
  })

  test("hostMutationVerdict full/read-only/undefined map correctly", () => {
    expect(hostMutationVerdict("full-access")).toBe("allow")
    expect(hostMutationVerdict("read-only")).toBe("deny")
    expect(hostMutationVerdict(undefined)).toBe("unpinned")
  })

  test("legacy boolean adapter: `custom` is NO LONGER `true` (no implicit allow)", () => {
    // Must be undefined (fall through to global default), never `true`.
    expect(hostAllowsMutation("custom")).toBeUndefined()
    expect(hostAllowsMutation("full-access")).toBe(true)
    expect(hostAllowsMutation("read-only")).toBe(false)
    expect(hostAllowsMutation(undefined)).toBeUndefined()
  })
})

/* ─── E. Persistence failure is observable (L8 M5/M6) ────────────────────── */

interface Doc {
  readonly version: 1
  readonly value: string
}

const docFile = (filePath: string, debounceMs = 10_000) =>
  createJsonStateFile<Doc>({
    filePath,
    debounceMs,
    emptyState: () => ({ version: 1, value: "" }),
    serialize: (s) => `${JSON.stringify(s)}\n`,
    parse: (raw) =>
      raw !== null && typeof raw === "object"
        ? { kind: "ok", state: raw as Doc }
        : { kind: "shape-invalid", reason: "not object" },
    stateVersion: 1,
  })

describe("E. json-state-file — flushDurable distinguishes persisted vs in-memory", () => {
  test("a writable path yields { durable: true }", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t08-persist-"))
    try {
      const f = docFile(join(dir, "state.json"))
      const outcome = await f.flushDurable(() => ({ version: 1, value: "x" }))
      expect(outcome.durable).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an unwritable path yields { durable: false, reason } — NOT a thrown error, NOT a silent ok", async () => {
    // Plant a regular FILE where a directory segment is expected, so mkdir /
    // write fail with ENOTDIR (deterministic, perm-independent — robust even
    // when the test runs as root where chmod wouldn't bite).
    const dir = await mkdtemp(join(tmpdir(), "t08-persist-"))
    try {
      const blocker = join(dir, "blocker")
      await writeFile(blocker, "i am a file, not a directory")
      const f = docFile(join(blocker, "nested", "state.json"))
      const outcome = await f.flushDurable(() => ({ version: 1, value: "y" }))
      expect(outcome.durable).toBe(false)
      if (!outcome.durable) expect(typeof outcome.reason).toBe("string")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("void `flush()` stays source-compatible (resolves undefined)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t08-persist-"))
    try {
      const f = docFile(join(dir, "state.json"))
      const r = await f.flush(() => ({ version: 1, value: "z" }))
      expect(r).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
