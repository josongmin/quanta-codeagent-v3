import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "@/runtime"
import {
  createPersistentWorktree,
  removeWorktree,
  WorktreeForkError,
} from "@/runtime/worktree-fork"
import {
  loadSessionById,
  type SavePayload,
  SessionIdError,
  type SessionMeta,
  sanitizeId,
  saveSessionById,
  sessionsRoot,
} from "@/session"

/**
 * Regression suite for Wave 1A / Wave 1B audit-finding fixes.
 *
 * Each test below pins the BEHAVIOR added by the fix so a regression flips
 * the suite red. Cross-references:
 *   HIGH-1   path-traversal: sanitizeId() rejects `..`, `/`, `\`, control bytes
 *   HIGH-2   safeBranch / safeRef sanitizers in worktree-fork.ts
 *   HIGH-3   leading-dash branch / ref rejection
 *   HIGH-6   removeWorktree idempotency on ENOENT
 *   MEDIUM-1 real atomic rename (no leaked `.tmp` after save)
 */

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}

const HAS_GIT = await gitAvailable()

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "sec-reg-repo-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = Date.now()
  return {
    id: overrides.id ?? "sec-1",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
  }
}

const mkPayload = (): SavePayload => ({
  reason: "test",
  turns: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
})

// Build control-byte strings via String.fromCharCode so the file itself is
// printable-ASCII only (avoids accidental file-encoding issues).
const NUL = String.fromCharCode(0)
const SOH = String.fromCharCode(1)

describe("HIGH-1 - sanitizeId rejects traversal / control / flag-confusion inputs", () => {
  test("path-separators throw SessionIdError", () => {
    expect(() => sanitizeId("../etc/passwd")).toThrow(SessionIdError)
    expect(() => sanitizeId("a/b")).toThrow(SessionIdError)
    expect(() => sanitizeId("a\\b")).toThrow(SessionIdError)
  })

  test("dot / dot-dot segments throw", () => {
    expect(() => sanitizeId(".")).toThrow(SessionIdError)
    expect(() => sanitizeId("..")).toThrow(SessionIdError)
  })

  test("leading dash is rejected (CLI-flag confusion)", () => {
    expect(() => sanitizeId("-rf")).toThrow(SessionIdError)
  })

  test("empty id is rejected", () => {
    expect(() => sanitizeId("")).toThrow(SessionIdError)
  })

  test("NUL byte is rejected", () => {
    expect(() => sanitizeId(`${NUL}null`)).toThrow(SessionIdError)
  })

  test("ASCII control byte (SOH) is rejected", () => {
    expect(() => sanitizeId(`${SOH}ctrl`)).toThrow(SessionIdError)
  })

  test("newline inside id is rejected (control byte 0x0a)", () => {
    expect(() => sanitizeId("foo\nnl")).toThrow(SessionIdError)
  })

  test("ids over the length cap are rejected", () => {
    expect(() => sanitizeId("a".repeat(129))).toThrow(SessionIdError)
  })

  test("legitimate uuid passes unchanged", () => {
    const id = crypto.randomUUID()
    expect(sanitizeId(id)).toBe(id)
  })

  test("legitimate slug passes unchanged", () => {
    expect(sanitizeId("legit-id_42.x")).toBe("legit-id_42.x")
  })

  test("loadSessionById propagates SessionIdError for a traversal token", async () => {
    // The contract: sanitizeId throws synchronously inside sessionFilePath,
    // BEFORE readSavedSession's try/catch wraps any fs call. So the error
    // reaches the caller — pinning the OBSERVED behavior here so a future
    // refactor that silently swallows the throw flips this test red.
    await expect(loadSessionById("../etc/passwd")).rejects.toBeInstanceOf(SessionIdError)
  })
})

