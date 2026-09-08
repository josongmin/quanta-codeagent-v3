/**
 * HELL-GATE — F-09 flock lock. Age steal is gone. Leftover lock files are
 * reopened. Same-process reentrancy is refused. Live holders are not displaced.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireLock, createJsonStateFile, releaseLock } from "@/permission/json-state-file"

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), "jsf-flock-"))

describe("json-state-file lock — flock, no age steal", () => {
  test("leftover lock pathname without a holder is acquirable (no age unlink)", async () => {
    const dir = await tmp()
    const lockPath = join(dir, "state.json.lock")
    try {
      await writeFile(lockPath, JSON.stringify({ pid: 999_999, ts: Date.now() }), { mode: 0o600 })
      expect(await acquireLock(lockPath)).toBe(true)
      await releaseLock(lockPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("same-process reentrancy is refused", async () => {
    const dir = await tmp()
    const lockPath = join(dir, "state.json.lock")
    try {
      expect(await acquireLock(lockPath)).toBe(true)
      expect(await acquireLock(lockPath, undefined, Date.now, 80)).toBe(false)
      await releaseLock(lockPath)
      expect(await acquireLock(lockPath)).toBe(true)
      await releaseLock(lockPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fail-closed-on-timeout: a held lock blocks disk write and remains retryable", async () => {
    const dir = await tmp()
    const filePath = join(dir, "state.json")
    const lockPath = `${filePath}.lock`
    try {
      type S = { records: string[] }
      const original: S = { records: ["existing-durable-record"] }
      await writeFile(filePath, JSON.stringify(original), "utf8")
      expect(await acquireLock(lockPath)).toBe(true)

      const store = createJsonStateFile<S>({
        filePath,
        debounceMs: 0,
        emptyState: () => ({ records: [] }),
        serialize: (s) => JSON.stringify(s),
        parse: (raw): { kind: "ok"; state: S } | { kind: "shape-invalid"; reason: string } =>
          raw !== null && typeof raw === "object" && Array.isArray((raw as S).records)
            ? { kind: "ok", state: raw as S }
            : { kind: "shape-invalid", reason: "not a records array" },
        stateVersion: 1,
        mergeWithDisk: ({ inMemory }) => inMemory,
        lockTimeoutMs: 80,
      })

      const live: S = { records: ["denial-must-survive"] }
      const outcome = await store.flushDurable(() => live)
      expect(outcome).toEqual({
        durable: false,
        reason: "cross-process lock unavailable",
      })
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(original)
      expect(live.records).toEqual(["denial-must-survive"])

      await releaseLock(lockPath)
      const retry = await store.flushDurable(() => live)
      expect(retry).toEqual({ durable: true })
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(live)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
