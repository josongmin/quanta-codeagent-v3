import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { loadImportLog } from "@/migration"
import { runSessionCommand, type SessionCommandDeps } from "@/runner/session-ops"
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
import { createCliImportHandler } from "../../src/apps/cli/session-import-handler"
import { resolveCliSessionListEnv } from "../../src/apps/cli/session-list-env"

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
  // CLI-05 (ADR-0305): the prior `runSessionCommand` shim auto-injected
  // these two adapters; with the shim gone the tests wire them here so
  // every existing case stays byte-identical (`import` requires the
  // handler; `ls` defaults route through listEnv → plain in non-TTY).
  const listEnv = resolveCliSessionListEnv()
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
      importHandler: createCliImportHandler(),
      ...(listEnv !== undefined ? { listEnv } : {}),
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

  test("import: persists translated sessions into the v3 store (ADR-0430)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-import-home-"))
    cleanups.push(home)
    await mkdir(join(home, ".claude/projects/proj-a"), { recursive: true })
    await mkdir(join(home, ".claude/skills"), { recursive: true })
    await writeFile(join(home, ".claude/auth.json"), JSON.stringify({ token: "t" }), "utf8")
    await writeFile(
      join(home, ".claude/projects/proj-a/session-1.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "one" }] } })}\n`,
      "utf8",
    )
    await writeFile(join(home, ".claude/skills/review.md"), "skill", "utf8")

    const c = captureDeps()
    const code = await runSessionCommand(["import", "claude_code"], {
      ...c.deps,
      homeDir: home,
    })
    expect(code).toBe(0)
    expect(c.out).toContain("imported claude_code: 1 session(s) persisted")
    expect(c.err).toBe("")
    // ADR-0430: the translated transcript is now a real, listable v3 session.
    const sessions = await listSessions({ includeArchived: true })
    expect(sessions).toHaveLength(1)

    // The import log carries a per-session dedup row + the run-summary row.
    const log = await loadImportLog(home)
    const summary = log.entries.find((e) => e.stage === "import_finished")
    expect(summary?.detail).toContain("persisted_sessions=1")
    const dedupRow = log.entries.find((e) => e.itemKind === "session")
    expect(dedupRow?.contentHash).toBeDefined()
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

  // RFC-06 §RFC06-1 — `session delete` of a worktree-backed fork removes the
  // worktree AND the local branch before deleting the session record. This is
  // the strongest end-to-end proof that cmdDelete calls the hardened
  // removeWorktree with the EXACT (repoRoot, path, branch) read from the
  // PERSISTED `workspaceOwnership` authority — NOT the removed `deriveWorktreeInfo`
  // cwd-path heuristic. (The fork path persists the ownership record; delete
  // consumes it.)
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
      // RFC-06 §RFC06-1: the fork PERSISTED the WorkspaceOwnership authority
      // that delete/GC will consume — proves the delete cleanup below is driven
      // by the durable record, not the removed cwd-path heuristic.
      expect(fork?.meta.workspaceOwnership).toBeDefined()
      expect(fork?.meta.workspaceOwnership?.path).toBe(wtPath)
      expect(fork?.meta.workspaceOwnership?.state).toBe("ready")

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

  // RFC-06 §RFC06-3 — explicit operator GC front door. Fork a worktree (which
  // persists ownership), then `worktree-gc --repo <repo>` dry-runs (eligible,
  // nothing removed) and `--apply` removes it via the hardened non-force path.
  test.skipIf(!HAS_GIT)(
    "worktree-gc dry-run classifies owned worktrees; --apply removes eligible",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta({ id: "gc-src", title: "GcSrc", cwd: repo }), mkPayload())
      const cFork = captureDeps()
      expect(await runSessionCommand(["fork", "gc-src", "--worktree"], cFork.deps)).toBe(0)
      const wtPath = cFork.out.match(/worktree: (\S+) /)?.[1] ?? ""
      expect(existsSync(wtPath)).toBe(true)

      // Dry-run: the owned worktree is eligible; nothing is removed.
      const cDry = captureDeps()
      const dryCode = await runSessionCommand(["worktree-gc", "--repo", repo], cDry.deps)
      expect(dryCode).toBe(0)
      expect(cDry.out).toContain("[eligible]")
      expect(cDry.out).toContain(wtPath)
      expect(cDry.out).toContain("Re-run with --apply")
      expect(existsSync(wtPath)).toBe(true) // dry-run removed NOTHING

      // Apply: the eligible worktree is removed via the hardened remover.
      const cApply = captureDeps()
      const applyCode = await runSessionCommand(
        ["worktree-gc", "--repo", repo, "--apply"],
        cApply.deps,
      )
      expect(applyCode).toBe(0)
      expect(cApply.out).toContain(`removed: ${wtPath}`)
      expect(existsSync(wtPath)).toBe(false)
    },
    30_000,
  )

  // RFC-06 §RFC06-3 — TOCTOU: a worktree eligible at dry-run that turns DIRTY
  // before --apply must be SKIPPED (the fresh recheck refuses it), never
  // force-removed.
  test.skipIf(!HAS_GIT)(
    "worktree-gc --apply SKIPS a target that turned dirty since dry-run (TOCTOU)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta({ id: "gc-dirty", title: "GcDirty", cwd: repo }), mkPayload())
      const cFork = captureDeps()
      expect(await runSessionCommand(["fork", "gc-dirty", "--worktree"], cFork.deps)).toBe(0)
      const wtPath = cFork.out.match(/worktree: (\S+) /)?.[1] ?? ""
      expect(existsSync(wtPath)).toBe(true)

      // Dirty it AFTER the fork (simulating drift between a dry-run and apply).
      await writeFile(join(wtPath, "scratch.txt"), "uncommitted\n")

      const cApply = captureDeps()
      const code = await runSessionCommand(["worktree-gc", "--repo", repo, "--apply"], cApply.deps)
      expect(code).toBe(0)
      // The dirty tree is classified dirty (not eligible) ⇒ preserved on disk.
      expect(existsSync(wtPath)).toBe(true)
      expect(existsSync(join(wtPath, "scratch.txt"))).toBe(true)
      expect(cApply.out).toContain("[dirty]")
      expect(cApply.out).toContain("removed 0/0 eligible")
    },
    30_000,
  )

  // RFC-06 §RFC06-3 — a legacy `.claude/worktrees/agent-*` tree with NO
  // persisted ownership is NEVER a GC candidate (provenance gate).
  test.skipIf(!HAS_GIT)(
    "worktree-gc ignores an unowned (legacy) worktree — no persisted ownership",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // Create a worktree that NO session owns (simulating a legacy agent tree).
      const legacy = join(repo, ".claude", "worktrees", "agent-legacy")
      await runShell(`git worktree add --no-track -B worktree-agent-legacy -- "${legacy}" HEAD`, {
        cwd: repo,
      })
      expect(existsSync(legacy)).toBe(true)

      const cGc = captureDeps()
      const code = await runSessionCommand(["worktree-gc", "--repo", repo, "--apply"], cGc.deps)
      expect(code).toBe(0)
      // No persisted ownership points at it ⇒ it is not even a candidate.
      expect(cGc.out).toContain("0 owned worktree(s)")
      expect(cGc.out).not.toContain(legacy)
      expect(existsSync(legacy)).toBe(true) // untouched
    },
    30_000,
  )

  // RFC-06 §RFC06-1 (R1 audit fix) — a LEGACY fork session (cwd inside
  // .quanta/worktrees but NO persisted ownership) is NOT auto-removed on delete
  // (the deriveWorktreeInfo heuristic was deleted). Instead a report-only
  // salvage NOTICE is emitted — no silent leak, no inference-driven mutation.
  test("delete of a legacy worktree session (no ownership) emits a report-only notice, no removal", async () => {
    const legacyCwd = "/some/repo/.quanta/worktrees/legacy-uuid"
    await saveSessionById(mkMeta({ id: "legacy-1", cwd: legacyCwd }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["delete", "legacy-1", "--force"], c.deps)
    expect(code).toBe(0)
    expect(c.err).toContain("notice:")
    expect(c.err).toContain(legacyCwd)
    expect(c.err).toContain("no persisted ownership")
    // No removal claim — the notice is report-only.
    expect(c.out).not.toContain("removed worktree")
  })

  // A plain (non-worktree) session delete emits NO worktree notice (the marker
  // gate is anti-vacuous — it only fires for a worktree-looking cwd).
  test("delete of a normal session emits no worktree notice", async () => {
    await saveSessionById(mkMeta({ id: "plain-1", cwd: "/home/u/project" }), mkPayload())
    const c = captureDeps()
    expect(await runSessionCommand(["delete", "plain-1", "--force"], c.deps)).toBe(0)
    expect(c.err).not.toContain("notice:")
    expect(c.err).not.toContain("worktree")
  })
})
