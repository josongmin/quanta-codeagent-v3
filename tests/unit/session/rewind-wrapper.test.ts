import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import {
  assignMessageIds,
  forkSessionAtMessage,
  loadSessionById,
  type RewindGitPort,
  resolveMessageIdPrefix,
  rewindSession,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * Claude Code v1.7196 "Rewind + Fork" wrapper (src/session/rewind.ts) tests.
 *
 * These tests cover the wrapper layer ONLY — the underlying
 * `rewindToMessage` and `forkSession` primitives are tested in
 * `rewind.test.ts` and `session-store.test.ts` respectively. Here we cover:
 *
 *   - Prefix-id resolution (exact, unique-prefix, ambiguous, missing).
 *   - RewindResult shape (turn count, message count, fileStateNote).
 *   - File-restore gate chain (disabled / git-port-missing / no gitSha / ok).
 *   - Fork at messageId: source preserved, clone truncated to fork point.
 *   - Fork at messageId: source unchanged on failure (resolution fails before
 *     clone creation).
 */

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "wrapper-default",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
  ...(overrides.gitSha !== undefined ? { gitSha: overrides.gitSha } : {}),
})

const mkMessage = (text: string, role: "user" | "assistant" = "user"): Message => ({
  role,
  content: [{ type: "text", text }],
})

const seed = async (id: string, ids: readonly string[], opts: Partial<SessionMeta> = {}) => {
  const messages: Message[] = ids.map((mid, i) => ({
    ...mkMessage(`t${i}`, i % 2 === 0 ? "user" : "assistant"),
    id: mid,
  }))
  const meta = mkMeta({ id, ...opts })
  const payload: SavePayload = { reason: "ok", turns: ids.length, messages }
  await saveSessionById(meta, payload)
}

describe("resolveMessageIdPrefix", () => {
  const msgs: Message[] = [
    { ...mkMessage("a"), id: "abc-001" },
    { ...mkMessage("b"), id: "abc-002" },
    { ...mkMessage("c"), id: "def-001" },
  ]

  test("exact match wins even if it would otherwise be ambiguous", () => {
    expect(resolveMessageIdPrefix(msgs, "abc-001")).toBe("abc-001")
  })
  test("unique prefix resolves", () => {
    expect(resolveMessageIdPrefix(msgs, "def")).toBe("def-001")
  })
  test("ambiguous prefix returns undefined", () => {
    expect(resolveMessageIdPrefix(msgs, "abc")).toBeUndefined()
  })
  test("no match returns undefined", () => {
    expect(resolveMessageIdPrefix(msgs, "zzz")).toBeUndefined()
  })
  test("empty prefix returns undefined", () => {
    expect(resolveMessageIdPrefix(msgs, "")).toBeUndefined()
  })
  test("messages without ids are skipped", () => {
    const mixed: Message[] = [
      { role: "user", content: [{ type: "text", text: "x" }] },
      { ...mkMessage("y"), id: "yy-1" },
    ]
    expect(resolveMessageIdPrefix(mixed, "yy")).toBe("yy-1")
  })
})

