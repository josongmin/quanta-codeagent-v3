/**
 * ★ HELLGATE — ADR-0370 session-registry inspector + `/session-registry`
 * slash render path + ADR-0377 cross-platform path normalization.
 *
 * Pins the operator-visibility contract for the three backends
 * (in-memory / disk / sqlite) plus the formatter + slash registration.
 *
 * Coverage (15 cases ADR-0370 + 8 cases ADR-0377 = 23):
 *   1.  empty in-memory     → backend="in-memory", sessions=0
 *   2.  populated in-memory → sessions count matches registry.size()
 *   3.  empty disk dir      → backend="disk", sessions=0, totalBytes=0
 *   4.  populated disk      → sessions count + totalBytes > 0
 *   5.  disk dir missing    → available=false (NO-THROW)
 *   6.  empty sqlite        → backend="sqlite", sessions=0
 *   7.  populated sqlite    → sessions + events + cache + bytes counted
 *   8.  sqlite walSize stat → walSize >= 0 (WAL file present or 0)
 *   9.  missing sqlite path → available=false (NO-THROW)
 *  10.  env not set         → inspectGlobal → in-memory
 *  11.  env precedence      → sqlite > disk > in-memory
 *  12.  formatter substrs   → contains "Session Registry" + backend tag
 *  13.  formatter unavail   → contains "unavailable" when available=false
 *  14.  formatter sqlite    → contains "Codex" parity tag
 *  15.  formatter disk      → no Codex tag (only sqlite gets it)
 *
 *  ADR-0377 — cross-platform path normalization (Codex parity = POSIX):
 *  16.  disk path backslash    → output forward-slash only
 *  17.  disk path forward      → unchanged
 *  18.  disk path mixed sep    → all backslashes flipped
 *  19.  sqlite path backslash  → output forward-slash only
 *  20.  in-memory backend      → path field absent / undefined
 *  21.  formatter disk Path:   → renders "Path:" line with normalized value
 *  22.  formatter sqlite Path: → renders "Path:" line with normalized value
 *  23.  formatter in-memory    → no "Path:" line emitted
 *
 * Slash-registration is covered by `tests/unit/session-registry-slash.test.ts`
 * (separate file — the slice fence forbids importing `@/apps/cli/*` from
 * library slices).
 */

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetKnobOverrides, setKnobOverride } from "@/shared"
import { getGlobalSessionResourceRegistry, resetGlobalSessionResourceRegistry } from "../global"
import { createInMemorySessionResourceRegistry } from "../in-memory-registry"
import {
  formatRegistryStats,
  inspectDiskRegistryByPath,
  inspectGlobalRegistry,
  inspectInMemoryRegistry,
  inspectSqliteRegistryByPath,
} from "../inspector"
import { applyMigrations } from "../sqlite-adapter/schema"
import { createSqliteSessionResourceRegistry } from "../sqlite-adapter/sqlite-store"

const makeTmpDir = (label: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), `quanta-adr0370-${label}-`))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

const ORIGINAL_ENV: Record<string, string | undefined> = {}
const TRACKED_ENV = [
  "QUANTA_SESSION_REGISTRY_SQLITE_PATH",
  "QUANTA_SESSION_REGISTRY_DISK_DIR",
] as const

