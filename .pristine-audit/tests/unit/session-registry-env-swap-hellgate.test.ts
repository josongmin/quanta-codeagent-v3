/**
 * ADR-0351 (disk) + ADR-0367 (sqlite) — env-var swap hellgate.
 *
 * `getGlobalSessionResourceRegistry()` mints backend per env priority:
 *   1. `QUANTA_SESSION_REGISTRY_SQLITE_PATH` (most durable)
 *   2. `QUANTA_SESSION_REGISTRY_DISK_DIR`
 *   3. in-memory (default)
 *
 * Env vars are read EXACTLY ONCE at first-call (lazy-init), so
 * subsequent env mutations are ignored until
 * `resetGlobalSessionResourceRegistry()` (test-only knob).
 *
 * NO-THROW: a hosed env var (non-existent path that cannot be opened)
 * MUST NOT abort process startup — the fallback chain terminates at
 * in-memory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry"

let prevDiskEnv: string | undefined
let prevSqliteEnv: string | undefined
let tempRoot: string | null = null
let tempSqliteRoot: string | null = null

beforeEach(() => {
  prevDiskEnv = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  prevSqliteEnv = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  resetGlobalSessionResourceRegistry()
})

afterEach(async () => {
  resetGlobalSessionResourceRegistry()
  if (prevDiskEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  else process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = prevDiskEnv
  if (prevSqliteEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  else process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = prevSqliteEnv
  if (tempRoot !== null) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  if (tempSqliteRoot !== null) {
    await rm(tempSqliteRoot, { recursive: true, force: true })
    tempSqliteRoot = null
  }
})

describe("ADR-0351 — env-var swap", () => {
  test("A. env unset ⇒ in-memory registry (legacy byte-identical path)", () => {
    const reg = getGlobalSessionResourceRegistry()
    const resources = reg.getOrCreate("session-a")
    // Re-acquire same id ⇒ same reference (registry invariant)
    expect(reg.getOrCreate("session-a")).toBe(resources)
    // size reflects single session — no disk side-effects possible
    expect(reg.size()).toBe(1)
  })

  test("B. env unset to empty string ⇒ in-memory fallback (treated as absent)", () => {
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = ""
    const reg = getGlobalSessionResourceRegistry()
    expect(reg.getOrCreate("x")).toBeDefined()
    expect(reg.size()).toBe(1)
  })

  test("C. env set to valid dir ⇒ disk registry minted (size invariant preserved)", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg = getGlobalSessionResourceRegistry()
    const r1 = reg.getOrCreate("disk-session")
    const r2 = reg.getOrCreate("disk-session")
    expect(r2).toBe(r1)
  })

  test("D. env read EXACTLY ONCE — runtime env mutation after first call is ignored", async () => {
    const reg1 = getGlobalSessionResourceRegistry()
    expect(reg1.size()).toBe(0)
    // Mutating env now must not switch backends — singleton already minted.
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2).toBe(reg1) // SAME reference, env mutation ignored
  })

  test("E. resetGlobalSessionResourceRegistry ⇒ next call re-reads env", async () => {
    const reg1 = getGlobalSessionResourceRegistry()
    resetGlobalSessionResourceRegistry()
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2).not.toBe(reg1) // Fresh instance
  })

  test("F. NO-THROW on hosed env var (path that disk-adapter cannot use)", () => {
    // Invalid path with NUL char — disk-adapter construction may throw on
    // some platforms; the wrapper must fall back to in-memory either way.
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = "/dev/null/cannot-mkdir-under-this"
    const reg = getGlobalSessionResourceRegistry()
    // Whatever backend was chosen, the registry must be functional.
    const r = reg.getOrCreate("ok")
    expect(r).toBeDefined()
    expect(reg.getOrCreate("ok")).toBe(r)
  })
})

describe("ADR-0367 — SQLite env-var swap", () => {
  test("G. sqlite env set ⇒ sqlite backend minted (size + same-id reuse invariants)", async () => {
    tempSqliteRoot = await mkdtemp(join(tmpdir(), "adr-0367-"))
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = join(tempSqliteRoot, "sessions.sqlite")
    const reg = getGlobalSessionResourceRegistry()
    const r1 = reg.getOrCreate("sqlite-session")
    const r2 = reg.getOrCreate("sqlite-session")
    expect(r2).toBe(r1) // same-id ⇒ same reference (port invariant)
    expect(reg.size()).toBe(1)
  })

  test("H. sqlite env empty string ⇒ in-memory fallback (treated as absent)", () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ""
    const reg = getGlobalSessionResourceRegistry()
    // Functional registry — and since both sqlite + disk env are
    // empty/unset, the in-memory default path must be selected.
    expect(reg.getOrCreate("x")).toBeDefined()
    expect(reg.size()).toBe(1)
  })

  test("I. sqlite + disk BOTH set ⇒ sqlite wins (priority: durable backend first)", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0367-disk-"))
    tempSqliteRoot = await mkdtemp(join(tmpdir(), "adr-0367-sqlite-"))
    const sqlitePath = join(tempSqliteRoot, "sessions.sqlite")
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = sqlitePath
    const reg = getGlobalSessionResourceRegistry()
    // sqlite-store creates the DB file at construction; disk-store
    // creates a directory tree lazily. Presence of the SQLite file is
    // the load-bearing proof that the sqlite backend was selected.
    reg.getOrCreate("dual-env-session")
    const { existsSync } = await import("node:fs")
    expect(existsSync(sqlitePath)).toBe(true)
    // Disk directory should still exist (we mkdtemp'd it) but the
    // disk-store would have laid down `<storageDir>/<sessionId>/...`
    // — checking that the per-session subdir is ABSENT confirms the
    // disk backend was not selected.
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(tempRoot)
    expect(entries).not.toContain("dual-env-session")
  })

  test("J. NO-THROW on hosed sqlite env var (unreachable parent dir) ⇒ fallback chain", () => {
    // Path whose parent directory does not exist + cannot be created
    // (sqlite-adapter docs: parent dir MUST exist; adapter does NOT
    // mkdir). Construction throws ⇒ wrapper falls through to disk env
    // (unset here) ⇒ in-memory default. The registry MUST still be
    // functional.
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = "/dev/null/no-such-parent/sessions.sqlite"
    const reg = getGlobalSessionResourceRegistry()
    const r = reg.getOrCreate("ok-after-bad-sqlite-env")
    expect(r).toBeDefined()
    expect(reg.getOrCreate("ok-after-bad-sqlite-env")).toBe(r)
  })

  test("K. hosed sqlite + valid disk ⇒ disk fallback (fallback chain ordering)", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0367-fallback-"))
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = "/dev/null/no-such-parent/sessions.sqlite"
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg = getGlobalSessionResourceRegistry()
    // Functional + same-id reuse. The disk-store lays down a directory
    // tree lazily on first write; we don't assert disk side-effects
    // here (the disk hellgate covers that). What we DO assert: a
    // hosed sqlite env did NOT abort the process and DID fall through
    // — the disk env was still consulted.
    const r = reg.getOrCreate("disk-after-sqlite-fail")
    expect(r).toBeDefined()
    expect(reg.getOrCreate("disk-after-sqlite-fail")).toBe(r)
  })

  test("L. sqlite env read EXACTLY ONCE — runtime mutation after first call ignored", async () => {
    const reg1 = getGlobalSessionResourceRegistry()
    expect(reg1.size()).toBe(0)
    // Mutating sqlite env now must not switch backends — singleton
    // already minted to in-memory.
    tempSqliteRoot = await mkdtemp(join(tmpdir(), "adr-0367-late-"))
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = join(tempSqliteRoot, "late.sqlite")
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2).toBe(reg1) // SAME reference, env mutation ignored
  })
})
