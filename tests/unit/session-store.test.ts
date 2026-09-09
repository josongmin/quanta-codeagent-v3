import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { createObjectiveStore } from "@/objective"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"
import {
  appendEnvelope,
  appendRollbackIntent,
  appendRollbackTerminal,
  archivedFilePath,
  archiveSession,
  deleteSession,
  forkSession,
  latestOperation,
  listSessions,
  loadSessionById,
  pendingOperationIds,
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  type RollbackOperationRecord,
  renameSession,
  resolveCheckpointForTurn,
  rewindToMessage,
  type SavePayload,
  SESSION_ENVELOPE_VERSION,
  SessionIdError,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
  staticSessionRootProvider,
  unarchiveSession,
  upsertRollbackCheckpoint,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-1",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

const mkPayload = (overrides: Partial<SavePayload> = {}): SavePayload => ({
  reason: overrides.reason ?? "completed",
  turns: overrides.turns ?? 1,
  messages: overrides.messages ?? [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
})

describe("session store", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-store-"))
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

  test("saveSessionById + loadSessionById roundtrip", async () => {
    const meta = mkMeta({ id: "rt-1", title: "round" })
    const payload = mkPayload()
    await saveSessionById(meta, payload)
    const loaded = await loadSessionById("rt-1")
    expect(loaded).toBeDefined()
    expect(loaded?.meta.id).toBe("rt-1")
    expect(loaded?.meta.title).toBe("round")
    expect(loaded?.reason).toBe("completed")
    expect(loaded?.turns).toBe(1)
    expect(loaded?.messages).toEqual(payload.messages)
    // lastTouched is bumped to now
    expect(loaded?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(meta.createdAt)
    // Index is also updated as part of the same save (paired write contract).
    const list = await listSessions()
    expect(list.map((m) => m.id)).toContain("rt-1")
  })

  test("loadSessionById finds an archived file", async () => {
    const meta = mkMeta({ id: "arc-1", archived: true })
    await saveSessionById(meta, mkPayload())
    // Active path is empty; archived path has the file.
    expect(existsSync(sessionFilePath("arc-1"))).toBe(false)
    expect(existsSync(archivedFilePath("arc-1"))).toBe(true)
    const loaded = await loadSessionById("arc-1")
    expect(loaded?.meta.id).toBe("arc-1")
    expect(loaded?.meta.archived).toBe(true)
  })

  test("loadSessionById returns undefined for missing id", async () => {
    expect(await loadSessionById("nope")).toBeUndefined()
  })

  test("archiveSession moves the file and sets the flag", async () => {
    await saveSessionById(mkMeta({ id: "a1" }), mkPayload())
    expect(existsSync(sessionFilePath("a1"))).toBe(true)
    await archiveSession("a1")
    expect(existsSync(sessionFilePath("a1"))).toBe(false)
    expect(existsSync(archivedFilePath("a1"))).toBe(true)
    const loaded = await loadSessionById("a1")
    expect(loaded?.meta.archived).toBe(true)
    // listSessions hides it by default
    expect((await listSessions()).map((m) => m.id)).not.toContain("a1")
    expect((await listSessions({ includeArchived: true })).map((m) => m.id)).toContain("a1")
  })

  test("archiveSession is idempotent on already-archived", async () => {
    await saveSessionById(mkMeta({ id: "a2" }), mkPayload())
    await archiveSession("a2")
    await archiveSession("a2") // no throw
    const loaded = await loadSessionById("a2")
    expect(loaded?.meta.archived).toBe(true)
  })

  test("unarchiveSession reverses archive", async () => {
    await saveSessionById(mkMeta({ id: "u1" }), mkPayload())
    await archiveSession("u1")
    await unarchiveSession("u1")
    expect(existsSync(sessionFilePath("u1"))).toBe(true)
    expect(existsSync(archivedFilePath("u1"))).toBe(false)
    const loaded = await loadSessionById("u1")
    expect(loaded?.meta.archived).toBe(false)
  })

  test("renameSession updates title and lastTouched", async () => {
    const meta = mkMeta({ id: "r1", title: "old", lastTouched: 50 })
    await saveSessionById(meta, mkPayload())
    const before = await loadSessionById("r1")
    const tsBefore = before?.meta.lastTouched ?? 0
    // small delay to ensure lastTouched advances
    await new Promise((r) => setTimeout(r, 5))
    await renameSession("r1", "new")
    const after = await loadSessionById("r1")
    expect(after?.meta.title).toBe("new")
    expect(after?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(tsBefore)
  })

  test("renameSession is a no-op on missing id", async () => {
    await renameSession("missing", "x") // no throw
    expect(await loadSessionById("missing")).toBeUndefined()
  })

  test("forkSession: new id, copied messages, fresh timestamps, default title", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q" }] },
      { role: "assistant", content: [{ type: "text", text: "A" }] },
    ]
    const sourceMeta = mkMeta({ id: "src", title: "Source", createdAt: 100, lastTouched: 100 })
    await saveSessionById(sourceMeta, mkPayload({ messages }))

    const beforeFork = Date.now()
    const newId = await forkSession("src")
    expect(typeof newId).toBe("string")
    expect(newId).not.toBe("src")

    const forked = await loadSessionById(newId)
    expect(forked).toBeDefined()
    expect(forked?.meta.title).toBe("Source (fork)")
    expect(forked?.messages).toEqual(messages)
    expect(forked?.meta.createdAt ?? 0).toBeGreaterThanOrEqual(beforeFork)
    expect(forked?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(beforeFork)
    expect(forked?.meta.archived).toBe(false)
    expect(forked?.meta.cwd).toBe(sourceMeta.cwd)
  })

  test("forkSession honors custom newId / title / cwd", async () => {
    await saveSessionById(mkMeta({ id: "src2", title: "S2" }), mkPayload())
    const returned = await forkSession("src2", {
      newId: "custom-id",
      title: "custom title",
      cwd: "/elsewhere",
    })
    expect(returned).toBe("custom-id")
    const forked = await loadSessionById("custom-id")
    expect(forked?.meta.title).toBe("custom title")
    expect(forked?.meta.cwd).toBe("/elsewhere")
  })

  test("forkSession explicitly recreates a deleted custom destination generation", async () => {
    await saveSessionById(mkMeta({ id: "fork-source" }), mkPayload())
    await saveSessionById(mkMeta({ id: "fork-destination" }), mkPayload(), undefined, {
      create: true,
    })
    await deleteSession("fork-destination")

    await forkSession("fork-source", { newId: "fork-destination" })

    expect((await loadSessionById("fork-destination"))?.meta.forkedFromId).toBe("fork-source")
  })

  test("forkSession creates a paused objective generation without progress evidence", async () => {
    const objective = createObjectiveStore()
    const sourceObjective = objective.create("src-goal", {
      goal: "ship",
      successCriteria: ["tests pass"],
      budget: { maxTurns: 5 },
    })
    objective.addBlocker("src-goal", { reason: "waiting", waitingOn: "user" })
    await saveSessionById(mkMeta({ id: "src-goal" }), {
      ...mkPayload(),
      objective: encodeObjectiveSnapshot(objective),
    })

    await forkSession("src-goal", { newId: "fork-goal" })
    const forked = await loadSessionById("fork-goal")
    const thread = forked?.objective?.threads[0]
    const body = thread !== undefined && "objective" in thread ? thread.objective : undefined
    expect(thread?.threadId).toBe("fork-goal")
    expect(body?.objectiveId).not.toBe(sourceObjective?.objectiveId)
    expect(body?.status).toBe("paused")
    expect(body?.explicitStatus).toBe("paused")
    expect(body?.successCriteria[0]?.met).toBe(false)
    expect(body?.successCriteria[0]?.completion).toBeUndefined()
    expect(body?.blockers).toEqual([])
    expect(body?.budget).toMatchObject({ maxTurns: 5, turnsUsed: 0, tokensUsed: 0 })
    expect(body?.progressReceipts).toBeUndefined()
    expect(body?.attempts).toEqual({ autonomousTurnsStarted: 0 })
  })

  test("forkSession deep-copies messages so the fork can be mutated independently", async () => {
    // The prior version of this test asserted equality but never mutated the
    // fork's messages — it could pass with a SHALLOW copy (or even
    // referentially-shared) array. The deep-copy invariant matters because the
    // agent loop will push into `session.messages` in-place after a fork; if
    // the source array were the same reference, a subsequent runAgent on the
    // fork would silently rewrite the source's persisted history.
    const sourceMeta = mkMeta({ id: "imm", title: "ImmSource", createdAt: 100, lastTouched: 100 })
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    await saveSessionById(sourceMeta, mkPayload({ messages }))
    const sourceBefore = await loadSessionById("imm")
    const originalLen = sourceBefore?.messages.length ?? 0

    const newId = await forkSession("imm")
    const fork = await loadSessionById(newId)
    if (!fork) throw new Error("forkSession did not return a loadable fork")
    // Mutate the fork's in-memory array AND persist — this is the realistic
    // shape (the agent loop loads, appends, saves). After the save, the source
    // file must still hold the original transcript.
    fork.messages.push({ role: "user", content: [{ type: "text", text: "TAMPER" }] })
    await saveSessionById(fork.meta, {
      reason: "test-mutated",
      turns: fork.turns + 1,
      messages: fork.messages,
    })

    const reloaded = await loadSessionById("imm")
    expect(reloaded?.messages).toHaveLength(originalLen)
    expect(
      reloaded?.messages.some((m) =>
        m.content.some((b) => b.type === "text" && b.text === "TAMPER"),
      ),
    ).toBe(false)

    // Source meta also unchanged (no incidental lastTouched bump from fork).
    expect(reloaded?.meta.title).toBe(sourceBefore?.meta.title)
    expect(reloaded?.meta.createdAt).toBe(sourceBefore?.meta.createdAt)
    expect(reloaded?.meta.lastTouched).toBe(sourceBefore?.meta.lastTouched)
  })

  test("forkSession throws on missing source", async () => {
    await expect(forkSession("ghost")).rejects.toThrow(/not found/)
  })

  test("deleteSession removes file and index entry", async () => {
    await saveSessionById(mkMeta({ id: "d1" }), mkPayload())
    expect(existsSync(sessionFilePath("d1"))).toBe(true)
    await deleteSession("d1")
    expect(existsSync(sessionFilePath("d1"))).toBe(false)
    expect(existsSync(archivedFilePath("d1"))).toBe(false)
    expect((await listSessions({ includeArchived: true })).map((m) => m.id)).not.toContain("d1")
    expect(await loadSessionById("d1")).toBeUndefined()
  })

  test("deleteSession also clears an archived file", async () => {
    await saveSessionById(mkMeta({ id: "d2" }), mkPayload())
    await archiveSession("d2")
    expect(existsSync(archivedFilePath("d2"))).toBe(true)
    await deleteSession("d2")
    expect(existsSync(archivedFilePath("d2"))).toBe(false)
  })

  test("ops are idempotent / no-throw on missing ids", async () => {
    await archiveSession("missing")
    await unarchiveSession("missing")
    await renameSession("missing", "x")
    await deleteSession("missing")
    expect(await loadSessionById("missing")).toBeUndefined()
  })

  // Audit Round 3 §C — corrupt-on-disk inputs must NEVER throw out of loadSessionById.
  test("loadSessionById returns undefined for a corrupt V2 file (no throw)", async () => {
    // Plant deliberately-broken JSON at the per-id path. loadSessionById is
    // contractually best-effort: a torn / partially-written file must surface
    // as `undefined`, not propagate a SyntaxError up into the CLI dispatcher.
    writeFileSync(sessionFilePath("corrupt-1"), "{this is not json")
    const loaded = await loadSessionById("corrupt-1")
    expect(loaded).toBeUndefined()
  })

  test("loadSessionById returns undefined for a wrong-version file", async () => {
    // Forward-compat guard: a future V99 schema MUST be ignored by the V2
    // reader (return undefined) instead of being half-parsed into a wrong-
    // shape SavedSession. Otherwise a downgrade-then-upgrade cycle could
    // surface a typed-but-incoherent session to callers.
    const wrong = {
      version: 99,
      meta: mkMeta({ id: "wrongver" }),
      reason: "x",
      turns: 0,
      messages: [],
    }
    writeFileSync(sessionFilePath("wrongver"), JSON.stringify(wrong))
    expect(await loadSessionById("wrongver")).toBeUndefined()
  })

  test("concurrent saveSessionById same id: file ends whole, one payload wins", async () => {
    // Documented concurrency model (index-store.ts:11-15): single CLI process
    // per user, last-writer-wins. Per-id JSON is "never affected (each id is
    // its own file)". In practice, two parallel saves share the same
    // `<id>.json.tmp` staging path, so one rename can lose the file out from
    // under the other and throw ENOENT — that's a known surface of the
    // last-writer-wins contract. We pin the OBSERVABLE invariant: regardless
    // of whether both saves succeed or one throws, the final on-disk file is
    // EXACTLY one of the two payloads (never half-merged, never torn).
    const meta1 = mkMeta({ id: "concur" })
    const payload1 = mkPayload({ reason: "A", turns: 1 })
    const payload2 = mkPayload({ reason: "B", turns: 2 })
    const results = await Promise.allSettled([
      saveSessionById(meta1, payload1),
      saveSessionById({ ...meta1 }, payload2),
    ])
    // At least one must succeed (otherwise nothing was written).
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    const loaded = await loadSessionById("concur")
    expect(loaded).toBeDefined()
    // EXACTLY one of the two payloads - never a fusion.
    const reasonOk = loaded?.reason === "A" || loaded?.reason === "B"
    expect(reasonOk).toBe(true)
    // And the turns field must match its payload (no cross-merge).
    if (loaded?.reason === "A") expect(loaded.turns).toBe(1)
    if (loaded?.reason === "B") expect(loaded.turns).toBe(2)
  })

  test("saveSessionById with meta.archived=true lands in the archived path", async () => {
    // When a caller stamps archived=true directly on the meta, the save MUST
    // route to <root>/archived/<id>.json — the active path stays empty.
    const meta = mkMeta({ id: "sav-arc", archived: true })
    await saveSessionById(meta, mkPayload())
    expect(existsSync(sessionFilePath("sav-arc"))).toBe(false)
    expect(existsSync(archivedFilePath("sav-arc"))).toBe(true)
    const loaded = await loadSessionById("sav-arc")
    expect(loaded?.meta.archived).toBe(true)
  })
})

/**
 * Resume-fidelity: the on-load `savedSessionSchema` must be LOSSLESS w.r.t. the
 * full `ContentBlock` union. A field stripped here is silently lost on resume;
 * a block variant omitted makes a *valid* session refuse to load entirely.
 */
describe("session store — content-block round-trip fidelity", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv
  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-fidelity-"))
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

  test("preserves TextBlock.phase, ThinkingBlock.signature/redacted, and ImageBlock", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", data: "QkFTRTY0", mediaType: "image/png" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoned", signature: "sig-abc" },
          { type: "thinking", thinking: "ciphertext", redacted: true },
          { type: "text", text: "let me act", phase: "commentary" },
          { type: "tool_use", id: "tu1", name: "bash", input: { cmd: "ls" } },
          { type: "text", text: "done", phase: "final_answer" },
        ],
      },
    ]
    const meta = mkMeta({ id: "fidelity-1" })
    await saveSessionById(meta, { reason: "ok", turns: 1, messages })
    const loaded = await loadSessionById("fidelity-1")
    expect(loaded).toBeDefined()
    // Lossless: reloaded messages must deep-equal what we wrote.
    expect(loaded?.messages).toEqual(messages)
  })

  test("a session containing an ImageBlock still LOADS (not refused)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "image", data: "QQ==", mediaType: "image/jpeg" }] },
    ]
    await saveSessionById(mkMeta({ id: "img-load" }), { reason: "ok", turns: 1, messages })
    const loaded = await loadSessionById("img-load")
    expect(loaded?.messages.length).toBe(1)
  })
})

