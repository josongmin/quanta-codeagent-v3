/**
 * ADR-0038: import-log round trip + lock collision.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendImportLog, ImportLogBusyError, importLogPath, loadImportLog } from "@/migration"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "migration-persistence-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("import log persistence (ADR-0038)", () => {
  test("empty log file ⇒ load returns { version:1, entries:[] }", async () => {
    const log = await loadImportLog(home)
    expect(log).toEqual({ version: 1, entries: [] })
  })

  test("append + load round-trip preserves entries in order", async () => {
    await appendImportLog(home, {
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "claude_code",
      stage: "import_finished",
      ok: true,
      detail: "translated_sessions=3, counted_skills=0, persisted_sessions=0",
    })
    await appendImportLog(home, {
      timestamp: "2026-01-02T00:00:00.000Z",
      provider: "cursor",
      stage: "import_finished",
      ok: false,
      detail: "detect failed",
    })
    const log = await loadImportLog(home)
    expect(log.version).toBe(1)
    expect(log.entries).toHaveLength(2)
    expect(log.entries[0]?.provider).toBe("claude_code")
    expect(log.entries[1]?.provider).toBe("cursor")
    expect(log.entries[1]?.ok).toBe(false)
  })

  test("log file written under ~/.quanta/external_agent_session_imports.json", async () => {
    await appendImportLog(home, {
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "aider",
      stage: "import_finished",
      ok: true,
      detail: "noop",
    })
    expect(importLogPath(home)).toBe(join(home, ".quanta", "external_agent_session_imports.json"))
  })

  test("concurrent writer ⇒ ImportLogBusyError when lock held", async () => {
    // Pre-create the lock file to simulate a concurrent writer.
    await mkdir(join(home, ".quanta"), { recursive: true })
    await writeFile(`${importLogPath(home)}.lock`, "999999", { encoding: "utf8", flag: "wx" })
    await expect(
      appendImportLog(home, {
        timestamp: "2026-01-01T00:00:00.000Z",
        provider: "claude_code",
        stage: "import_finished",
        ok: true,
        detail: "x",
      }),
    ).rejects.toBeInstanceOf(ImportLogBusyError)
  })

  test("malformed log file ⇒ load throws (no silent recovery)", async () => {
    await mkdir(join(home, ".quanta"), { recursive: true })
    await writeFile(importLogPath(home), '{"version":1,"entries":"not-an-array"}', "utf8")
    await expect(loadImportLog(home)).rejects.toThrow(/Malformed/)
  })

  test("wrong version in log file ⇒ load throws", async () => {
    await mkdir(join(home, ".quanta"), { recursive: true })
    await writeFile(importLogPath(home), '{"version":2,"entries":[]}', "utf8")
    await expect(loadImportLog(home)).rejects.toThrow(/Malformed/)
  })

  test("lock cleared after successful append (sequential writes work)", async () => {
    await appendImportLog(home, {
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "claude_code",
      stage: "import_finished",
      ok: true,
      detail: "a",
    })
    // Second append should NOT see ImportLogBusyError.
    await appendImportLog(home, {
      timestamp: "2026-01-02T00:00:00.000Z",
      provider: "claude_code",
      stage: "import_finished",
      ok: true,
      detail: "b",
    })
    const log = await loadImportLog(home)
    expect(log.entries).toHaveLength(2)
  })

  test("public migration surface does not export an unsupported dedup query", async () => {
    const migration = await import("@/migration")
    expect("contentSha256" in migration).toBe(true)
    expect("wasAlreadyImported" in migration).toBe(false)
  })
})
