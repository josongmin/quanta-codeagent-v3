import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import {
  archiveSession,
  forkSession,
  listSessions,
  loadSessionById,
  renameSession,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
  unarchiveSession,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * Fork-lineage persistence (jun-06 RFC `forked_from_id`). `forkSession` holds the
 * source id at the moment it mints the child meta; this slice stops discarding it.
 * One optional field on `SessionMeta` + the persisted (non-strict) zod schema +
 * one assignment. Always-on additive metadata — NO knob: absence IS the default-OFF
 * (legacy + non-fork files simply omit the field and stay byte-compatible).
 */

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-1",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
  ...overrides,
})

const mkPayload = (overrides: Partial<SavePayload> = {}): SavePayload => ({
  reason: overrides.reason ?? "completed",
  turns: overrides.turns ?? 1,
  messages: overrides.messages ?? [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
})

describe("forked-from-id persistence — hellgate", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "forked-from-id-"))
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

  // §6.1 Round-trip: forkSession writes forkedFromId=parent.id; survives store read.
  test("forkSession persists forkedFromId = parent id, round-trips through store read", async () => {
    await saveSessionById(mkMeta({ id: "parent-1", title: "P" }), mkPayload())
    const childId = await forkSession("parent-1")
    const child = await loadSessionById(childId)
    expect(child?.meta.forkedFromId).toBe("parent-1")
  })

  // The lineage must also survive into the derived index listing (upsertMeta
  // persists the whole meta; an additive optional field carries through).
  test("forkedFromId is preserved in the index listing", async () => {
    await saveSessionById(mkMeta({ id: "parent-ix" }), mkPayload())
    const childId = await forkSession("parent-ix")
    const indexed = (await listSessions({ includeArchived: true })).find((m) => m.id === childId)
    expect(indexed?.forkedFromId).toBe("parent-ix")
  })

  test("forkSession honors a custom newId while still recording the parent", async () => {
    await saveSessionById(mkMeta({ id: "parent-c", title: "PC" }), mkPayload())
    const returned = await forkSession("parent-c", { newId: "child-c", title: "renamed at fork" })
    expect(returned).toBe("child-c")
    const child = await loadSessionById("child-c")
    // The cosmetic title may diverge; the persisted lineage id must not.
    expect(child?.meta.title).toBe("renamed at fork")
    expect(child?.meta.forkedFromId).toBe("parent-c")
  })

  // §6.2 Back-compat (load-bearing): a legacy SavedSession JSON with NO
  // forkedFromId parses cleanly through the augmented non-strict schema; the
  // field is undefined, no rejection.
  test("legacy transcript WITHOUT forkedFromId loads fine (back-compat, no field)", async () => {
    const legacy = {
      version: 2,
      meta: {
        id: "legacy-1",
        title: "old",
        cwd: "/tmp/work",
        createdAt: 1,
        lastTouched: 1,
        archived: false,
        // intentionally NO forkedFromId — minted before the field existed
      },
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    writeFileSync(sessionFilePath("legacy-1"), JSON.stringify(legacy))
    const loaded = await loadSessionById("legacy-1")
    expect(loaded).toBeDefined()
    expect(loaded?.meta.id).toBe("legacy-1")
    expect(loaded?.meta.forkedFromId).toBeUndefined()
  })

  // §6.3 Non-fork session has NO field — absent, not null/"". Assert the written
  // JSON does not contain the key (byte-shape unchanged for non-forks).
  test("non-fork session omits forkedFromId entirely (absent key, not null/empty)", async () => {
    await saveSessionById(mkMeta({ id: "plain-1" }), mkPayload())
    const loaded = await loadSessionById("plain-1")
    expect(loaded?.meta.forkedFromId).toBeUndefined()
    // The on-disk JSON must not carry the key at all (back-compat byte shape).
    const raw = readFileSync(sessionFilePath("plain-1"), "utf8")
    expect(raw.includes("forkedFromId")).toBe(false)
    expect("forkedFromId" in (loaded?.meta ?? {})).toBe(false)
  })

  // §6.4 Survives rename + archive/unarchive (the {...existing.meta} spreads
  // carry it through untouched).
  test("forkedFromId survives renameSession", async () => {
    await saveSessionById(mkMeta({ id: "parent-r" }), mkPayload())
    const childId = await forkSession("parent-r")
    await renameSession(childId, "a brand new title")
    const child = await loadSessionById(childId)
    expect(child?.meta.title).toBe("a brand new title")
    expect(child?.meta.forkedFromId).toBe("parent-r")
  })

  test("forkedFromId survives archive + unarchive round-trip", async () => {
    await saveSessionById(mkMeta({ id: "parent-a" }), mkPayload())
    const childId = await forkSession("parent-a")
    await archiveSession(childId)
    expect((await loadSessionById(childId))?.meta.forkedFromId).toBe("parent-a")
    await unarchiveSession(childId)
    expect((await loadSessionById(childId))?.meta.forkedFromId).toBe("parent-a")
  })

  // §6.5 Chain A→B→C: each link records only its IMMEDIATE parent.
  test("fork chain A→B→C records each link's immediate parent only", async () => {
    await saveSessionById(mkMeta({ id: "A" }), mkPayload())
    const b = await forkSession("A", { newId: "B" })
    const c = await forkSession("B", { newId: "C" })
    expect((await loadSessionById(c))?.meta.forkedFromId).toBe("B")
    expect((await loadSessionById(b))?.meta.forkedFromId).toBe("A")
    // A is the root — no parent.
    expect((await loadSessionById("A"))?.meta.forkedFromId).toBeUndefined()
  })

  // §6.6 min(1) guard: a forged JSON with forkedFromId:"" is rejected by the
  // schema (mirrors the git-fingerprint optionals' NonEmptyString discipline).
  test("forged transcript with empty-string forkedFromId is REFUSED (min(1) guard)", async () => {
    const forged = {
      version: 2,
      meta: {
        id: "forged-1",
        title: "x",
        cwd: "/tmp/work",
        createdAt: 1,
        lastTouched: 1,
        archived: false,
        forkedFromId: "", // violates .min(1)
      },
      reason: "completed",
      turns: 0,
      messages: [],
    }
    writeFileSync(sessionFilePath("forged-1"), JSON.stringify(forged))
    expect(await loadSessionById("forged-1")).toBeUndefined()
  })

  // The deep-copy invariant of forkSession must not be disturbed: a forked child
  // carrying lineage is still mutation-isolated from its source.
  test("fork with lineage is still deep-copied (source untouched by child mutation)", async () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "orig" }] }]
    await saveSessionById(mkMeta({ id: "src-iso" }), mkPayload({ messages }))
    const childId = await forkSession("src-iso")
    const child = await loadSessionById(childId)
    if (!child) throw new Error("fork not loadable")
    child.messages.push({ role: "user", content: [{ type: "text", text: "TAMPER" }] })
    await saveSessionById(child.meta, {
      reason: "x",
      turns: child.turns + 1,
      messages: child.messages,
    })
    const src = await loadSessionById("src-iso")
    expect(src?.messages).toHaveLength(1)
    expect(child.meta.forkedFromId).toBe("src-iso")
  })
})
