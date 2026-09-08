/**
 * W4-I — persist-turn must not resurrect a deleted session (SEP7-D-05.4).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deleteSession, loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { persistTurn } from "./persist-turn"

let root: string
let priorEnv: string | undefined

beforeEach(() => {
  priorEnv = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "persist-stale-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (priorEnv === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = priorEnv
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

const meta = (id: string): SessionMeta => ({
  id,
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

test("persistTurn after deleteSession does not resurrect the snapshot", async () => {
  const id = "sess-deleted"
  const m = meta(id)
  await saveSessionById(m, { reason: "done", turns: 1, messages: [] }, undefined, { create: true })
  await deleteSession(id)
  await persistTurn({
    state: undefined,
    idMeta: m,
    sessionId: id,
    messages: [],
    outcome: { reason: "done", turns: 2 } as never,
  })
  expect(await loadSessionById(id)).toBeUndefined()
})

test("unrelated session autosave still persists after another id is deleted", async () => {
  const gone = meta("gone")
  const keep = meta("keep")
  await saveSessionById(gone, { reason: "done", turns: 1, messages: [] }, undefined, {
    create: true,
  })
  await saveSessionById(keep, { reason: "done", turns: 1, messages: [] }, undefined, {
    create: true,
  })
  await deleteSession("gone")
  await persistTurn({
    state: undefined,
    idMeta: keep,
    sessionId: keep.id,
    messages: [],
    outcome: { reason: "done", turns: 3 } as never,
  })
  expect(await loadSessionById("gone")).toBeUndefined()
  expect((await loadSessionById("keep"))?.turns).toBe(3)
})