/**
 * Crash-window self-heal: the per-id JSON is written FIRST, the index SECOND.
 * If the index is stale/absent (simulating a crash in that window), the next
 * `loadSessionById` must reconcile it back so `listSessions` sees the session.
 */
describe("session store — index reconcile on load", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv
  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-reconcile-"))
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

  test("load re-adds a session whose index line was lost mid-write", async () => {
    await saveSessionById(mkMeta({ id: "heal-1", title: "Healed" }), mkPayload())
    // Crash after JSON write, empty index sidecar. SEP7-D-06: list recovers
    // from the snapshot (index is a projection). Load still returns the session.
    writeFileSync(join(dir, "index.jsonl"), "")
    expect((await listSessions()).some((m) => m.id === "heal-1")).toBe(true)
    const loaded = await loadSessionById("heal-1")
    expect(loaded?.meta.title).toBe("Healed")
    expect((await listSessions()).some((m) => m.id === "heal-1")).toBe(true)
  })
})

describe("session store — git/provider regressions", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-provider-"))
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

  test("save/load + index preserve git fingerprint fields", async () => {
    const meta: SessionMeta = {
      id: "git-rt",
      title: "git",
      cwd: "/tmp/work",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
      gitSha: "deadbeef",
      gitBranch: "feat/session-root",
      gitOriginUrl: "git@github.com:acme/quanta.git",
    }
    await saveSessionById(meta, mkPayload())

    const loaded = await loadSessionById("git-rt")
    expect(loaded?.meta.gitSha).toBe("deadbeef")
    expect(loaded?.meta.gitBranch).toBe("feat/session-root")
    expect(loaded?.meta.gitOriginUrl).toBe("git@github.com:acme/quanta.git")

    const indexed = (await listSessions({ includeArchived: true })).find((m) => m.id === "git-rt")
    expect(indexed?.gitSha).toBe("deadbeef")
    expect(indexed?.gitBranch).toBe("feat/session-root")
    expect(indexed?.gitOriginUrl).toBe("git@github.com:acme/quanta.git")
  })

  test("appendEnvelope rejects traversal ids on the JSONL rail", async () => {
    await expect(
      appendEnvelope("../escape", {
        type: "event_msg",
        schema_version: SESSION_ENVELOPE_VERSION,
        ts: new Date(0).toISOString(),
        turn_id: "t-1",
        kind: "token_count",
        input_tokens: 1,
        output_tokens: 2,
      }),
    ).rejects.toThrow(SessionIdError)
  })

  test("provider-aware mutators and index ops stay inside the injected root", async () => {
    const provider = staticSessionRootProvider(join(dir, "tenant-root"))
    const meta: SessionMeta = {
      id: "tenant-1",
      title: "tenant title",
      cwd: "/tmp/work",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
      gitBranch: "feat/tenant",
    }
    await saveSessionById(meta, mkPayload(), provider)

    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
    expect(await loadSessionById("tenant-1")).toBeUndefined()
    expect((await listSessions()).map((m) => m.id)).not.toContain("tenant-1")
    expect((await listSessions(undefined, provider)).map((m) => m.id)).toContain("tenant-1")

    await renameSession("tenant-1", "renamed", provider)
    await archiveSession("tenant-1", provider)
    expect((await listSessions(undefined, provider)).map((m) => m.id)).not.toContain("tenant-1")
    expect((await listSessions({ includeArchived: true }, provider)).map((m) => m.id)).toContain(
      "tenant-1",
    )

    await unarchiveSession("tenant-1", provider)
    const reloaded = await loadSessionById("tenant-1", provider)
    expect(reloaded?.meta.title).toBe("renamed")
    expect(reloaded?.meta.gitBranch).toBe("feat/tenant")

    await deleteSession("tenant-1", provider)
    expect(await loadSessionById("tenant-1", provider)).toBeUndefined()
    expect(
      (await listSessions({ includeArchived: true }, provider)).map((m) => m.id),
    ).not.toContain("tenant-1")
  })

  test("delete generation is isolated between provider roots with the same session id", async () => {
    const providerA = staticSessionRootProvider(join(dir, "tenant-a"))
    const providerB = staticSessionRootProvider(join(dir, "tenant-b"))
    const meta = mkMeta({ id: "shared-id" })
    await saveSessionById(meta, mkPayload(), providerA, { create: true })
    await saveSessionById(meta, mkPayload(), providerB, { create: true })

    await deleteSession(meta.id, providerA)
    await saveSessionById(meta, mkPayload({ turns: 2 }), providerB)

    expect(await loadSessionById(meta.id, providerA)).toBeUndefined()
    expect((await loadSessionById(meta.id, providerB))?.turns).toBe(2)
  })

  test("rewindToMessage honors provider-scoped storage", async () => {
    const provider = staticSessionRootProvider(join(dir, "tenant-rewind"))
    await saveSessionById(
      {
        id: "tenant-rw",
        title: "rewind",
        cwd: "/tmp/work",
        createdAt: 1,
        lastTouched: 1,
        archived: false,
      },
      {
        reason: "completed",
        turns: 2,
        messages: [
          { id: "m0", role: "user", content: [{ type: "text", text: "0" }] },
          { id: "m1", role: "assistant", content: [{ type: "text", text: "1" }] },
          { id: "m2", role: "user", content: [{ type: "text", text: "2" }] },
        ],
      },
      provider,
    )

    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
    const result = await rewindToMessage("tenant-rw", "m1", provider)
    expect(result).toEqual({ removed: 1 })
    expect(await loadSessionById("tenant-rw")).toBeUndefined()
    expect((await loadSessionById("tenant-rw", provider))?.messages.map((m) => m.id)).toEqual([
      "m0",
      "m1",
    ])
  })
})

