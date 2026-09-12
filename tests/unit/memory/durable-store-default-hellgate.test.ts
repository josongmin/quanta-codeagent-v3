/**
 * ADR-0557 HELLGATE — the long-term memory store is DURABLE by default, at a
 * HOME-scoped path, and never crashes the session.
 *
 * Measured before this ADR (see the ADR's Context): unset / seeded
 * `QUANTA_MEMORY=1` resolved to the volatile `InMemoryStore`, so the
 * default-ON store persisted NOTHING across launches (second construction ⇒
 * `all().length === 0`); `QUANTA_MEMORY=sqlite` opened a CWD-relative
 * `.quanta/memory.sqlite` whose parent was never created ⇒ `bun:sqlite`
 * threw and session boot crashed in any repo without a `.quanta/` dir.
 *
 *   D1 — env `{}` and `{QUANTA_MEMORY:"1"}` ⇒ kind=sqlite at
 *        `<home>/.quanta/memory/memory.sqlite`
 *   D2 — PERSISTENCE: put, rebuild with the same env/home, recall finds it
 *   D3 — DIRECTORY CREATION: no `memory/` under the quanta home ⇒ construction succeeds
 *   D4 — paired controls: `=memory` ⇒ InMemoryStore; `=off` ⇒ no store;
 *        `QUANTA_MEMORY_PATH=<x>` ⇒ that path
 *   D5 — LEGACY: `<cwd>/.quanta/memory.sqlite` exists ⇒ that file is used and
 *        exactly ONE notice names both paths (+ paired control: no file ⇒ 0)
 *   D6 — FALLBACK: unwritable target ⇒ InMemoryStore + ONE attributed notice,
 *        no throw (skipped as root, where chmod cannot deny)
 *   D7 — WAL/shm side files land under home, NOT under cwd
 *
 * Every path is a temp dir — the real `~/.quanta/` is never touched:
 * `override.homeDir` / `override.cwd` are the DI seams the factory exposes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryStore, type MemoryEntry, type PersistentStorePort, SqliteStore } from "@/memory"
import { buildMemoryForSession, type MemorySessionOverride } from "@/runner/assemble"

let home: string
let cwd: string
let notices: string[]
const opened: PersistentStorePort[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "durable-home-"))
  cwd = mkdtempSync(join(tmpdir(), "durable-cwd-"))
  notices = []
})

afterEach(() => {
  for (const s of opened.splice(0)) if (s instanceof SqliteStore) s.close()
  // D6 may have locked the tree; unlock before removal.
  for (const d of [join(home, ".quanta"), home]) if (existsSync(d)) chmodSync(d, 0o700)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const env = (e: Record<string, string> = {}): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv

/** Build through the REAL factory with the temp home/cwd injected. */
const build = (e: NodeJS.ProcessEnv, extra: MemorySessionOverride = {}) => {
  const slot = buildMemoryForSession(e, {
    homeDir: home,
    cwd,
    onStoreNotice: (line) => notices.push(line),
    ...extra,
  })
  if (slot.store) opened.push(slot.store)
  return slot
}

/** `override.homeDir` is the QUANTA HOME, so the store sits at `<home>/memory/…`.
 *  It used to be an OS home joined with `.quanta/memory`, which is why memory was the
 *  one plane a relocated `QUANTA_HOME` did not move. With nothing set the resolved
 *  path is unchanged (`quantaHomeDirFrom({})` is `~/.quanta`); only the meaning of
 *  this injected root changed. */
const expectedDefault = (): string => join(home, "memory", "memory.sqlite")

const entry = (id: string, text: string): MemoryEntry => ({
  id,
  kind: "fact",
  text,
  tags: [],
  createdAt: Date.now(),
})

/* ------------------------------------------------------------------ */
/* D1 — default kind + path                                            */
/* ------------------------------------------------------------------ */