describe("HIGH-2/HIGH-3 - worktree-fork sanitizes branch + ref args", () => {
  let envSnapshot: NodeJS.ProcessEnv
  const cleanups: string[] = []

  beforeEach(() => {
    envSnapshot = { ...process.env }
  })
  afterEach(() => {
    while (cleanups.length > 0) {
      const d = cleanups.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test.skipIf(!HAS_GIT)(
    "baseRef=origin/main is preserved (slash is a legal ref char, not mangled)",
    async () => {
      // Set up a real origin so `origin/main` resolves to a known sha. The
      // assertion is that the worktree HEAD matches origin/main, proving the
      // ref was NOT mangled (e.g. to `origin-main`) by safeRef.
      const repo = await makeRepo()
      cleanups.push(repo)
      const sh = (c: string) => runShell(c, { cwd: repo })
      // Create a remote pointing at this same repo so we have a real
      // `refs/remotes/origin/main` to fork from. The default branch can be
      // `main` or `master` depending on git config; detect at runtime.
      await sh("git remote add origin .")
      await sh("git fetch -q origin")
      const remoteHead = await sh("git symbolic-ref refs/remotes/origin/HEAD")
      // `refs/remotes/origin/HEAD` resolves to `refs/remotes/origin/<default>`
      const fullRef = remoteHead.stdout.trim()
      const defaultBranch = fullRef.split("/").pop() ?? "main"
      const baseRef = `origin/${defaultBranch}`
      const head = await sh(`git rev-parse refs/remotes/${baseRef}`)
      const originSha = head.stdout.trim()
      expect(originSha.length).toBeGreaterThan(0)

      const wt = await createPersistentWorktree("ref-test", repo, { baseRef })
      expect(existsSync(wt.worktreePath)).toBe(true)
      const wtHead = await runShell("git rev-parse HEAD", { cwd: wt.worktreePath })
      expect(wtHead.stdout.trim()).toBe(originSha)
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "branch starting with `-rf` is sanitized (leading dash stripped)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // safeBranch strips leading `-` and `.` rather than throwing - the
      // dash-stripped suffix is still a valid branch name, so the sanitizer
      // maintains forward progress while neutering CLI-flag attacks.
      const wt = await createPersistentWorktree("dashbranch", repo, { branch: "-rf-evil" })
      expect(wt.branch.startsWith("-")).toBe(false)
      expect(wt.branch).toBe("rf-evil")
      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).toContain("rf-evil")
      // Verify the repo's README is intact (no `rm -rf` artifact).
      expect(existsSync(`${repo}/README.md`)).toBe(true)
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "baseRef containing forbidden chars is rejected before reaching git",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // safeRef allows only [A-Za-z0-9._/~^-] - a `;` would be a shell
      // injection vector if it leaked through. Must throw WorktreeForkError
      // BEFORE git is invoked (i.e. no half-fork worktree dir).
      await expect(
        createPersistentWorktree("badref", repo, { baseRef: "HEAD; rm -rf /" }),
      ).rejects.toBeInstanceOf(WorktreeForkError)
      expect(existsSync(`${repo}/.quanta/worktrees/badref`)).toBe(false)
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "removeWorktree on a missing path returns true (idempotency regression)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // Never created - but the caller invariant ("dir is gone") is already
      // satisfied. The fix in worktree-fork.ts intercepts the ENOENT-shaped
      // stderr and reports success.
      const ok = await removeWorktree(`${repo}/.quanta/worktrees/never-existed`, repo)
      expect(ok).toBe(true)
    },
    30_000,
  )
})

describe("MEDIUM-1 - real atomic rename leaves no .tmp residue after save", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "atomic-rename-"))
    process.env.QUANTA_SESSIONS_DIR = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test("saveSessionById leaves the final file and zero .tmp files", async () => {
    // Prior behavior (Bun.write(target, Bun.file(tmp))) could observably leak
    // a `<id>.json.tmp` on partial failure. The real-rename behavior MUST NOT
    // leave any `.tmp` files in `sessionsRoot()` after a successful save.
    await saveSessionById(mkMeta({ id: "atomic-1" }), mkPayload())
    const root = sessionsRoot()
    const entries = readdirSync(root)
    expect(entries).toContain("atomic-1.json")
    const tmps = entries.filter((e) => e.endsWith(".tmp"))
    expect(tmps).toEqual([])

    // The index.jsonl rewrite also routes through a .tmp staging - confirm it
    // cleans up too (same contract, different file).
    expect(entries).toContain("index.jsonl")
  })

  test("repeated saves never accumulate .tmp residue", async () => {
    for (let i = 0; i < 5; i++) {
      await saveSessionById(mkMeta({ id: `atomic-multi-${i}` }), mkPayload())
    }
    const tmps = readdirSync(sessionsRoot()).filter((e) => e.endsWith(".tmp"))
    expect(tmps).toEqual([])
  })
})