/* ------------------------------------------------------------------ */
/* RFC-01 A2 (aug-02) — durable ThreadRollback records                 */
/* ------------------------------------------------------------------ */

describe("session store — durable rollback records (RFC01-0)", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-rollback-"))
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

  const checkpoint = (over: Partial<RollbackCheckpointRecord> = {}): RollbackCheckpointRecord => ({
    recordVersion: ROLLBACK_RECORD_VERSION,
    turnId: over.turnId ?? "t1",
    messageId: over.messageId ?? "m1",
    checkpointSha: over.checkpointSha ?? "a".repeat(40),
    expectedFileHashes: over.expectedFileHashes ?? { "src/a.ts": "h1", "src/b.ts": "h2" },
  })

  // RED (restart round-trip): persist an intent + checkpoint, DROP the runtime
  // (a fresh loadSessionById is a cold read from disk — no in-memory state), and
  // assert the pending operation + checkpoint identity round-trip EXACTLY. Before
  // the schema/save wiring, the fields are stripped on load → this is RED.
  test("intent + checkpoint survive a process-drop reload (exact identity)", async () => {
    const meta = mkMeta({ id: "rb-1" })
    const cp = checkpoint()
    await saveSessionById(meta, {
      ...mkPayload(),
      rollbackCheckpoints: [cp],
      rollbackOperations: appendRollbackIntent([], {
        operationId: "op-1",
        targetTurnId: "t1",
        requestedAt: 5_000,
      }) as RollbackOperationRecord[],
    })

    // Cold reload — simulates a fresh process reading the durable snapshot.
    const reloaded = await loadSessionById("rb-1")
    expect(reloaded).toBeDefined()
    if (reloaded === undefined) return

    // Checkpoint identity is exact (SHA + expected hashes + keys).
    expect(reloaded.rollbackCheckpoints).toEqual([cp])
    // The operation is still `requested` — a pending op is operator-visible,
    // NEVER assumed successful on restart.
    expect(reloaded.rollbackOperations).toEqual([
      {
        recordVersion: ROLLBACK_RECORD_VERSION,
        operationId: "op-1",
        targetTurnId: "t1",
        state: "requested",
        requestedAt: 5_000,
      },
    ])
    expect(pendingOperationIds(reloaded.rollbackOperations ?? [])).toEqual(["op-1"])
  })

  // Terminal receipt round-trips and the op is no longer pending.
  test("terminal receipt round-trips; op no longer pending", async () => {
    const meta = mkMeta({ id: "rb-2" })
    const withIntent = appendRollbackIntent([], {
      operationId: "op-2",
      targetTurnId: "t1",
      requestedAt: 1_000,
    })
    const terminal = appendRollbackTerminal(withIntent, {
      operationId: "op-2",
      state: "rolled_back",
      terminalAt: 2_000,
    })
    await saveSessionById(meta, {
      ...mkPayload(),
      rollbackOperations: terminal as RollbackOperationRecord[],
    })
    const reloaded = await loadSessionById("rb-2")
    const ops = reloaded?.rollbackOperations ?? []
    // Append-only: BOTH the requested intent and the terminal receipt persist.
    expect(ops.length).toBe(2)
    expect(latestOperation(ops, "op-2")?.state).toBe("rolled_back")
    expect(latestOperation(ops, "op-2")?.terminalAt).toBe(2_000)
    expect(pendingOperationIds(ops)).toEqual([])
  })

  // Old snapshots (no rollback fields) load fine and re-serialize byte-identically.
  test("legacy snapshot (no rollback fields) loads and re-saves byte-identically", async () => {
    const meta = mkMeta({ id: "rb-legacy" })
    await saveSessionById(meta, mkPayload())
    const path = sessionFilePath("rb-legacy")
    const raw1 = await Bun.file(path).text()
    expect(raw1.includes("rollbackCheckpoints")).toBe(false)
    expect(raw1.includes("rollbackOperations")).toBe(false)

    const reloaded = await loadSessionById("rb-legacy")
    expect(reloaded?.rollbackCheckpoints).toBeUndefined()
    expect(reloaded?.rollbackOperations).toBeUndefined()

    // Re-save the reloaded payload (no rollback fields) — the on-disk shape must
    // stay byte-identical (no injected empty arrays).
    await saveSessionById(reloaded?.meta ?? meta, {
      reason: reloaded?.reason ?? "completed",
      turns: reloaded?.turns ?? 1,
      messages: reloaded?.messages ?? [],
    })
    const raw2 = await Bun.file(path).text()
    expect(raw2.includes("rollbackCheckpoints")).toBe(false)
    expect(raw2.includes("rollbackOperations")).toBe(false)
  })

  // Duplicate operationId is idempotent — re-recording an intent is a no-op.
  test("duplicate operationId intent is idempotent (no second record)", () => {
    const once = appendRollbackIntent([], {
      operationId: "op-dup",
      targetTurnId: "t1",
      requestedAt: 1_000,
    })
    const twice = appendRollbackIntent(once, {
      operationId: "op-dup",
      targetTurnId: "t1",
      requestedAt: 9_999,
    })
    expect(twice).toBe(once) // same reference — no append
    expect(twice.length).toBe(1)
    expect(twice[0]?.requestedAt).toBe(1_000) // first intent wins
  })

  // A terminal receipt for an UNKNOWN op is refused (no fabricated success).
  test("terminal for unknown operationId is a no-op (no success-before-intent)", () => {
    const result = appendRollbackTerminal([], {
      operationId: "ghost",
      state: "rolled_back",
      terminalAt: 1,
    })
    expect(result).toEqual([])
  })

  // A second terminal for an already-terminal op is ignored (first terminal wins).
  test("second terminal is idempotent (first terminal wins)", () => {
    const intent = appendRollbackIntent([], {
      operationId: "op-t",
      targetTurnId: "t1",
      requestedAt: 1,
    })
    const first = appendRollbackTerminal(intent, {
      operationId: "op-t",
      state: "rolled_back",
      terminalAt: 2,
    })
    const second = appendRollbackTerminal(first, {
      operationId: "op-t",
      state: "rollback_failed",
      terminalAt: 3,
      errorCode: "conflict",
    })
    expect(second).toBe(first) // no append
    expect(latestOperation(second, "op-t")?.state).toBe("rolled_back")
  })

  // Checkpoint upsert + resolve: same boundary replaces; missing turn ⇒ undefined
  // (the coordinator fail-closes → NO mutation on a missing/moved mapping).
  test("checkpoint upsert replaces same boundary; missing turn resolves undefined", () => {
    const cp1 = checkpoint({ turnId: "t1", messageId: "m1", checkpointSha: "a".repeat(40) })
    const cp2 = checkpoint({ turnId: "t1", messageId: "m1", checkpointSha: "b".repeat(40) })
    const after = upsertRollbackCheckpoint([cp1], cp2)
    expect(after.length).toBe(1)
    expect(resolveCheckpointForTurn(after, "t1")?.checkpointSha).toBe("b".repeat(40))
    // A moved/missing target turn ⇒ no mapping ⇒ fail-closed at the effect site.
    expect(resolveCheckpointForTurn(after, "t-nope")).toBeUndefined()
  })

  // Fail-closed migration: an UNKNOWN operation state on disk refuses the WHOLE
  // load (never partially applied).
  test("unknown operation state on disk fails the load closed", async () => {
    const meta = mkMeta({ id: "rb-bad" })
    await saveSessionById(meta, mkPayload())
    const path = sessionFilePath("rb-bad")
    const raw = JSON.parse(await Bun.file(path).text())
    raw.rollbackOperations = [
      {
        recordVersion: ROLLBACK_RECORD_VERSION,
        operationId: "op-x",
        targetTurnId: "t1",
        state: "teleported", // not in the closed lifecycle enum
        requestedAt: 1,
      },
    ]
    writeFileSync(path, JSON.stringify(raw))
    expect(await loadSessionById("rb-bad")).toBeUndefined()
  })

  // Fail-closed migration: an UNKNOWN recordVersion refuses the load.
  test("unknown recordVersion on disk fails the load closed", async () => {
    const meta = mkMeta({ id: "rb-ver" })
    await saveSessionById(meta, mkPayload())
    const path = sessionFilePath("rb-ver")
    const raw = JSON.parse(await Bun.file(path).text())
    raw.rollbackCheckpoints = [
      {
        recordVersion: 999,
        turnId: "t1",
        messageId: "m1",
        checkpointSha: "a".repeat(40),
        expectedFileHashes: {},
      },
    ]
    writeFileSync(path, JSON.stringify(raw))
    expect(await loadSessionById("rb-ver")).toBeUndefined()
  })
})