describe("D1 — the default store is sqlite at the quanta-home-scoped path", () => {
  test.each([
    {},
    { QUANTA_MEMORY: "1" },
    { QUANTA_MEMORY: "true" },
  ])("env %p ⇒ kind=sqlite, storePath=<quanta-home>/memory/memory.sqlite", (e) => {
    const slot = build(env(e))
    expect(slot.kind).toBe("sqlite")
    expect(slot.storePath).toBe(expectedDefault())
    expect(slot.store).toBeInstanceOf(SqliteStore)
    expect(existsSync(expectedDefault())).toBe(true)
    // Nothing was dropped into the cwd.
    expect(readdirSync(cwd)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* D2 — persistence across constructions                               */
/* ------------------------------------------------------------------ */

describe("D2 — an entry put through the default store survives a rebuild", () => {
  test("put → build again (same env/home) → recall finds it", async () => {
    const first = build(env({ QUANTA_MEMORY: "1" }))
    if (!first.store) throw new Error("default must yield a store")
    await first.store.save(entry("d2", "user prefers tabs over spaces"))
    if (first.store instanceof SqliteStore) first.store.close()
    opened.splice(0)

    const second = build(env({ QUANTA_MEMORY: "1" }))
    if (!second.store) throw new Error("default must yield a store")
    const hits = await second.store.recall({ text: "tabs" })
    expect(hits.map((h) => h.id)).toEqual(["d2"])
    expect((await second.store.all()).length).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* D3 — the parent directory is created on open                        */
/* ------------------------------------------------------------------ */

describe("D3 — a home with no memory/ does not crash the open", () => {
  test("construction succeeds and creates <quanta-home>/memory/", () => {
    expect(existsSync(join(home, "memory"))).toBe(false)
    expect(() => build(env({}))).not.toThrow()
    expect(existsSync(join(home, "memory"))).toBe(true)
    expect(existsSync(expectedDefault())).toBe(true)
  })

  test("SqliteStore itself creates a missing parent (nested path)", () => {
    const p = join(home, "a", "b", "c", "m.sqlite")
    const s = new SqliteStore(p)
    opened.push(s)
    expect(existsSync(p)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* D4 — paired controls                                                */
/* ------------------------------------------------------------------ */

describe("D4 — explicit volatile / off / explicit path are preserved", () => {
  test("QUANTA_MEMORY=memory ⇒ InMemoryStore, kind=memory, no storePath, no file under home", () => {
    const slot = build(env({ QUANTA_MEMORY: "memory" }))
    expect(slot.store).toBeInstanceOf(InMemoryStore)
    expect(slot.kind).toBe("memory")
    expect(slot.storePath).toBeUndefined()
    expect(existsSync(join(home, ".quanta"))).toBe(false)
  })

  test.each(["off", "0", "false", "no"])("QUANTA_MEMORY=%p ⇒ no store, nothing on disk", (v) => {
    const slot = build(env({ QUANTA_MEMORY: v }))
    expect(slot).toEqual({})
    expect(existsSync(join(home, ".quanta"))).toBe(false)
  })

  test("QUANTA_MEMORY_PATH=<x> wins over the home default", () => {
    const p = join(cwd, "explicit", "x.sqlite")
    const slot = build(env({ QUANTA_MEMORY_PATH: p }))
    expect(slot.kind).toBe("sqlite")
    expect(slot.storePath).toBe(p)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(join(home, ".quanta"))).toBe(false)
  })

  test("override.storePath wins over QUANTA_MEMORY_PATH", () => {
    const envPath = join(cwd, "env.sqlite")
    const overridePath = join(cwd, "override.sqlite")
    const slot = build(env({ QUANTA_MEMORY_PATH: envPath }), { storePath: overridePath })
    expect(slot.storePath).toBe(overridePath)
    expect(existsSync(overridePath)).toBe(true)
    expect(existsSync(envPath)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* D5 — legacy cwd-relative file is honored, with ONE notice           */
/* ------------------------------------------------------------------ */

describe("D5 — legacy <cwd>/.quanta/memory.sqlite keeps being used (honest, not silent)", () => {
  const legacy = (): string => join(cwd, ".quanta", "memory.sqlite")

  test("legacy file present + no explicit path ⇒ that file is the store, exactly one notice naming both paths", async () => {
    mkdirSync(join(cwd, ".quanta"), { recursive: true })
    const seed = new SqliteStore(legacy())
    await seed.save(entry("legacy1", "old cwd-scoped memory"))
    seed.close()

    const slot = build(env({ QUANTA_MEMORY: "1" }))
    expect(slot.kind).toBe("sqlite")
    expect(slot.storePath).toBe(legacy())
    // The user's data is where they left it — not moved, not copied.
    expect(existsSync(expectedDefault())).toBe(false)
    if (!slot.store) throw new Error("legacy must yield a store")
    expect((await slot.store.recall({ text: "old" })).map((h) => h.id)).toEqual(["legacy1"])

    expect(notices).toHaveLength(1)
    const line = notices[0] as string
    expect(line).toContain(legacy())
    expect(line).toContain(expectedDefault())
    expect(line).toMatch(/\bmv\b/)
  })

  test("legacy file present BUT QUANTA_MEMORY_PATH set ⇒ explicit path wins, zero notices", () => {
    mkdirSync(join(cwd, ".quanta"), { recursive: true })
    writeFileSync(legacy(), "")
    const p = join(cwd, "explicit.sqlite")
    const slot = build(env({ QUANTA_MEMORY_PATH: p }))
    expect(slot.storePath).toBe(p)
    expect(notices).toHaveLength(0)
  })

  test("paired control: no legacy file ⇒ home default, zero notices", () => {
    const slot = build(env({}))
    expect(slot.storePath).toBe(expectedDefault())
    expect(notices).toHaveLength(0)
  })

  test("legacy is honored for explicit QUANTA_MEMORY=sqlite too (its old default path)", () => {
    mkdirSync(join(cwd, ".quanta"), { recursive: true })
    writeFileSync(legacy(), "")
    const slot = build(env({ QUANTA_MEMORY: "sqlite" }))
    expect(slot.storePath).toBe(legacy())
    expect(notices).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* D6 — open failure falls back to volatile, attributed, never throws  */
/* ------------------------------------------------------------------ */

describe("D6 — a store-open failure never kills the session", () => {
  const isRoot = process.getuid?.() === 0
  test.skipIf(isRoot)(
    "an unwritable <quanta-home> ⇒ InMemoryStore + kind=memory + ONE attributed notice, no throw",
    () => {
      // The store's parent is `<quanta-home>/memory`; denying write on the home
      // itself is what stops `mkdir -p` from creating it.
      chmodSync(home, 0o500)
      let slot: ReturnType<typeof build> | undefined
      expect(() => {
        slot = build(env({ QUANTA_MEMORY: "1" }))
      }).not.toThrow()
      expect(slot?.store).toBeInstanceOf(InMemoryStore)
      expect(slot?.kind).toBe("memory")
      expect(slot?.storePath).toBeUndefined()
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain(expectedDefault())
      expect(notices[0]).toMatch(/volatile/i)
      // The config slot still composes (the session is intact).
      expect(slot?.config).toBeDefined()
    },
  )

  test.skipIf(isRoot)("unwritable explicit QUANTA_MEMORY_PATH parent ⇒ same fallback", () => {
    const locked = join(cwd, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      const slot = build(env({ QUANTA_MEMORY_PATH: join(locked, "x.sqlite") }))
      expect(slot.store).toBeInstanceOf(InMemoryStore)
      expect(slot.kind).toBe("memory")
      expect(notices).toHaveLength(1)
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

/* ------------------------------------------------------------------ */
/* D7 — WAL side files live under home, never under cwd                */
/* ------------------------------------------------------------------ */

describe("D7 — WAL/shm side files land under home, not under cwd", () => {
  test("after a write, -wal/-shm sit next to the home-scoped db; cwd stays empty", async () => {
    const slot = build(env({}))
    if (!slot.store) throw new Error("default must yield a store")
    await slot.store.save(entry("d7", "wal probe"))
    const dir = join(home, "memory")
    const names = readdirSync(dir)
    expect(names).toContain("memory.sqlite")
    expect(names).toContain("memory.sqlite-wal")
    expect(names).toContain("memory.sqlite-shm")
    expect(readdirSync(cwd)).toEqual([])
    expect(existsSync(join(cwd, ".quanta"))).toBe(false)
  })
})