beforeEach(() => {
  resetGlobalSessionResourceRegistry()
  __resetKnobOverrides()
  for (const k of TRACKED_ENV) {
    ORIGINAL_ENV[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  resetGlobalSessionResourceRegistry()
  __resetKnobOverrides()
  for (const k of TRACKED_ENV) {
    const v = ORIGINAL_ENV[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("ADR-0370 session-registry inspector — hellgate", () => {
  test("[1] empty in-memory → backend=in-memory, sessions=0", () => {
    const reg = createInMemorySessionResourceRegistry()
    const s = inspectInMemoryRegistry(reg)
    expect(s.backend).toBe("in-memory")
    expect(s.sessions).toBe(0)
    expect(s.available).toBe(true)
    expect(s.totalBytes).toBeUndefined()
    expect(s.walSize).toBeUndefined()
  })

  test("[2] populated in-memory → sessions count matches size()", () => {
    const reg = createInMemorySessionResourceRegistry()
    reg.getOrCreate("a")
    reg.getOrCreate("b")
    reg.getOrCreate("c")
    const s = inspectInMemoryRegistry(reg)
    expect(s.backend).toBe("in-memory")
    expect(s.sessions).toBe(3)
  })

  test("[3] empty disk dir → backend=disk, sessions=0, totalBytes=0", async () => {
    const { dir, cleanup } = makeTmpDir("disk-empty")
    const s = await inspectDiskRegistryByPath(dir)
    expect(s.backend).toBe("disk")
    expect(s.sessions).toBe(0)
    expect(s.totalBytes).toBe(0)
    expect(s.available).toBe(true)
    cleanup()
  })

  test("[4] populated disk → sessions count + totalBytes > 0", async () => {
    const { dir, cleanup } = makeTmpDir("disk-full")
    // Write 2 session dirs with content.
    for (const sid of ["sess1", "sess2"]) {
      const sessionDir = join(dir, sid)
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        join(sessionDir, "events.jsonl"),
        `{"kind":"mode_change","prev":"a","next":"b","at":1}\n`,
      )
      await writeFile(
        join(sessionDir, "prompt-cache.jsonl"),
        `{"key":"k","text":"abc","contentHash":"h","builtAt":1}\n`,
      )
      await writeFile(join(sessionDir, "meta.json"), `{"sessionId":"${sid}","lastTouched":1}`)
    }
    const s = await inspectDiskRegistryByPath(dir)
    expect(s.backend).toBe("disk")
    expect(s.sessions).toBe(2)
    expect(s.totalBytes).toBeGreaterThan(0)
    expect(s.available).toBe(true)
    cleanup()
  })

  test("[5] missing disk dir → available=false, NO-THROW", async () => {
    const missing = join(tmpdir(), `quanta-adr0370-nonexistent-${Date.now()}`)
    const s = await inspectDiskRegistryByPath(missing)
    expect(s.backend).toBe("disk")
    expect(s.sessions).toBe(0)
    expect(s.available).toBe(false)
  })

  test("[6] empty sqlite → backend=sqlite, sessions=0", async () => {
    const { dir, cleanup } = makeTmpDir("sql-empty")
    const path = join(dir, "registry.db")
    // Bootstrap schema (cannot inspect a non-existent file in readonly mode).
    const seed = new Database(path)
    applyMigrations(seed)
    seed.close()
    const s = await inspectSqliteRegistryByPath(path)
    expect(s.backend).toBe("sqlite")
    expect(s.sessions).toBe(0)
    expect(s.totalEvents).toBe(0)
    expect(s.totalCacheEntries).toBe(0)
    expect(s.totalBytes).toBe(0)
    expect(s.available).toBe(true)
    cleanup()
  })

  test("[7] populated sqlite → sessions + events + cache counted", async () => {
    const { dir, cleanup } = makeTmpDir("sql-full")
    const path = join(dir, "registry.db")
    const reg = createSqliteSessionResourceRegistry({ databasePath: path })
    const r = reg.getOrCreate("s1")
    r.store.append({ kind: "mode_change", prev: "a", next: "b", at: 1 })
    r.store.append({ kind: "mode_change", prev: "b", next: "c", at: 2 })
    // Need a real cache key — use asCacheKey shape (cache builds on miss).
    const { asCacheKey } = await import("@/llm/system-prompt-cache")
    r.cache.getOrBuild(asCacheKey("k1"), () => "hello prompt text")
    const s = await inspectSqliteRegistryByPath(path)
    expect(s.backend).toBe("sqlite")
    expect(s.sessions).toBeGreaterThanOrEqual(1)
    expect(s.totalEvents).toBeGreaterThanOrEqual(2)
    expect(s.totalCacheEntries).toBeGreaterThanOrEqual(1)
    expect(s.totalBytes).toBeGreaterThan(0)
    expect(s.available).toBe(true)
    cleanup()
  })

  test("[8] sqlite walSize is a number ≥ 0", async () => {
    const { dir, cleanup } = makeTmpDir("sql-wal")
    const path = join(dir, "registry.db")
    // Open + write so WAL is created.
    const reg = createSqliteSessionResourceRegistry({ databasePath: path })
    reg.getOrCreate("s1")
    const s = await inspectSqliteRegistryByPath(path)
    expect(typeof s.walSize).toBe("number")
    expect(s.walSize ?? -1).toBeGreaterThanOrEqual(0)
    cleanup()
  })

  test("[9] missing sqlite path → available=false, NO-THROW", async () => {
    const missing = join(tmpdir(), `quanta-adr0370-no-sqlite-${Date.now()}.db`)
    const s = await inspectSqliteRegistryByPath(missing)
    expect(s.backend).toBe("sqlite")
    expect(s.available).toBe(false)
    expect(s.sessions).toBe(0)
  })

  test("[10] env not set → inspectGlobal → in-memory", async () => {
    delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
    delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
    const s = await inspectGlobalRegistry()
    expect(s.backend).toBe("in-memory")
  })

  test("[11] env precedence — sqlite > disk", async () => {
    const { dir, cleanup } = makeTmpDir("env-prec")
    const sqlitePath = join(dir, "r.db")
    const diskDir = join(dir, "disk")
    await mkdir(diskDir, { recursive: true })
    const seed = new Database(sqlitePath)
    applyMigrations(seed)
    seed.close()
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = sqlitePath
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = diskDir
    const s = await inspectGlobalRegistry()
    expect(s.backend).toBe("sqlite")
    cleanup()
  })

  test("[11a] runtime override and inspector share the mounted sqlite authority", async () => {
    const { dir, cleanup } = makeTmpDir("runtime-override")
    const sqlitePath = join(dir, "override.db")
    const diskDir = join(dir, "ambient-disk")
    await mkdir(diskDir, { recursive: true })
    const seed = new Database(sqlitePath)
    applyMigrations(seed)
    seed.close()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = diskDir
    expect(setKnobOverride("QUANTA_SESSION_REGISTRY_SQLITE_PATH", sqlitePath)).toBe(true)

    getGlobalSessionResourceRegistry()
    const s = await inspectGlobalRegistry()

    expect(s.backend).toBe("sqlite")
    expect(s.path).toBe(sqlitePath)
    cleanup()
  })

  test("[11b] inspector reports the actual disk fallback after sqlite mount failure", async () => {
    const { dir, cleanup } = makeTmpDir("mount-fallback")
    const invalidSqlitePath = join(dir, "sqlite-is-a-directory")
    const diskDir = join(dir, "disk")
    await mkdir(invalidSqlitePath, { recursive: true })
    await mkdir(diskDir, { recursive: true })
    expect(setKnobOverride("QUANTA_SESSION_REGISTRY_SQLITE_PATH", invalidSqlitePath)).toBe(true)
    expect(setKnobOverride("QUANTA_SESSION_REGISTRY_DISK_DIR", diskDir)).toBe(true)

    getGlobalSessionResourceRegistry()
    const s = await inspectGlobalRegistry()

    expect(s.backend).toBe("disk")
    expect(s.path).toBe(diskDir)
    cleanup()
  })

  test("[12] formatter contains backend tag + Session Registry title", () => {
    const out = formatRegistryStats({
      backend: "in-memory",
      sessions: 7,
      available: true,
    })
    expect(out).toContain("Session Registry")
    expect(out).toContain("in-memory")
    expect(out).toContain("Sessions:")
    expect(out).toContain("7")
  })

  test("[13] formatter renders 'unavailable' when available=false", () => {
    const out = formatRegistryStats({
      backend: "disk",
      sessions: 0,
      available: false,
    })
    expect(out).toContain("unavailable")
    expect(out).toContain("disk")
  })

  test("[14] formatter — sqlite backend shows Codex parity tag", () => {
    const out = formatRegistryStats({
      backend: "sqlite",
      sessions: 1,
      totalEvents: 5,
      totalCacheEntries: 2,
      totalBytes: 1024,
      walSize: 0,
      available: true,
    })
    expect(out).toContain("Codex")
    expect(out).toContain("WAL size")
    expect(out).toContain("Events")
    expect(out).toContain("Cache entries")
  })

  test("[15] formatter — disk backend (Codex parity NOT shown)", () => {
    const out = formatRegistryStats({
      backend: "disk",
      sessions: 3,
      totalBytes: 4096,
      available: true,
    })
    expect(out).toContain("disk")
    expect(out).toContain("Sessions:")
    expect(out).toContain("3")
    expect(out).toContain("Total bytes")
    // No Codex parity tag — disk backend is JSONL, not Codex's sqlite.
    expect(out).not.toContain("Codex")
  })

  // ─────────────────────────────────────────────────────────────────────
  // ADR-0377 — cross-platform inspector path normalization (Codex parity
  // = POSIX style forward slashes). Backslash → forward slash; no home
  // expansion; no absolute → relative rewrite.
  // ─────────────────────────────────────────────────────────────────────

  test("[16] ADR-0377 disk path with backslashes → forward slash only", async () => {
    // POSIX accepts backslash as a literal filename char so readdir
    // simply fails (available=false). The path field must still echo
    // the input with backslashes flipped — operator visibility holds
    // even on the unavailable branch.
    const winLike = String.raw`C:\Users\op\AppData\Local\quanta\disk`
    const s = await inspectDiskRegistryByPath(winLike)
    expect(s.backend).toBe("disk")
    expect(s.path).toBe("C:/Users/op/AppData/Local/quanta/disk")
    expect(s.path).not.toContain("\\")
  })

  test("[17] ADR-0377 disk path already forward-slash → unchanged", async () => {
    const { dir, cleanup } = makeTmpDir("disk-norm-fwd")
    const s = await inspectDiskRegistryByPath(dir)
    expect(s.path).toBe(dir.replace(/\\/g, "/"))
    expect(s.path).not.toContain("\\")
    cleanup()
  })

  test("[18] ADR-0377 disk path with mixed separators → all flipped", async () => {
    const mixed = String.raw`C:/Users\op/AppData\Local/quanta`
    const s = await inspectDiskRegistryByPath(mixed)
    expect(s.path).toBe("C:/Users/op/AppData/Local/quanta")
    expect(s.path).not.toContain("\\")
  })

  test("[19] ADR-0377 sqlite path with backslashes → forward slash only", async () => {
    const winLike = String.raw`C:\Users\op\AppData\Local\quanta\registry.db`
    const s = await inspectSqliteRegistryByPath(winLike)
    expect(s.backend).toBe("sqlite")
    expect(s.path).toBe("C:/Users/op/AppData/Local/quanta/registry.db")
    expect(s.path).not.toContain("\\")
  })

  test("[20] ADR-0377 in-memory backend → no path field", () => {
    const reg = createInMemorySessionResourceRegistry()
    const s = inspectInMemoryRegistry(reg)
    expect(s.backend).toBe("in-memory")
    expect(s.path).toBeUndefined()
  })

  test("[21] ADR-0377 formatter renders Path: line for disk backend", () => {
    const out = formatRegistryStats({
      backend: "disk",
      sessions: 2,
      totalBytes: 1024,
      path: "C:/Users/op/AppData/Local/quanta/disk",
      available: true,
    })
    expect(out).toContain("Path:")
    expect(out).toContain("C:/Users/op/AppData/Local/quanta/disk")
    expect(out).not.toContain("\\")
  })

  test("[22] ADR-0377 formatter renders Path: line for sqlite backend", () => {
    const out = formatRegistryStats({
      backend: "sqlite",
      sessions: 1,
      totalEvents: 5,
      totalCacheEntries: 2,
      totalBytes: 1024,
      walSize: 0,
      path: "/Users/op/.quanta/sessions.sqlite",
      available: true,
    })
    expect(out).toContain("Path:")
    expect(out).toContain("/Users/op/.quanta/sessions.sqlite")
  })

  test("[23] ADR-0377 formatter omits Path: line for in-memory backend", () => {
    const out = formatRegistryStats({
      backend: "in-memory",
      sessions: 3,
      available: true,
    })
    // in-memory has no on-disk path; the Path: row must not be rendered.
    expect(out).not.toContain("Path:")
  })
})