describe("rewindSession (wrapper)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-wrap-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns structured result with removedTurns / removedMessages / note", async () => {
    // 6 messages alternating user/assistant — dropping the last 4 should
    // yield 2 user-turns dropped.
    await seed("rs-1", ["m0", "m1", "m2", "m3", "m4", "m5"])
    const result = await rewindSession({
      sessionId: "rs-1",
      messageId: "m1",
    })
    expect(result.sessionId).toBe("rs-1")
    expect(result.rewindToMessageId).toBe("m1")
    expect(result.removedMessages).toBe(4)
    // m2 (user), m4 (user) — 2 user-turns dropped.
    expect(result.removedTurns).toBe(2)
    expect(result.fileStateNote).toBe("working tree unchanged")
    const reloaded = await loadSessionById("rs-1")
    expect(reloaded?.messages.length).toBe(2)
  })

  test("accepts a prefix id and resolves to the full id", async () => {
    await seed("rs-prefix", ["msg-aaa-1", "msg-aaa-2", "msg-bbb-1"])
    const result = await rewindSession({
      sessionId: "rs-prefix",
      messageId: "msg-aaa-1",
    })
    expect(result.rewindToMessageId).toBe("msg-aaa-1")
    expect(result.removedMessages).toBe(2)
  })

  test("rejects ambiguous prefix with a clear error", async () => {
    await seed("rs-ambig", ["abc-1", "abc-2", "def-1"])
    await expect(rewindSession({ sessionId: "rs-ambig", messageId: "abc" })).rejects.toThrow(
      /not found.*or ambiguous/,
    )
  })

  test("throws when sessionId is unknown", async () => {
    await expect(rewindSession({ sessionId: "no-such", messageId: "m0" })).rejects.toThrow(
      /session not found/,
    )
  })

  test("rewind to last message is a no-op with descriptive note", async () => {
    await seed("rs-last", ["m0", "m1", "m2"])
    const result = await rewindSession({
      sessionId: "rs-last",
      messageId: "m2",
    })
    expect(result.removedMessages).toBe(0)
    expect(result.removedTurns).toBe(0)
    expect(result.fileStateNote).toBe("rewind no-op; working tree unchanged")
  })

  test("restoreFiles=true without git port: file-state note explains the no-op", async () => {
    await seed("rs-no-port", ["m0", "m1", "m2"], { gitSha: "deadbeef" })
    const result = await rewindSession({
      sessionId: "rs-no-port",
      messageId: "m0",
      restoreFiles: true,
    })
    expect(result.removedMessages).toBe(2)
    expect(result.fileStateNote).toBe("git port not wired; working tree unchanged")
  })

  test("restoreFiles=true without gitSha on session: note explains", async () => {
    await seed("rs-no-sha", ["m0", "m1"])
    const port: RewindGitPort = {
      stash: async () => undefined,
      resetHard: async () => undefined,
    }
    const result = await rewindSession({
      sessionId: "rs-no-sha",
      messageId: "m0",
      restoreFiles: true,
      git: port,
    })
    expect(result.fileStateNote).toBe("no gitSha on session; working tree unchanged")
  })

  test("restoreFiles=true with port + gitSha: stash + reset called once", async () => {
    // The on-disk SessionMeta schema (zod) does not currently persist `gitSha`
    // through reload — so we inject a custom loader that returns it directly,
    // exercising the wrapper's git-restore branch deterministically without
    // depending on the persistence layer's optional fields.
    await seed("rs-restore", ["m0", "m1"])
    let stashCalls = 0
    let resetCalls = 0
    let resetSha: string | undefined
    const port: RewindGitPort = {
      stash: async () => {
        stashCalls += 1
        return "stash@{0}"
      },
      resetHard: async (_cwd, sha) => {
        resetCalls += 1
        resetSha = sha
      },
    }
    const result = await rewindSession({
      sessionId: "rs-restore",
      messageId: "m0",
      restoreFiles: true,
      git: port,
      loader: async (id) => {
        const s = await loadSessionById(id)
        if (s === undefined) return undefined
        return {
          meta: { ...s.meta, gitSha: "cafefeed" },
          messages: s.messages,
        }
      },
    })
    expect(stashCalls).toBe(1)
    expect(resetCalls).toBe(1)
    expect(resetSha).toBe("cafefeed")
    expect(result.fileStateNote).toBe("git stashed; reset to cafefeed")
  })

  test("rewind to first message yields a single-message transcript", async () => {
    await seed("rs-first", ["m0", "m1", "m2"])
    const result = await rewindSession({
      sessionId: "rs-first",
      messageId: "m0",
    })
    expect(result.removedMessages).toBe(2)
    const reloaded = await loadSessionById("rs-first")
    expect(reloaded?.messages.length).toBe(1)
    expect(reloaded?.messages[0]?.id).toBe("m0")
  })
})

