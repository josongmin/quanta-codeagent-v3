import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archivedFilePath,
  archiveSession,
  listSessions,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  cwd: "/tmp/work",
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

const payload = { reason: "completed", turns: 1, messages: [] }

describe("session concurrency PR canary", () => {
  let sessionsDir = ""
  let previousSessionsDir: string | undefined

  beforeEach(() => {
    previousSessionsDir = process.env.QUANTA_SESSIONS_DIR
    sessionsDir = mkdtempSync(join(tmpdir(), "session-concurrency-canary-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    if (previousSessionsDir === undefined) delete process.env.QUANTA_SESSIONS_DIR
    else process.env.QUANTA_SESSIONS_DIR = previousSessionsDir
    __resetRuntimeConfig()
  })

  test("32 parallel saves leave every file and index row with no temp residue", async () => {
    const ids = Array.from({ length: 32 }, (_, index) => `parallel-${index}`)
    const settled = await Promise.allSettled(ids.map((id) => saveSessionById(meta(id), payload)))

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true)
    expect((await listSessions()).map(({ id }) => id).sort()).toEqual([...ids].sort())
    expect(readdirSync(sessionsDir).filter((file) => file.includes(".tmp."))).toEqual([])
    for (const id of ids) expect(existsSync(sessionFilePath(id))).toBe(true)
  })

  test("save/archive races keep exactly one authoritative copy", async () => {
    for (let round = 0; round < 3; round++) {
      const id = `archive-race-${round}`
      await saveSessionById(meta(id), payload)
      await Promise.allSettled([saveSessionById(meta(id), payload), archiveSession(id)])

      const active = existsSync(sessionFilePath(id))
      const archived = existsSync(archivedFilePath(id))
      expect(active !== archived).toBe(true)
    }
  })
})
