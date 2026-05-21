import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { runShell } from "@/runtime"
import {
  archivedFilePath,
  archiveSession,
  listSessions,
  loadSessionById,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { runSessionCommand, type SessionCommandDeps } from "../../src/apps/cli/session-commands"

/**
 * CLI `quanta session …` subcommand dispatcher tests.
 *
 * Each test scopes a throwaway `QUANTA_SESSIONS_DIR` so the on-disk store is
 * isolated. We call `runSessionCommand` directly (no binary spawn) and assert
 * against captured stdout/stderr writers — same idiom as the rest of the unit
 * suite.
 */

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = Date.now()
  return {
    id: overrides.id ?? "sess-1",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
  }
}

const mkPayload = (overrides: Partial<SavePayload> = {}): SavePayload => ({
  reason: overrides.reason ?? "completed",
  turns: overrides.turns ?? 1,
  messages: overrides.messages ?? [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
})

interface Captured {
  out: string
  err: string
  deps: SessionCommandDeps
  setConfirm: (fn: (prompt: string) => Promise<boolean>) => void
}

const captureDeps = (): Captured => {
  let confirmFn: (prompt: string) => Promise<boolean> = async () => false
  const c: Captured = {
    out: "",
    err: "",
    deps: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      confirm: (p) => confirmFn(p),
    },
    setConfirm: (fn) => {
      confirmFn = fn
    },
  }
  return c
}

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}

// Same skipIf pattern as worktree-fork.test.ts — probe once at module load so
// `test.skipIf(!HAS_GIT)` produces a real `skipped` count in the runner. The
// earlier `if (!(await gitAvailable())) return` form silently passed when git
// was absent (vapor); we adopt skipIf for every git-dependent CLI test.
const HAS_GIT = await gitAvailable()

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "cli-fork-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