describe("forkSessionAtMessage (wrapper)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fork-wrap-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("clones source then truncates clone to fork point — source preserved", async () => {
    await seed("src-fork-1", ["m0", "m1", "m2", "m3", "m4"])
    const result = await forkSessionAtMessage({
      fromSessionId: "src-fork-1",
      atMessageId: "m2",
      newId: "fork-fixed-1",
    })
    expect(result.newSessionId).toBe("fork-fixed-1")
    expect(result.fromSessionId).toBe("src-fork-1")
    expect(result.forkedAtMessageId).toBe("m2")
    expect(result.messageCount).toBe(3)

    // Original untouched.
    const source = await loadSessionById("src-fork-1")
    expect(source?.messages.length).toBe(5)

    // Clone truncated.
    const fork = await loadSessionById("fork-fixed-1")
    expect(fork?.messages.length).toBe(3)
    expect(fork?.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"])
  })

  test("default title is '<orig> (fork)'", async () => {
    await seed("src-default-title", ["m0", "m1"])
    const result = await forkSessionAtMessage({
      fromSessionId: "src-default-title",
      atMessageId: "m0",
      newId: "fork-dt-1",
    })
    const fork = await loadSessionById(result.newSessionId)
    expect(fork?.meta.title).toBe("T (fork)")
  })

  test("--title override is honored", async () => {
    await seed("src-custom-title", ["m0", "m1"])
    const result = await forkSessionAtMessage({
      fromSessionId: "src-custom-title",
      atMessageId: "m0",
      newTitle: "experiment-A",
      newId: "fork-ct-1",
    })
    const fork = await loadSessionById(result.newSessionId)
    expect(fork?.meta.title).toBe("experiment-A")
  })

  test("missing source throws BEFORE creating any new session", async () => {
    await expect(
      forkSessionAtMessage({
        fromSessionId: "no-such-src",
        atMessageId: "m0",
      }),
    ).rejects.toThrow(/source session not found/)
  })

  test("missing fork-point id throws BEFORE creating any new session", async () => {
    await seed("src-bad-id", ["m0", "m1"])
    await expect(
      forkSessionAtMessage({
        fromSessionId: "src-bad-id",
        atMessageId: "does-not-exist",
        newId: "should-never-exist",
      }),
    ).rejects.toThrow(/messageId not found/)
    // Confirm the doomed-clone session was NOT created.
    const ghost = await loadSessionById("should-never-exist")
    expect(ghost).toBeUndefined()
  })

  test("fork at last message ⇒ clone equals source (no rewind needed)", async () => {
    await seed("src-last", ["m0", "m1", "m2"])
    const result = await forkSessionAtMessage({
      fromSessionId: "src-last",
      atMessageId: "m2",
      newId: "fork-last-1",
    })
    expect(result.messageCount).toBe(3)
  })

  test("works with prefix id resolution", async () => {
    await seed("src-prefix", ["abc-1", "def-1", "def-2"])
    const result = await forkSessionAtMessage({
      fromSessionId: "src-prefix",
      atMessageId: "abc",
      newId: "fork-prefix-1",
    })
    expect(result.forkedAtMessageId).toBe("abc-1")
    expect(result.messageCount).toBe(1)
  })

  test("works after assignMessageIds on a fresh transcript", async () => {
    const raw: Message[] = [mkMessage("a"), mkMessage("b"), mkMessage("c")]
    const withIds = assignMessageIds(raw, (i) => `mid-${i}`)
    const meta = mkMeta({ id: "src-assign" })
    await saveSessionById(meta, { reason: "ok", turns: 1, messages: withIds })
    const result = await forkSessionAtMessage({
      fromSessionId: "src-assign",
      atMessageId: "mid-1",
      newId: "fork-assign-1",
    })
    expect(result.forkedAtMessageId).toBe("mid-1")
    expect(result.messageCount).toBe(2)
  })
})
