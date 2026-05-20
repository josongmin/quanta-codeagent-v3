import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  archivedFilePath,
  indexFilePath,
  SessionIdError,
  sanitizeId,
  sessionFilePath,
  sessionsRoot,
} from "@/session"

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

  describe("sanitizeId (HIGH-1 traversal guard)", () => {
    test("accepts a randomUUID-shaped id unchanged", () => {
      const id = crypto.randomUUID()
      expect(sanitizeId(id)).toBe(id)
    })

    test("accepts plain alphanumeric and common punctuation", () => {
      expect(sanitizeId("abc")).toBe("abc")
      expect(sanitizeId("sess_v2.42-foo")).toBe("sess_v2.42-foo")
    })

    test("rejects empty string", () => {
      expect(() => sanitizeId("")).toThrow(SessionIdError)
    })

    test("rejects path-separator chars (traversal)", () => {
      expect(() => sanitizeId("../etc/passwd")).toThrow(SessionIdError)
      expect(() => sanitizeId("foo/bar")).toThrow(SessionIdError)
      expect(() => sanitizeId("foo\\bar")).toThrow(SessionIdError)
    })

    test('rejects "." and ".." segments', () => {
      expect(() => sanitizeId(".")).toThrow(SessionIdError)
      expect(() => sanitizeId("..")).toThrow(SessionIdError)
    })

    test("rejects leading dash (CLI-flag confusion)", () => {
      expect(() => sanitizeId("-rf")).toThrow(SessionIdError)
    })

    test("rejects control chars + NUL", () => {
      expect(() => sanitizeId("foo\x00bar")).toThrow(SessionIdError)
      expect(() => sanitizeId("foo\x01bar")).toThrow(SessionIdError)
      expect(() => sanitizeId("foo\nbar")).toThrow(SessionIdError)
    })

    test("rejects ids over the length cap", () => {
      expect(() => sanitizeId("a".repeat(129))).toThrow(SessionIdError)
    })

    test("sessionFilePath / archivedFilePath route through sanitizeId", () => {
      process.env.QUANTA_SESSIONS_DIR = "/tmp/s"
      expect(() => sessionFilePath("../escape")).toThrow(SessionIdError)
      expect(() => archivedFilePath("../escape")).toThrow(SessionIdError)
    })
  })
})
