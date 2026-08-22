/**
 * `@/ipc#exportSession` / `importSession` — portable v1 round-trip + schema.
 *
 * Each test scopes a throwaway `QUANTA_SESSIONS_DIR` so the on-disk store is
 * test-isolated.
 *
 * Covered:
 *   1. Empty (0-message) session round-trips identically.
 *   2. 1-turn session export carries reason / turns / messages.
 *   3. `exportSession` on a missing id returns `undefined`.
 *   4. `importSession` mints a fresh id by default.
 *   5. `importSession` honors `opts.newId`.
 *   6. Portable shape conforms to the v1 schema (snake_case, version=1).
 *   7. Git-fingerprint fields round-trip when present.
 *   8. Git-fingerprint fields are OMITTED (no `git_sha: undefined`) when absent.
 *   9. Malformed portable rejected with typed error: not_an_object, schema_mismatch,
 *      version_unsupported, meta_invalid, messages_invalid.
 *  10. Imported session is loadable via `loadSessionById` and matches the input.
 *  11. `titlePrefix` is applied when provided.
 *  12. Imported session lands in active state (archived=false) even when source
 *      was archived.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  exportSession,
  importSession,
  PORTABLE_SESSION_VERSION,
  PortableSessionImportError,
  type PortableSessionV1,
  parsePortableSession,
} from "@/ipc"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/* ------------------------------------------------------------------ */
/* Test scaffolding.                                                    */
/* ------------------------------------------------------------------ */

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: "src-1",
  title: "source session",
  cwd: "/tmp/x",
  createdAt: 1_700_000_000_000,
  lastTouched: 1_700_000_001_000,
  archived: false,
  ...overrides,
})

