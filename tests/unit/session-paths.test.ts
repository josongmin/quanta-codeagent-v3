import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { archivedFilePath, indexFilePath, sessionFilePath, sessionsRoot } from "@/session"

describe("session paths", () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
  })
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test("default root is ~/.quanta/sessions", () => {
    delete process.env.QUANTA_SESSIONS_DIR
    expect(sessionsRoot()).toBe(join(homedir(), ".quanta", "sessions"))
  })

  test("QUANTA_SESSIONS_DIR overrides the root", () => {
    process.env.QUANTA_SESSIONS_DIR = "/tmp/custom-sessions"
    expect(sessionsRoot()).toBe("/tmp/custom-sessions")
  })

  test("sessionFilePath returns <root>/<id>.json", () => {
    process.env.QUANTA_SESSIONS_DIR = "/tmp/s"
    expect(sessionFilePath("abc")).toBe("/tmp/s/abc.json")
  })

  test("archivedFilePath returns <root>/archived/<id>.json", () => {
    process.env.QUANTA_SESSIONS_DIR = "/tmp/s"
    expect(archivedFilePath("abc")).toBe("/tmp/s/archived/abc.json")
  })

  test("indexFilePath returns <root>/index.jsonl", () => {
    process.env.QUANTA_SESSIONS_DIR = "/tmp/s"
    expect(indexFilePath()).toBe("/tmp/s/index.jsonl")
  })

  test("paths re-evaluate the env on each call (no stale caching)", () => {
    process.env.QUANTA_SESSIONS_DIR = "/tmp/first"
    expect(sessionsRoot()).toBe("/tmp/first")
    process.env.QUANTA_SESSIONS_DIR = "/tmp/second"
    expect(sessionsRoot()).toBe("/tmp/second")
  })
})