describe("runSessionCommand", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv
  const cleanups: string[] = []

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "cli-session-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    while (cleanups.length > 0) {
      const d = cleanups.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("ls: lists active sessions only by default", async () => {
    await saveSessionById(mkMeta({ id: "act-1", title: "A1" }), mkPayload())
    await saveSessionById(mkMeta({ id: "arc-1", title: "AR1" }), mkPayload())
    await archiveSession("arc-1")

    const c = captureDeps()
    const code = await runSessionCommand(["ls"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("act-1")
    expect(c.out).not.toContain("arc-1")
  })

  test("ls --archived includes archived sessions", async () => {
    await saveSessionById(mkMeta({ id: "act-2" }), mkPayload())
    await saveSessionById(mkMeta({ id: "arc-2" }), mkPayload())
    await archiveSession("arc-2")

    const c = captureDeps()
    const code = await runSessionCommand(["ls", "--archived"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("act-2")
    expect(c.out).toContain("arc-2")
  })

  test("ls --json emits a JSON array of metadata", async () => {
    await saveSessionById(mkMeta({ id: "j-1", title: "J1" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["ls", "--json"], c.deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out) as SessionMeta[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.find((m) => m.id === "j-1")?.title).toBe("J1")
  })

  test("show: prints header + role-prefixed bodies; skips empty content", async () => {
    await saveSessionById(
      mkMeta({ id: "sh-1", title: "Hello" }),
      mkPayload({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
          { role: "user", content: [{ type: "text", text: "   " }] },
        ],
      }),
    )
    const c = captureDeps()
    const code = await runSessionCommand(["show", "sh-1"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("Session sh-1 — Hello (3 turns)")
    expect(c.out).toContain("[user] first")
    expect(c.out).toContain("[assistant] second")
    // empty-text turn is omitted
    expect(c.out.match(/\[user\]/g)?.length).toBe(1)
  })

  test("show: exits 1 on missing id", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["show", "nope"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("not found: nope")
  })

  test("rename: updates title; exits 0", async () => {
    await saveSessionById(mkMeta({ id: "rn-1", title: "old" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["rename", "rn-1", "fresh"], c.deps)
    expect(code).toBe(0)
    const loaded = await loadSessionById("rn-1")
    expect(loaded?.meta.title).toBe("fresh")
    expect(c.out).toContain("renamed rn-1")
  })

  test("rename: exits 1 on missing id", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["rename", "ghost", "x"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("not found: ghost")
  })

  test("archive / unarchive roundtrip", async () => {
    await saveSessionById(mkMeta({ id: "ar-1" }), mkPayload())
    {
      const c = captureDeps()
      const code = await runSessionCommand(["archive", "ar-1"], c.deps)
      expect(code).toBe(0)
      expect(c.out).toContain("archived ar-1")
    }
    expect(existsSync(archivedFilePath("ar-1"))).toBe(true)
    expect(existsSync(sessionFilePath("ar-1"))).toBe(false)
    {
      const c = captureDeps()
      const code = await runSessionCommand(["unarchive", "ar-1"], c.deps)
      expect(code).toBe(0)
      expect(c.out).toContain("unarchived ar-1")
    }
    expect(existsSync(sessionFilePath("ar-1"))).toBe(true)
    expect(existsSync(archivedFilePath("ar-1"))).toBe(false)
  })

  test("archive: exits 1 on missing id", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["archive", "ghost"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("not found: ghost")
  })

  test("fork: copies transcript to new id; does not mutate source", async () => {
    const sourceMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "world" }] },
    ]
    await saveSessionById(
      mkMeta({ id: "fk-1", title: "Src" }),
      mkPayload({ messages: sourceMessages }),
    )
    const sourceBefore = await loadSessionById("fk-1")

    const c = captureDeps()
    const code = await runSessionCommand(["fork", "fk-1"], c.deps)
    expect(code).toBe(0)
    const m = c.out.match(/forked fk-1 → (\S+)/)
    expect(m).not.toBeNull()
    const newId = m?.[1] ?? ""
    expect(newId).not.toBe("fk-1")

    const forked = await loadSessionById(newId)
    expect(forked?.messages).toEqual(sourceMessages)
    expect(forked?.meta.title).toBe("Src (fork)")

    // Source untouched
    const sourceAfter = await loadSessionById("fk-1")
    expect(sourceAfter?.meta.title).toBe(sourceBefore?.meta.title)
    expect(sourceAfter?.messages).toEqual(sourceMessages)
  })

  test("fork --title honors the override", async () => {
    await saveSessionById(mkMeta({ id: "fk-2", title: "Old" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["fork", "fk-2", "--title", "Custom"], c.deps)
    expect(code).toBe(0)
    const m = c.out.match(/forked fk-2 → (\S+)/)
    const newId = m?.[1] ?? ""
    const forked = await loadSessionById(newId)
    expect(forked?.meta.title).toBe("Custom")
  })

  test("fork: exits 1 on missing source", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["fork", "ghost"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("source not found")
  })

  test.skipIf(!HAS_GIT)(
    "fork --worktree on a git repo creates a worktree and points cwd at it",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta({ id: "fw-1", title: "Src", cwd: repo }), mkPayload())

      const c = captureDeps()
      const code = await runSessionCommand(["fork", "fw-1", "--worktree"], c.deps)
      expect(code).toBe(0)
      expect(c.out).toContain("worktree:")

      const m = c.out.match(/forked fw-1 → (\S+)/)
      const newId = m?.[1] ?? ""
      const forked = await loadSessionById(newId)
      expect(forked).toBeDefined()
      expect(forked?.meta.cwd.startsWith(`${repo}/.quanta/worktrees/`)).toBe(true)
      expect(existsSync(forked?.meta.cwd ?? "")).toBe(true)
    },
    30_000,
  )

  test("fork --worktree on a non-git cwd exits 1 without creating a session", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "non-git-"))
    cleanups.push(nonGit)
    await saveSessionById(mkMeta({ id: "fw-2", title: "NonGit", cwd: nonGit }), mkPayload())
    const before = await listSessions({ includeArchived: true })

    const c = captureDeps()
    const code = await runSessionCommand(["fork", "fw-2", "--worktree"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("requires the source cwd to be a git repo")

    // No session was created (only the source remains).
    const after = await listSessions({ includeArchived: true })
    expect(after.length).toBe(before.length)
  })

  test("delete --force removes the session file and index entry", async () => {
    await saveSessionById(mkMeta({ id: "del-1" }), mkPayload())
    expect(existsSync(sessionFilePath("del-1"))).toBe(true)
    const c = captureDeps()
    const code = await runSessionCommand(["delete", "del-1", "--force"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("deleted del-1")
    expect(existsSync(sessionFilePath("del-1"))).toBe(false)
    const ids = (await listSessions({ includeArchived: true })).map((m) => m.id)
    expect(ids).not.toContain("del-1")
  })

  test("delete without --force prompts; declining keeps the file", async () => {
    await saveSessionById(mkMeta({ id: "del-2" }), mkPayload())
    const c = captureDeps()
    c.setConfirm(async () => false)
    const code = await runSessionCommand(["delete", "del-2"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("cancelled")
    expect(existsSync(sessionFilePath("del-2"))).toBe(true)
  })

  test("delete without --force prompts; accepting removes the file", async () => {
    await saveSessionById(mkMeta({ id: "del-3" }), mkPayload())
    const c = captureDeps()
    c.setConfirm(async () => true)
    const code = await runSessionCommand(["delete", "del-3"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("deleted del-3")
    expect(existsSync(sessionFilePath("del-3"))).toBe(false)
  })

  test("delete: exits 1 on missing id", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["delete", "ghost", "--force"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("not found: ghost")
  })

  test("path: prints the absolute file path for active sessions", async () => {
    await saveSessionById(mkMeta({ id: "p-1" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["path", "p-1"], c.deps)
    expect(code).toBe(0)
    expect(c.out.trim()).toBe(sessionFilePath("p-1"))
  })

  test("path: returns the archived path for archived sessions", async () => {
    await saveSessionById(mkMeta({ id: "p-2" }), mkPayload())
    await archiveSession("p-2")
    const c = captureDeps()
    const code = await runSessionCommand(["path", "p-2"], c.deps)
    expect(code).toBe(0)
    expect(c.out.trim()).toBe(archivedFilePath("p-2"))
  })

  test("path: exits 1 on missing id", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["path", "ghost"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("not found: ghost")
  })

  test("help / no args: prints usage", async () => {
    const c = captureDeps()
    const code = await runSessionCommand([], c.deps)
    expect(code).toBe(1) // no args → 1
    expect(c.out).toContain("Usage:")
    const c2 = captureDeps()
    expect(await runSessionCommand(["--help"], c2.deps)).toBe(0)
    expect(c2.out).toContain("Usage:")
  })

  test("unknown subcommand: exits 1 with usage", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["bogus"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown subcommand: bogus")
    expect(c.out).toContain("Usage:")
  })

  // MEDIUM-9: `session show --json` emits the full SavedSession.
  test("show --json emits the full SavedSession envelope", async () => {
    await saveSessionById(mkMeta({ id: "sj-1", title: "JT" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["show", "sj-1", "--json"], c.deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out) as { meta: SessionMeta; messages: Message[] }
    expect(parsed.meta.id).toBe("sj-1")
    expect(parsed.meta.title).toBe("JT")
    expect(parsed.messages.length).toBeGreaterThan(0)
  })

  // MEDIUM-7: `ls --ids` prints one id per line, no header.
  test("ls --ids prints one id per line (pipeline-friendly)", async () => {
    await saveSessionById(mkMeta({ id: "li-1" }), mkPayload())
    await saveSessionById(mkMeta({ id: "li-2" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["ls", "--ids"], c.deps)
    expect(code).toBe(0)
    expect(c.out).not.toContain("ID  ") // no header
    const lines = c.out.split("\n").filter((l) => l !== "")
    expect(lines).toContain("li-1")
    expect(lines).toContain("li-2")
  })

  // MEDIUM-11: empty/whitespace title is rejected up front.
  test("rename: rejects empty title", async () => {
    await saveSessionById(mkMeta({ id: "rn-empty" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["rename", "rn-empty", "   "], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("title cannot be empty")
  })

  // MEDIUM-8: trailing args are rejected, not silently dropped.
  test("ls: trailing positional args are rejected", async () => {
    const c = captureDeps()
    const code = await runSessionCommand(["ls", "--json", "extra"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("unexpected argument: extra")
  })

  test("rename: trailing positional args are rejected", async () => {
    await saveSessionById(mkMeta({ id: "rn-extra" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["rename", "rn-extra", "x", "y"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("unexpected argument: y")
  })

  // LOW: empty active list with archived hidden gets a hint.
  test("ls: hint about --archived when active is empty but archived exist", async () => {
    await saveSessionById(mkMeta({ id: "h-1" }), mkPayload())
    await archiveSession("h-1")
    const c = captureDeps()
    const code = await runSessionCommand(["ls"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("use --archived")
  })

  // Audit Round 3 §C — ls --json --archived combo includes archived rows.
  test("ls --json --archived: archived rows are included in the JSON payload", async () => {
    await saveSessionById(mkMeta({ id: "ja-act" }), mkPayload())
    await saveSessionById(mkMeta({ id: "ja-arc" }), mkPayload())
    await archiveSession("ja-arc")
    const c = captureDeps()
    const code = await runSessionCommand(["ls", "--json", "--archived"], c.deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out) as SessionMeta[]
    const ids = parsed.map((m) => m.id)
    expect(ids).toContain("ja-act")
    expect(ids).toContain("ja-arc")
    expect(parsed.find((m) => m.id === "ja-arc")?.archived).toBe(true)
  })

  // Audit Round 3 §C — empty store prints "(no sessions)" with archived hint.
  test("ls: empty store prints (no sessions) with hint when archived exist", async () => {
    await saveSessionById(mkMeta({ id: "es-1" }), mkPayload())
    await archiveSession("es-1")
    const c = captureDeps()
    const code = await runSessionCommand(["ls"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("(no sessions)")
    expect(c.out).toContain("(use --archived to see archived)")
  })

  // Audit Round 3 §C — zero-message session show header says "0 turns".
  test("show: zero-message session prints '0 turns' without crashing", async () => {
    await saveSessionById(mkMeta({ id: "zm-1", title: "Empty" }), {
      reason: "fresh",
      turns: 0,
      messages: [],
    })
    const c = captureDeps()
    const code = await runSessionCommand(["show", "zm-1"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("(0 turns)")
    // No rendered turn lines.
    expect(c.out).not.toMatch(/\[user\]/)
    expect(c.out).not.toMatch(/\[assistant\]/)
  })

  // MEDIUM-11 (whitespace-only — separate from the existing all-spaces case).
  test("rename: rejects truly-empty title", async () => {
    await saveSessionById(mkMeta({ id: "rn-blank" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["rename", "rn-blank", ""], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("title cannot be empty")
  })

  // MEDIUM-8 — fork trailing positional args are rejected.
  test("fork: trailing positional args are rejected", async () => {
    await saveSessionById(mkMeta({ id: "fk-extra" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["fork", "fk-extra", "stray"], c.deps)
    expect(code).toBe(1)
    expect(c.err).toContain("unexpected argument: stray")
  })

  // Audit Round 3 §C — delete --force of an ARCHIVED session works
  // end-to-end (not just the store-level deleteSession).
  test("delete --force removes an archived session", async () => {
    await saveSessionById(mkMeta({ id: "del-arc" }), mkPayload())
    await archiveSession("del-arc")
    expect(existsSync(archivedFilePath("del-arc"))).toBe(true)
    const c = captureDeps()
    const code = await runSessionCommand(["delete", "del-arc", "--force"], c.deps)
    expect(code).toBe(0)
    expect(c.out).toContain("deleted del-arc")
    expect(existsSync(archivedFilePath("del-arc"))).toBe(false)
    const ids = (await listSessions({ includeArchived: true })).map((m) => m.id)
    expect(ids).not.toContain("del-arc")
  })

  // HIGH-6 — `session delete` of a worktree-backed fork removes the worktree
  // AND the local branch before deleting the session record. This is the
  // strongest end-to-end proof that the cleanup wiring in cmdDelete actually
  // calls removeWorktree with the correct (repoRoot, branch) derived from the
  // session's cwd path layout.
  test.skipIf(!HAS_GIT)(
    "delete cleans the worktree + branch when the session lives in a fork-worktree",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // Seed a source session that lives in the git repo.
      await saveSessionById(mkMeta({ id: "src-wt", title: "Src", cwd: repo }), mkPayload())
      // Fork into a worktree.
      const cFork = captureDeps()
      expect(await runSessionCommand(["fork", "src-wt", "--worktree"], cFork.deps)).toBe(0)
      const m = cFork.out.match(/forked src-wt → (\S+)/)
      const forkId = m?.[1] ?? ""
      expect(forkId).not.toBe("")
      const fork = await loadSessionById(forkId)
      const wtPath = fork?.meta.cwd ?? ""
      expect(existsSync(wtPath)).toBe(true)

      // Now delete the fork with --force; the worktree + branch must vanish.
      const cDel = captureDeps()
      const code = await runSessionCommand(["delete", forkId, "--force"], cDel.deps)
      expect(code).toBe(0)
      expect(cDel.out).toContain(`removed worktree: ${wtPath}`)
      expect(existsSync(wtPath)).toBe(false)

      // The fork-<safeId> branch must be gone too.
      const branches = await runShell("git branch -a", { cwd: repo })
      const safeSeg = wtPath.split("/").pop() ?? ""
      expect(branches.stdout).not.toContain(`fork-${safeSeg}`)
    },
    30_000,
  )
})