describe("@/ipc session export/import", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "ipc-session-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  /* -------------------------- export ---------------------------- */

  test("export: empty session round-trips", async () => {
    await saveSessionById(mkMeta(), { reason: "fresh", turns: 0, messages: [] })
    const portable = await exportSession("src-1")
    expect(portable).toBeDefined()
    expect(portable?.schema).toBe("quanta.session.portable")
    expect(portable?.version).toBe(PORTABLE_SESSION_VERSION)
    expect(portable?.meta.id).toBe("src-1")
    expect(portable?.reason).toBe("fresh")
    expect(portable?.turns).toBe(0)
    expect(portable?.messages.length).toBe(0)
  })

  test("export: 1-turn session carries reason / turns / messages", async () => {
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }]
    await saveSessionById(mkMeta(), { reason: "user_done", turns: 1, messages })
    const portable = await exportSession("src-1")
    expect(portable?.turns).toBe(1)
    expect(portable?.reason).toBe("user_done")
    expect(portable?.messages).toEqual(messages)
  })

  test("export: missing id returns undefined", async () => {
    const portable = await exportSession("nonexistent")
    expect(portable).toBeUndefined()
  })

  test("export: git-fingerprint fields round-trip through metaToPortable mapper", async () => {
    // NOTE: the session store's zod schema strips optional git_* fields on
    // load (pre-existing constraint). We assert the mapper is correct by
    // calling `metaToPortable` directly — that proves the export side
    // wire-format is right; storage-side preservation is a separate slice's
    // concern.
    const { metaToPortable } = await import("@/ipc")
    const portable = metaToPortable(
      mkMeta({
        gitSha: "deadbeef",
        gitBranch: "main",
        gitOriginUrl: "git@github.com:x/y.git",
      }),
    )
    expect(portable.git_sha).toBe("deadbeef")
    expect(portable.git_branch).toBe("main")
    expect(portable.git_origin_url).toBe("git@github.com:x/y.git")
  })

  test("export: git-fingerprint fields are OMITTED when absent (no undefined keys)", async () => {
    await saveSessionById(mkMeta(), { reason: "x", turns: 0, messages: [] })
    const portable = await exportSession("src-1")
    expect("git_sha" in (portable?.meta ?? {})).toBe(false)
    expect("git_branch" in (portable?.meta ?? {})).toBe(false)
    expect("git_origin_url" in (portable?.meta ?? {})).toBe(false)
  })

  test("export: git-fingerprint fields survive the real session store round-trip", async () => {
    await saveSessionById(
      mkMeta({
        gitSha: "deadbeef",
        gitBranch: "main",
        gitOriginUrl: "git@github.com:x/y.git",
      }),
      { reason: "x", turns: 0, messages: [] },
    )
    const portable = await exportSession("src-1")
    expect(portable?.meta.git_sha).toBe("deadbeef")
    expect(portable?.meta.git_branch).toBe("main")
    expect(portable?.meta.git_origin_url).toBe("git@github.com:x/y.git")
  })

  /* -------------------------- import ---------------------------- */

  test("import: mints fresh id by default", async () => {
    await saveSessionById(mkMeta(), { reason: "x", turns: 1, messages: [] })
    const portable = (await exportSession("src-1")) as PortableSessionV1
    const newMeta = await importSession(portable)
    expect(newMeta.id).not.toBe("src-1")
    expect(newMeta.id.length).toBeGreaterThan(0)
  })

  test("import: honors opts.newId", async () => {
    await saveSessionById(mkMeta(), { reason: "x", turns: 1, messages: [] })
    const portable = (await exportSession("src-1")) as PortableSessionV1
    const newMeta = await importSession(portable, { newId: "imported-1" })
    expect(newMeta.id).toBe("imported-1")
  })

  test("import: imported session loads with the same reason / turns / messages", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ]
    await saveSessionById(mkMeta(), { reason: "done", turns: 2, messages })
    const portable = (await exportSession("src-1")) as PortableSessionV1
    const newMeta = await importSession(portable, { newId: "imp-1" })
    const loaded = await loadSessionById(newMeta.id)
    expect(loaded).toBeDefined()
    expect(loaded?.reason).toBe("done")
    expect(loaded?.turns).toBe(2)
    expect(loaded?.messages).toEqual(messages)
  })

  test("import: titlePrefix is applied when provided", async () => {
    await saveSessionById(mkMeta({ title: "orig" }), {
      reason: "x",
      turns: 0,
      messages: [],
    })
    const portable = (await exportSession("src-1")) as PortableSessionV1
    const newMeta = await importSession(portable, {
      newId: "imp-2",
      titlePrefix: "[copy] ",
    })
    expect(newMeta.title).toBe("[copy] orig")
  })

  test("import: lands in active state even if source was archived", async () => {
    await saveSessionById(mkMeta({ archived: true }), {
      reason: "x",
      turns: 0,
      messages: [],
    })
    // exportSession can find archived sessions via loadSessionById; just craft
    // a portable blob manually to mimic the round-trip.
    const portable: PortableSessionV1 = {
      schema: "quanta.session.portable",
      version: PORTABLE_SESSION_VERSION,
      meta: {
        id: "src-1",
        title: "t",
        cwd: "/tmp/x",
        created_at: 1,
        last_touched: 2,
        archived: true,
      },
      reason: "x",
      turns: 0,
      messages: [],
    }
    const newMeta = await importSession(portable, { newId: "imp-3" })
    expect(newMeta.archived).toBe(false)
  })

  test("import: git-fingerprint fields persist onto the imported session meta", async () => {
    const portable: PortableSessionV1 = {
      schema: "quanta.session.portable",
      version: PORTABLE_SESSION_VERSION,
      meta: {
        id: "src-1",
        title: "t",
        cwd: "/tmp/x",
        created_at: 1,
        last_touched: 2,
        archived: false,
        git_sha: "cafefeed",
        git_branch: "feat/import",
        git_origin_url: "git@github.com:x/y.git",
      },
      reason: "x",
      turns: 0,
      messages: [],
    }
    const newMeta = await importSession(portable, { newId: "imp-git" })
    expect(newMeta.gitSha).toBe("cafefeed")
    expect(newMeta.gitBranch).toBe("feat/import")
    expect(newMeta.gitOriginUrl).toBe("git@github.com:x/y.git")
    const loaded = await loadSessionById("imp-git")
    expect(loaded?.meta.gitSha).toBe("cafefeed")
    expect(loaded?.meta.gitBranch).toBe("feat/import")
    expect(loaded?.meta.gitOriginUrl).toBe("git@github.com:x/y.git")
  })

  /* -------------------------- schema --------------------------- */

  test("portable shape uses snake_case and version literal 1", async () => {
    await saveSessionById(mkMeta(), { reason: "x", turns: 0, messages: [] })
    const portable = (await exportSession("src-1")) as PortableSessionV1
    expect(portable.schema).toBe("quanta.session.portable")
    expect(portable.version).toBe(1)
    expect(portable.meta.created_at).toBe(1_700_000_000_000)
    expect(portable.meta.last_touched).toBeGreaterThanOrEqual(1_700_000_001_000)
    // snake_case wire — no camelCase key leaks.
    expect("createdAt" in portable.meta).toBe(false)
    expect("lastTouched" in portable.meta).toBe(false)
    expect("gitSha" in portable.meta).toBe(false)
  })

  /* ------------------ malformed parse rejection ----------------- */

  test("parsePortableSession: rejects non-object", () => {
    try {
      parsePortableSession(null)
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(PortableSessionImportError)
      expect((err as PortableSessionImportError).kind).toBe("not_an_object")
    }
  })

  test("parsePortableSession: rejects schema mismatch", () => {
    try {
      parsePortableSession({ schema: "other", version: 1 })
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as PortableSessionImportError).kind).toBe("schema_mismatch")
    }
  })

  test("parsePortableSession: rejects unsupported version", () => {
    try {
      parsePortableSession({
        schema: "quanta.session.portable",
        version: 999,
      })
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as PortableSessionImportError).kind).toBe("version_unsupported")
    }
  })

  test("parsePortableSession: rejects invalid meta (missing cwd)", () => {
    try {
      parsePortableSession({
        schema: "quanta.session.portable",
        version: PORTABLE_SESSION_VERSION,
        meta: {
          id: "x",
          title: "x",
          created_at: 1,
          last_touched: 2,
          archived: false,
        },
        reason: "x",
        turns: 0,
        messages: [],
      })
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as PortableSessionImportError).kind).toBe("meta_invalid")
    }
  })

  test("parsePortableSession: rejects non-array messages", () => {
    try {
      parsePortableSession({
        schema: "quanta.session.portable",
        version: PORTABLE_SESSION_VERSION,
        meta: {
          id: "x",
          title: "x",
          cwd: "/",
          created_at: 1,
          last_touched: 2,
          archived: false,
        },
        reason: "x",
        turns: 0,
        messages: "not an array",
      })
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as PortableSessionImportError).kind).toBe("messages_invalid")
    }
  })
})
