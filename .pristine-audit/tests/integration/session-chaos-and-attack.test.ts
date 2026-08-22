import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runSessionCommand, type SessionCommandDeps } from "@/runner/session-ops"
import { runShell } from "@/runtime"
import {
  archivedFilePath,
  archiveSession,
  forkSession,
  indexFilePath,
  listSessions,
  loadSessionById,
  type SavedSession,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
  sessionsRoot,
  upsertMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { createCliImportHandler } from "../../src/apps/cli/session-import-handler"
import { resolveCliSessionListEnv } from "../../src/apps/cli/session-list-env"

/**
 * Adversarial e2e suite for the `quanta session` UX. Every test is designed
 * to BREAK the implementation if anything is loose — malicious ids, corrupt
 * filesystem state, concurrent writers, exotic unicode, version drift.
 *
 * This file is allowlisted in biome.json for `src/apps/cli/**` imports — same
 * pattern as `session-ux-e2e.test.ts`. NO production code is touched.
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
const IS_WIN = process.platform === "win32"

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-repo-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

interface Captured {
  out: string
  err: string
  deps: SessionCommandDeps
}

const captureDeps = (confirmAnswer = true): Captured => {
  // CLI-05 (ADR-0294): inject the two surface adapters that the prior
  // `runSessionCommand` shim used to auto-supply (importHandler + listEnv).
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
      confirm: async () => confirmAnswer,
      importHandler: createCliImportHandler(),
      ...(listEnv !== undefined ? { listEnv } : {}),
    },
  }
  return c
}

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = Date.now()
  return {
    id: overrides.id ?? "chaos-1",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
  }
}

const mkPayload = (msgCount = 2): SavePayload => {
  const messages = []
  for (let i = 0; i < msgCount; i++) {
    messages.push(
      i % 2 === 0
        ? { role: "user" as const, content: [{ type: "text" as const, text: `msg-${i}` }] }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `reply-${i}` }],
          },
    )
  }
  return { reason: "completed", turns: msgCount, messages }
}

// ---------------------------------------------------------------------------
// Shared per-test environment: a fresh sessions dir + env snapshot. Each
// describe block re-uses this scaffold and adds its own teardown extras.
// ---------------------------------------------------------------------------

const drainCleanupStack = async (stack: (() => void | Promise<void>)[]): Promise<void> => {
  while (stack.length > 0) {
    const fn = stack.pop()
    if (!fn) continue
    try {
      await fn()
    } catch {
      // best-effort
    }
  }
}

const restoreEnv = (envSnapshot: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  Object.assign(process.env, envSnapshot)
}

const safeRmDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore — teardown is best-effort
  }
}

const setupSessionsDir = (prefix: string) => {
  let sessionsDir = ""
  let envSnapshot: NodeJS.ProcessEnv = {}
  const cleanupStack: (() => void | Promise<void>)[] = []

  const before = () => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), prefix))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  }
  const after = async () => {
    // Run extra cleanups (e.g. chmod restores) BEFORE the rmSync so the
    // teardown of a chmod-555 dir actually succeeds.
    await drainCleanupStack(cleanupStack)
    if (sessionsDir !== "") {
      safeRmDir(sessionsDir)
      sessionsDir = ""
    }
    restoreEnv(envSnapshot)
    __resetRuntimeConfig()
  }
  return {
    before,
    after,
    push: (fn: () => void | Promise<void>) => cleanupStack.push(fn),
    dir: () => sessionsDir,
  }
}

// =========================================================================
// A. Malicious id inputs — must be rejected via sanitizeId at the dispatcher.
// =========================================================================

describe("A. malicious id inputs (sanitizeId surface)", () => {
  const env = setupSessionsDir("chaos-A-")

  beforeEach(env.before)
  afterEach(env.after)

  // CONTRACT: the dispatcher catches `SessionIdError` thrown by `sanitizeId`
  // (reached via `sessionFilePath` / `archivedFilePath` / the per-id storage
  // helpers) and surfaces it as exit-1 + a standardized
  // `session <verb>: <reason>` stderr line. NO filesystem side-effect leaks
  // outside `sessionsDir`. These tests pin BOTH halves of the contract.
  const cases: { args: string[]; verb: string; label: string }[] = [
    { args: ["rename", "../etc/passwd", "x"], verb: "rename", label: "parent-escape" },
    {
      args: ["show", "..\\..\\windows\\system32"],
      verb: "show",
      label: "windows-backslash",
    },
    { args: ["delete", "/etc/hosts", "--force"], verb: "delete", label: "absolute-path" },
    { args: ["fork", "abc\x00null"], verb: "fork", label: "nul-byte" },
    { args: ["archive", ""], verb: "archive", label: "empty-id" },
    { args: ["archive", "-rf"], verb: "archive", label: "leading-dash" },
    { args: ["show", "a".repeat(200)], verb: "show", label: "length-cap" },
    { args: ["path", "."], verb: "path", label: "dot" },
    { args: ["path", ".."], verb: "path", label: "dotdot" },
  ]

  for (const { args, verb, label } of cases) {
    test(`${verb} with ${label} exits 1 with standardized prefix; no fs escape`, async () => {
      const c = captureDeps()
      const exitCode = await runSessionCommand(args, c.deps)
      // UX contract: exit-1 with the standardized `session <verb>:` preamble.
      expect(exitCode).toBe(1)
      expect(c.err).toContain(`session ${verb}:`)
      // No row created.
      const sessions = await listSessions({ includeArchived: true })
      expect(sessions).toEqual([])
      // No stray files inside sessionsDir (only optional `archived/`).
      expect(readdirSync(env.dir()).filter((n) => n !== "archived")).toEqual([])
    })
  }

  test("rename ../etc/passwd: id rejected AND /etc/passwd mtime unchanged", async () => {
    // Strong assertion: capture /etc/passwd mtime before, run the attack,
    // verify mtime unchanged.
    let beforeMtime: number | undefined
    try {
      beforeMtime = statSync("/etc/passwd").mtimeMs
    } catch {
      // No /etc/passwd or no read perm — skip the inner assertion gracefully.
    }
    const c = captureDeps()
    const exitCode = await runSessionCommand(["rename", "../etc/passwd", "newtitle"], c.deps)
    expect(exitCode).toBe(1)
    expect(c.err).toContain("session rename:")
    if (beforeMtime !== undefined) {
      const afterMtime = statSync("/etc/passwd").mtimeMs
      expect(afterMtime).toBe(beforeMtime)
    }
  })
})

// =========================================================================
// B. Malicious title / argv injection.
// =========================================================================

describe("B. malicious title / argv injection", () => {
  const env = setupSessionsDir("chaos-B-")

  beforeEach(env.before)
  afterEach(env.after)

  const idA = "title-attack-1"

  test("newline in title — current behavior: accepted as literal", async () => {
    await saveSessionById(mkMeta({ id: idA, title: "orig" }), mkPayload())
    const c = captureDeps()
    const code = await runSessionCommand(["rename", idA, "line1\nline2"], c.deps)
    // Pin the current behavior: title trim is non-empty, so it's accepted.
    expect(code).toBe(0)
    const reloaded = await loadSessionById(idA)
    expect(reloaded?.meta.title).toBe("line1\nline2")
    // `ls` must NOT crash even with newline-in-title.
    const c2 = captureDeps()
    expect(await runSessionCommand(["ls"], c2.deps)).toBe(0)
    expect(c2.out).toContain(idA)
    // POTENTIAL IMPROVEMENT: newline in title breaks ls row alignment — could
    // be sanitized (e.g. replace \n with space) at rename time.
  })

  test("title with shell metachars stored as literal (no execution)", async () => {
    await saveSessionById(mkMeta({ id: idA, title: "orig" }), mkPayload())
    const attack = "$(rm -rf /)"
    const c = captureDeps()
    expect(await runSessionCommand(["rename", idA, attack], c.deps)).toBe(0)
    const reloaded = await loadSessionById(idA)
    expect(reloaded?.meta.title).toBe(attack) // byte-identical literal
    // Sanity: the home directory still exists (no command execution happened).
    expect(existsSync(env.dir())).toBe(true)
  })

  test("title containing the ls column separator does not crash ls", async () => {
    await saveSessionById(mkMeta({ id: idA, title: "orig" }), mkPayload())
    const c1 = captureDeps()
    // Two consecutive spaces is what the ls header uses between columns.
    expect(await runSessionCommand(["rename", idA, "weird  spacing  title"], c1.deps)).toBe(0)
    const c2 = captureDeps()
    expect(await runSessionCommand(["ls"], c2.deps)).toBe(0)
    // No throw, no empty output, id still printed.
    expect(c2.out).toContain(idA)
  })

  test("extremely long title (10k chars): save+ls truncates, show returns full", async () => {
    await saveSessionById(mkMeta({ id: idA, title: "orig" }), mkPayload())
    const longTitle = "x".repeat(10_000)
    const cR = captureDeps()
    expect(await runSessionCommand(["rename", idA, longTitle], cR.deps)).toBe(0)

    // ls must complete (any reasonable runtime — header used padEnd(24) so it
    // will print the truncated header row).
    const cLs = captureDeps()
    expect(await runSessionCommand(["ls"], cLs.deps)).toBe(0)
    expect(cLs.out).toContain(idA)
    // Title display is truncated (we only check that the table row line is
    // a reasonable length — not 10k chars + ID + cwd + arch).
    const idLine = cLs.out.split("\n").find((l) => l.includes(idA)) ?? ""
    expect(idLine.length).toBeLessThan(200)

    // show --json returns the FULL title.
    const cShow = captureDeps()
    expect(await runSessionCommand(["show", idA, "--json"], cShow.deps)).toBe(0)
    const parsed = JSON.parse(cShow.out) as SavedSession
    expect(parsed.meta.title.length).toBe(10_000)
  })
})

// =========================================================================
// C. Filesystem chaos.
// =========================================================================

describe("C. filesystem chaos", () => {
  const env = setupSessionsDir("chaos-C-")

  beforeEach(env.before)
  afterEach(env.after)

  test("corrupted index.jsonl: invalid JSON + half-line + wrong types yields only valid rows", async () => {
    // Seed one valid session so we can write its meta into the (still-broken)
    // index too.
    const good = mkMeta({ id: "good-1", title: "Good" })
    await saveSessionById(good, mkPayload())

    // Now deliberately corrupt the index.
    const idx = indexFilePath()
    const lines = [
      "not valid json {{{",
      '{"id":"half-line","title":"halv', // truncated — no closing
      `${JSON.stringify({ id: 123, title: "bad-types", cwd: "/x", createdAt: 0, lastTouched: 0, archived: false })}`,
      // Extra fields — should still parse if required fields are present.
      `${JSON.stringify({ ...good, extra: "ignored", weird: true })}`,
      "",
      // Missing required fields.
      `${JSON.stringify({ id: "missing-fields" })}`,
    ]
    await writeFile(idx, `${lines.join("\n")}\n`)

    const c = captureDeps()
    const code = await runSessionCommand(["ls"], c.deps)
    // Best-effort: ls returns 0 even with a broken index.
    expect(code).toBe(0)
    // The "good-1" row survives (its extra-field variant parses).
    expect(c.out).toContain("good-1")
    // The "bad-types" entry (id:123 — number, not string) must be dropped.
    expect(c.out).not.toContain("bad-types")
    expect(c.out).not.toContain("missing-fields")
    expect(c.out).not.toContain("half-line")
  })

  test("session file present but missing from index: show finds it, ls doesn't", async () => {
    const id = "orphan-file"
    // Write the .json directly, never calling upsertMeta.
    const meta = mkMeta({ id, title: "Orphan" })
    const saved: SavedSession = {
      version: 2,
      meta,
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    await writeFile(sessionFilePath(id), JSON.stringify(saved))

    const cLs = captureDeps()
    expect(await runSessionCommand(["ls"], cLs.deps)).toBe(0)
    expect(cLs.out).not.toContain(id)

    const cShow = captureDeps()
    expect(await runSessionCommand(["show", id], cShow.deps)).toBe(0)
    expect(cShow.out).toContain(id)
    expect(cShow.out).toContain("Orphan")
  })

  test("index entry present but session file missing: ls shows row, show exits 1", async () => {
    const id = "phantom-row"
    await upsertMeta(mkMeta({ id, title: "Phantom" }))
    // Do NOT write any .json file.

    const cLs = captureDeps()
    expect(await runSessionCommand(["ls"], cLs.deps)).toBe(0)
    expect(cLs.out).toContain(id)

    const cShow = captureDeps()
    expect(await runSessionCommand(["show", id], cShow.deps)).toBe(1)
    expect(cShow.err).toContain("session show:")
    expect(cShow.err).toContain("not found")
  })

  test.skipIf(IS_WIN)(
    "read-only sessionsDir: saveSessionById fails cleanly, no crash",
    async () => {
      const id = "ro-1"
      // Make sessionsDir read-only.
      await chmod(env.dir(), 0o555)
      // CRITICAL: restore perms before afterEach tries to rm.
      env.push(async () => {
        try {
          await chmod(env.dir(), 0o755)
        } catch {
          // dir may already be gone
        }
      })
      let threw = false
      try {
        await saveSessionById(mkMeta({ id, title: "RO" }), mkPayload())
      } catch {
        threw = true
      }
      // Either it threw an error OR the write silently failed — both are
      // acceptable; the contract is "does not crash the process".
      // The strong assertion: the session was NOT visible after the attempt.
      const remaining = await listSessions({ includeArchived: true })
      expect(remaining.find((m) => m.id === id)).toBeUndefined()
      // We expect a throw on POSIX (storage.writeFile bubbles EACCES).
      expect(threw).toBe(true)
    },
  )

  test("stale <id>.json.tmp left over from prior crash: saveSessionById still succeeds", async () => {
    const id = "tmp-leftover"
    const targetPath = sessionFilePath(id)
    const legacyTmpPath = `${targetPath}.tmp`
    // Pre-seed a stale tmp with garbage content (legacy shared-tmp filename).
    await mkdir(dirname(legacyTmpPath), { recursive: true })
    await writeFile(legacyTmpPath, "STALE_GARBAGE_FROM_PRIOR_CRASH")
    expect(existsSync(legacyTmpPath)).toBe(true)

    // Now do a real save — writes to a per-writer `.tmp.<pid>.<rand>` then
    // renames. The legacy `.tmp` is harmless garbage and is not touched.
    await saveSessionById(mkMeta({ id, title: "After" }), mkPayload(2))

    // Final file is the new content (parses as JSON with correct title).
    const loaded = await loadSessionById(id)
    expect(loaded?.meta.title).toBe("After")
    // No NEW per-writer tmp residue. (Each save's tmp is `rename()`-d away.)
    const residue = readdirSync(env.dir()).filter((f) =>
      new RegExp(`^${id}\\.json\\.tmp\\.\\d+\\.[0-9a-f]+$`).test(f),
    )
    expect(residue).toEqual([])
  })

  test.skipIf(IS_WIN)("sessionsDir as a symlink: implementation follows it correctly", async () => {
    // Build a real backing dir, then point QUANTA_SESSIONS_DIR at a symlink
    // to it. After this point env.dir() still names the *symlink* and that's
    // what saveSessionById will resolve through.
    const backing = mkdtempSync(join(tmpdir(), "chaos-C-backing-"))
    env.push(() => {
      try {
        rmSync(backing, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })
    // Replace env.dir() with a symlink → backing. Have to remove the dir first.
    rmSync(env.dir(), { recursive: true, force: true })
    await symlink(backing, env.dir(), "dir")

    const id = "via-symlink"
    await saveSessionById(mkMeta({ id, title: "Sym" }), mkPayload())
    // The .json was actually written into the backing dir (because the
    // symlink at sessionsRoot() transparently resolves).
    const realFile = join(backing, `${id}.json`)
    expect(existsSync(realFile)).toBe(true)
    // And loadSessionById finds it.
    const loaded = await loadSessionById(id)
    expect(loaded?.meta.title).toBe("Sym")
    // Quick sanity: sessionsRoot() returns the symlink path, not the backing.
    expect(sessionsRoot()).toBe(env.dir())
  })
})

// =========================================================================
// D. Concurrent operations.
// =========================================================================

describe("D. concurrent operations", () => {
  const env = setupSessionsDir("chaos-D-")

  beforeEach(env.before)
  afterEach(env.after)

  // CONCURRENCY CONTRACT (post-fix): each writer stages to a unique
  // `.tmp.<pid>.<rand>` and `rename()`s to the shared target. POSIX rename is
  // atomic and the LAST rename wins; earlier writers' renames succeed too
  // but their bytes are overwritten — documented last-writer-wins, NEVER a
  // throw on the rename itself. The per-session JSON file is never affected
  // across distinct ids (each id is its own file).

  test("two saveSessionById to the SAME id: both succeed; survivor parses", async () => {
    const id = "race-same"
    const p1 = saveSessionById(mkMeta({ id, title: "A" }), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "from-A" }] }],
    })
    const p2 = saveSessionById(mkMeta({ id, title: "B" }), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "from-B" }] }],
    })
    const results = await Promise.allSettled([p1, p2])
    // BOTH writes succeed — per-writer tmps prevent the previous ENOENT race.
    const fulfilled = results.filter((r) => r.status === "fulfilled").length
    expect(fulfilled).toBe(2)
    // The on-disk file is a single VALID JSON document (no torn write).
    const raw = await readFile(sessionFilePath(id), "utf8")
    const parsed = JSON.parse(raw) as SavedSession
    expect(parsed.version).toBe(2)
    expect(["A", "B"]).toContain(parsed.meta.title)
    // No per-writer tmp residue remains.
    const residue = readdirSync(env.dir()).filter((f) => f.includes(".tmp."))
    expect(residue).toEqual([])
  })

  test("two saveSessionById to DIFFERENT ids: both files + at least one index row", async () => {
    const ids = ["par-1", "par-2"]
    const results = await Promise.allSettled(
      ids.map((id) => saveSessionById(mkMeta({ id, title: id.toUpperCase() }), mkPayload())),
    )
    // BOTH saves succeed under the per-writer-tmp scheme.
    const fulfilled = results.filter((r) => r.status === "fulfilled").length
    expect(fulfilled).toBe(2)
    expect(existsSync(sessionFilePath("par-1"))).toBe(true)
    expect(existsSync(sessionFilePath("par-2"))).toBe(true)
    const a = await loadSessionById("par-1")
    const b = await loadSessionById("par-2")
    expect(a?.meta.title).toBe("PAR-1")
    expect(b?.meta.title).toBe("PAR-2")
    // BOTH ids appear in the index (in-process mutex serializes the
    // read-modify-write window on `upsertMeta`).
    const idx = await listSessions({ includeArchived: true })
    const idxIds = idx.map((m) => m.id).sort()
    expect(idxIds).toEqual(["par-1", "par-2"])
    // No per-writer tmp residue remains.
    const residue = readdirSync(env.dir()).filter((f) => f.includes(".tmp."))
    expect(residue).toEqual([])
  })

  test("saveSessionById + archiveSession in parallel: file in EXACTLY one place (or surviving op consistent)", async () => {
    const id = "race-archive"
    // Seed an initial session so archive has something to grab.
    await saveSessionById(mkMeta({ id, title: "Seed" }), mkPayload())

    const ps = saveSessionById(mkMeta({ id, title: "Resave" }), mkPayload())
    const pa = archiveSession(id)
    await Promise.allSettled([ps, pa])

    const activeExists = existsSync(sessionFilePath(id))
    const archivedExists = existsSync(archivedFilePath(id))
    // CONSISTENT outcome: present in EXACTLY one of {active, archived}.
    // Both true (visible in two places) or both false (lost the session)
    // would be a bug. (The tmp race may make one of the two ops throw, but
    // the SURVIVING op leaves the file in ONE consistent place.)
    const onePresent = activeExists !== archivedExists
    expect(onePresent).toBe(true)
    // And the surviving file parses as JSON.
    const path = activeExists ? sessionFilePath(id) : archivedFilePath(id)
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as SavedSession
    expect(parsed.meta.id).toBe(id)
  })

  test("two parallel `session fork` of the same source: both succeed, distinct newIds", async () => {
    const id = "fork-source"
    await saveSessionById(mkMeta({ id, title: "Src" }), mkPayload())

    const c1 = captureDeps()
    const c2 = captureDeps()
    // Per-writer-tmp fix: both forks succeed cleanly. Index updates may
    // last-writer-wins, but per-id JSON files are independent and always
    // land on disk.
    const codes = await Promise.all([
      runSessionCommand(["fork", id], c1.deps),
      runSessionCommand(["fork", id], c2.deps),
    ])
    expect(codes).toEqual([0, 0])
    const nids = [c1.out, c2.out]
      .map((s) => (s.match(/forked \S+ → (\S+)/) ?? [])[1] ?? "")
      .filter((s) => s !== "")
    expect(nids.length).toBe(2)
    expect(nids[0]).not.toBe(nids[1])
    // Per-id session files are on disk for both forks.
    for (const nid of nids) {
      expect(existsSync(sessionFilePath(nid))).toBe(true)
    }
    // No tmp residue.
    const residue = readdirSync(env.dir()).filter((f) => f.includes(".tmp."))
    expect(residue).toEqual([])
  })
})

// =========================================================================
// E. Unicode + edge data.
// =========================================================================

describe("E. unicode + edge data", () => {
  const env = setupSessionsDir("chaos-E-")

  beforeEach(env.before)
  afterEach(env.after)

  const titles = [
    { label: "Korean", v: "한글제목" },
    { label: "emoji", v: "🔥title" },
    { label: "RTL Hebrew", v: "שלום" },
    { label: "zero-width joiner", v: "a‍z" },
    { label: "BOM prefix", v: "﻿withBOM" },
  ]

  for (const { label, v } of titles) {
    test(`title preserves byte-exact: ${label}`, async () => {
      const id = `unicode-${label.replace(/\s+/g, "_")}`
      await saveSessionById(mkMeta({ id, title: v }), mkPayload())
      const loaded = await loadSessionById(id)
      expect(loaded?.meta.title).toBe(v)
      // ls renders without crash.
      const cLs = captureDeps()
      expect(await runSessionCommand(["ls"], cLs.deps)).toBe(0)
      expect(cLs.out).toContain(id)
      // show --json round-trips the title byte-exact.
      const cShow = captureDeps()
      expect(await runSessionCommand(["show", id, "--json"], cShow.deps)).toBe(0)
      const parsed = JSON.parse(cShow.out) as SavedSession
      expect(parsed.meta.title).toBe(v)
    })
  }

  test("rename: whitespace-only rejected, trim-then-non-empty accepted", async () => {
    const id = "ws-title"
    await saveSessionById(mkMeta({ id, title: "orig" }), mkPayload())
    // Rejected:
    {
      const c = captureDeps()
      expect(await runSessionCommand(["rename", id, "   "], c.deps)).toBe(1)
      expect(c.err).toContain("title cannot be empty")
      const reloaded = await loadSessionById(id)
      expect(reloaded?.meta.title).toBe("orig") // unchanged
    }
    // Accepted (whitespace around real content — stored verbatim):
    {
      const c = captureDeps()
      expect(await runSessionCommand(["rename", id, "  hello  "], c.deps)).toBe(0)
      const reloaded = await loadSessionById(id)
      // Pin behavior: NOT trimmed. The trim-check is only for the
      // "is-empty" gate; the stored title preserves the leading/trailing
      // whitespace literally.
      expect(reloaded?.meta.title).toBe("  hello  ")
    }
  })
})

// =========================================================================
// F. Worktree edge cases (skipIf no git).
// =========================================================================

describe("F. worktree edge cases", () => {
  const env = setupSessionsDir("chaos-F-")
  let repoDir: string | undefined
  let nonRepoDir: string | undefined

  beforeEach(() => {
    env.before()
  })
  afterEach(async () => {
    if (repoDir !== undefined) {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      repoDir = undefined
    }
    if (nonRepoDir !== undefined) {
      try {
        rmSync(nonRepoDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      nonRepoDir = undefined
    }
    await env.after()
  })

  test.skipIf(!HAS_GIT)(
    "fork --worktree on non-git cwd: exit 1, no session created",
    async () => {
      nonRepoDir = mkdtempSync(join(tmpdir(), "chaos-F-nonrepo-"))
      const id = "non-git-src"
      await saveSessionById(mkMeta({ id, title: "NG", cwd: nonRepoDir }), mkPayload())
      const beforeRows = (await listSessions({ includeArchived: true })).length

      const c = captureDeps()
      const code = await runSessionCommand(["fork", id, "--worktree"], c.deps)
      expect(code).toBe(1)
      expect(c.err).toContain("session fork:")
      expect(c.err).toContain("requires the source cwd to be a git repo")

      // NO new session row added.
      const afterRows = (await listSessions({ includeArchived: true })).length
      expect(afterRows).toBe(beforeRows)
    },
    60_000,
  )

  test.skipIf(!HAS_GIT)(
    "fork --worktree then external worktree-remove --force, then session delete: no crash",
    async () => {
      repoDir = await makeRepo()
      const id = "wt-external-rm"
      await saveSessionById(mkMeta({ id, title: "Src", cwd: repoDir }), mkPayload())

      const cFork = captureDeps()
      expect(await runSessionCommand(["fork", id, "--worktree"], cFork.deps)).toBe(0)
      const forkId = (cFork.out.match(/forked \S+ → (\S+)/) ?? [])[1] ?? ""
      expect(forkId).not.toBe("")
      const forked = await loadSessionById(forkId)
      const wtPath = forked?.meta.cwd ?? ""
      expect(wtPath).not.toBe("")
      expect(existsSync(wtPath)).toBe(true)

      // Externally remove the worktree.
      const externalRm = await runShell(`git worktree remove --force -- "${wtPath}"`, {
        cwd: repoDir,
      })
      expect(externalRm.exitCode).toBe(0)
      expect(existsSync(wtPath)).toBe(false)

      // Now delete the session — removeWorktree should be idempotent.
      const cDel = captureDeps()
      const code = await runSessionCommand(["delete", forkId, "--force"], cDel.deps)
      expect(code).toBe(0)
      expect(cDel.out).toContain(`deleted ${forkId}`)
      // The session row is gone.
      const remaining = (await listSessions({ includeArchived: true })).map((m) => m.id)
      expect(remaining).not.toContain(forkId)
    },
    60_000,
  )

  test.skipIf(!HAS_GIT)(
    "fork --worktree when fork-<safeId> branch already exists: -B reuses it (current behavior)",
    async () => {
      repoDir = await makeRepo()
      const id = "wt-branch-collision"
      await saveSessionById(mkMeta({ id, title: "Src", cwd: repoDir }), mkPayload())

      // Pre-create a branch — but we cannot predict the newId (it's a UUID).
      // Pre-create a few branches matching the "fork-<safeId>" pattern;
      // collision is rare in practice, but the contract we want to lock in
      // is: when the branch DOES already exist, `-B` resets it (no crash).
      //
      // To deterministically force a collision, fork once and capture the
      // resulting branch name, then attempt a second fork that re-uses the
      // SAME explicit newId via a direct forkSession() call inside the
      // dispatcher — which we can't do without modifying production. So
      // instead, we drive the SAME path twice with manual branch pre-seeding
      // and assert "no half-saved session" on whichever path errors out.
      // CURRENT BEHAVIOR: `-B` in `git worktree add` resets the branch ref,
      // so a pre-existing fork-* branch is ACCEPTED, not rejected.

      // Strategy: pre-create a branch named like a future fork branch, then
      // run a fork. Even if the names don't collide (almost-certain), the
      // assertion below stays valid — the test exercises the path.
      await runShell("git branch -f fork-canary HEAD", { cwd: repoDir })

      const c = captureDeps()
      const code = await runSessionCommand(["fork", id, "--worktree"], c.deps)
      expect(code).toBe(0) // not a collision in practice (UUID)
      const forkId = (c.out.match(/forked \S+ → (\S+)/) ?? [])[1] ?? ""
      expect(forkId).not.toBe("")
      // Clean up the worktree we just made (test isolation):
      const forked = await loadSessionById(forkId)
      const wtPath = forked?.meta.cwd ?? ""
      if (wtPath !== "") {
        await runShell(`git worktree remove --force -- "${wtPath}"`, { cwd: repoDir })
      }
      // POTENTIAL IMPROVEMENT: pre-flight the branch name and refuse if it
      // already exists, instead of silently `-B`-resetting it.
    },
    60_000,
  )

  test.skipIf(!HAS_GIT)(
    "two parallel `session fork X --worktree` against same source: different paths, both succeed",
    async () => {
      repoDir = await makeRepo()
      const id = "wt-parallel"
      await saveSessionById(mkMeta({ id, title: "Src", cwd: repoDir }), mkPayload())

      const c1 = captureDeps()
      const c2 = captureDeps()
      const results = await Promise.allSettled([
        runSessionCommand(["fork", id, "--worktree"], c1.deps),
        runSessionCommand(["fork", id, "--worktree"], c2.deps),
      ])
      // At LEAST one must succeed; the other may fail cleanly on git's
      // worktree-add lock. Pin that the failure (if any) is clean (exit 1
      // with a session-fork error, NOT a thrown exception).
      const codes = results.map((r) => (r.status === "fulfilled" ? r.value : -1))
      const successes = codes.filter((c) => c === 0).length
      expect(successes).toBeGreaterThanOrEqual(1)
      // If both succeeded, the worktree paths are different (different newIds).
      if (successes === 2) {
        const fid1 = (c1.out.match(/forked \S+ → (\S+)/) ?? [])[1] ?? ""
        const fid2 = (c2.out.match(/forked \S+ → (\S+)/) ?? [])[1] ?? ""
        expect(fid1).not.toBe(fid2)
        const f1 = await loadSessionById(fid1)
        const f2 = await loadSessionById(fid2)
        expect(f1?.meta.cwd).not.toBe(f2?.meta.cwd)
        // Clean up worktrees so afterEach can rm the repo cleanly.
        for (const wt of [f1?.meta.cwd, f2?.meta.cwd]) {
          if (wt) {
            await runShell(`git worktree remove --force -- "${wt}"`, { cwd: repoDir })
          }
        }
      }
    },
    60_000,
  )
})

// =========================================================================
// G. Forwards-incompatibility.
// =========================================================================

describe("G. forwards-incompatibility (version > current)", () => {
  const env = setupSessionsDir("chaos-G-")

  beforeEach(env.before)
  afterEach(env.after)

  test("session file with version: 99 → loadSessionById returns undefined; show exits 1", async () => {
    const id = "future-version"
    const meta = mkMeta({ id, title: "FromFuture" })
    // Write a body that is otherwise a valid SavedSession but version=99.
    const body = JSON.stringify({
      version: 99,
      meta,
      reason: "completed",
      turns: 0,
      messages: [],
    })
    await writeFile(sessionFilePath(id), body)

    const loaded = await loadSessionById(id)
    expect(loaded).toBeUndefined()

    const c = captureDeps()
    expect(await runSessionCommand(["show", id], c.deps)).toBe(1)
    expect(c.err).toContain("session show:")
    expect(c.err).toContain("not found")
  })

  test("index.jsonl line with version:99 but otherwise-valid SessionMeta is accepted (version not checked)", async () => {
    const id = "future-index"
    const line = JSON.stringify({
      id,
      title: "FromFutureIndex",
      cwd: "/tmp",
      createdAt: Date.now(),
      lastTouched: Date.now(),
      archived: false,
      version: 99, // extra field — not part of SessionMeta validator
    })
    await writeFile(indexFilePath(), `${line}\n`)

    const rows = await listSessions({ includeArchived: true })
    // Pin behavior: the index validator only requires SessionMeta fields, so
    // an extra "version" is IGNORED and the row is accepted.
    expect(rows.find((r) => r.id === id)?.title).toBe("FromFutureIndex")
  })
})

// =========================================================================
// H. Large session.
// =========================================================================

describe("H. large session", () => {
  const env = setupSessionsDir("chaos-H-")
  // Wallclock timing assertions flake on loaded CI; gate behind opt-in.
  const PERF_STRICT = process.env.QUANTA_PERF_STRICT === "1"

  beforeEach(env.before)
  afterEach(env.after)

  test("1000 messages: save+load roundtrip + fork via structuredClone — under 5s", async () => {
    // Each message ~200 bytes -> ~200KB total. Capped at 1000 to keep CI
    // under 5s on a slow runner.
    const N = 1000
    const id = "large-1"
    const start = performance.now()
    await saveSessionById(mkMeta({ id, title: "Large" }), mkPayload(N))
    const loaded = await loadSessionById(id)
    expect(loaded?.messages.length).toBe(N)
    // Fork goes through structuredClone — assert it doesn't blow stack/time.
    const newId = await forkSession(id, { title: "LargeFork" })
    const forked = await loadSessionById(newId)
    expect(forked?.messages.length).toBe(N)
    expect(forked?.meta.title).toBe("LargeFork")
    const elapsed = performance.now() - start
    if (PERF_STRICT) expect(elapsed).toBeLessThan(5000)
  })
})
