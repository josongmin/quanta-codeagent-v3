import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deleteSession, loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

let root: string
let prior: string | undefined

beforeEach(() => {
  prior = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "r03-int-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (prior === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = prior
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

describe("R03 delete/save on a real sessions dir", () => {
  test("delete then save without create does not resurrect", async () => {
    const meta: SessionMeta = {
      id: "s1",
      title: "t",
      cwd: "/tmp",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    await saveSessionById(meta, { reason: "done", turns: 1, messages: [] }, undefined, {
      create: true,
    })
    await deleteSession("s1")
    await expect(
      saveSessionById(meta, { reason: "done", turns: 2, messages: [] }),
    ).rejects.toMatchObject({ name: "StaleSessionGenerationError" })
    expect(await loadSessionById("s1")).toBeUndefined()
  })
})
