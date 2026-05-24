import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  exportSession,
  exportSessionToFile,
  exportSessionToJson,
  importSession,
  importSessionFromFile,
  importSessionFromJson,
  type SavedSession,
  SESSION_VERSION,
  type SessionExportEnvelope,
  type SessionExportOpts,
  SessionImportError,
  type SessionImportOpts,
} from "@/session"

/**
 * Session import/export — hellgate (ADR-0157).
 *
 * Closed-port primitive: SavedSession → versioned wire envelope (+ sidecar) →
 * SavedSession. Hellgate seals the 6 contract clauses across 5 slices:
 *
 *   A. Round-trip purity (4)
 *   B. Validation (5)
 *   C. Version delta (3)
 *   D. Platform delta (2)
 *   E. FS adapter (2)
 */

const QV = "0.1.0-test"

const savedSessionOf = (over: Partial<SavedSession> = {}): SavedSession => ({
  version: SESSION_VERSION,
  meta: {
    id: "sess-abc-123",
    title: "test session",
    cwd: "/tmp/work",
    createdAt: 1_700_000_000_000,
    lastTouched: 1_700_000_500_000,
    archived: false,
  },
  reason: "test",
  turns: 3,
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi back" }] },
  ],
  ...over,
})

const exportOpts = (over: Partial<SessionExportOpts> = {}): SessionExportOpts => ({
  quantaVersion: QV,
  platform: "linux",
  now: () => 1_700_000_999_000,
  ...over,
})

const importOpts = (over: Partial<SessionImportOpts> = {}): SessionImportOpts => ({
  quantaVersion: QV,
  platform: "linux",
  ...over,
})

// ────────────────────────────────────────────────────────────────────────────
// A. ROUND-TRIP PURITY (4)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / A. round-trip purity", () => {
  test("HELL-1: export → import returns structurally-equal session", () => {
    const session = savedSessionOf()
    const env = exportSession(session, exportOpts())
    const res = importSession(env, importOpts())
    expect(res.session).toEqual(session)
  })

  test("HELL-2: envelope.exporterMeta carries quantaVersion + platform", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ platform: "darwin" }))
    expect(env.exporterMeta.quantaVersion).toBe(QV)
    expect(env.exporterMeta.platform).toBe("darwin")
  })

  test("HELL-3: exportedAt uses injected now()", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ now: () => 42_000 }))
    expect(env.exportedAt).toBe(42_000)
  })

  test("HELL-4: sidecar fields preserved through round-trip", () => {
    const env = exportSession(
      savedSessionOf(),
      exportOpts({
        sidecar: {
          conversationCheckpoint: '{"ckpt":1}',
          budgetLedger: '{"events":[]}',
          planQueue: '{"items":[]}',
        },
      }),
    )
    const res = importSession(env, importOpts())
    expect(res.sidecar?.conversationCheckpoint).toBe('{"ckpt":1}')
    expect(res.sidecar?.budgetLedger).toBe('{"events":[]}')
    expect(res.sidecar?.planQueue).toBe('{"items":[]}')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. VALIDATION (5)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / B. validation", () => {
  test("HELL-5: unknown version throws unsupported-version", () => {
    // ADR-0170: v1 and v2 are now both supported. Use version=99 to sentinel
    // an envelope from a hypothetical future build the current importer
    // cannot understand.
    const env = {
      ...exportSession(savedSessionOf(), exportOpts()),
      version: 99,
    } as unknown as SessionExportEnvelope
    try {
      importSession(env, importOpts())
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("unsupported-version")
    }
  })

  test("HELL-6: malformed envelope (missing fields) throws malformed", () => {
    const broken = { version: 1 } as unknown as SessionExportEnvelope
    try {
      importSession(broken, importOpts())
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("malformed")
    }
  })

  test("HELL-7: JSON parse failure → malformed (importSessionFromJson)", () => {
    try {
      importSessionFromJson("{not json", importOpts())
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("malformed")
    }
  })

  test("HELL-8: empty messages array is valid", () => {
    const session = savedSessionOf({ messages: [] })
    const env = exportSession(session, exportOpts())
    const res = importSession(env, importOpts())
    expect(res.session.messages).toEqual([])
  })

  test("HELL-9: exactOptional — absent sidecar omitted from envelope entirely", () => {
    const env = exportSession(savedSessionOf(), exportOpts())
    expect("sidecar" in env).toBe(false)
    const res = importSession(env, importOpts())
    expect("sidecar" in res).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. VERSION DELTA (3)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / C. version delta", () => {
  test("HELL-10: same quantaVersion → versionDelta.same = true, no warnings", () => {
    const env = exportSession(savedSessionOf(), exportOpts())
    const res = importSession(env, importOpts())
    expect(res.versionDelta.same).toBe(true)
    expect(res.versionDelta.importerQuanta).toBe(QV)
    expect(res.versionDelta.exporterQuanta).toBe(QV)
    expect(res.warnings).toEqual([])
  })

  test("HELL-11: different quantaVersion → warnings include version mismatch", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ quantaVersion: "9.9.9" }))
    const res = importSession(env, importOpts())
    expect(res.versionDelta.same).toBe(false)
    expect(res.versionDelta.exporterQuanta).toBe("9.9.9")
    expect(res.warnings.some((w) => w.includes("version mismatch"))).toBe(true)
  })

  test("HELL-12: strictVersion + mismatch throws version-mismatch", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ quantaVersion: "9.9.9" }))
    try {
      importSession(env, importOpts({ strictVersion: true }))
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("version-mismatch")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. PLATFORM DELTA (2)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / D. platform delta", () => {
  test("HELL-13: different platform → warnings include platform note", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ platform: "darwin" }))
    const res = importSession(env, importOpts({ platform: "linux" }))
    expect(res.warnings.some((w) => w.includes("platform mismatch"))).toBe(true)
  })

  test("HELL-14: same platform → no platform warning", () => {
    const env = exportSession(savedSessionOf(), exportOpts({ platform: "linux" }))
    const res = importSession(env, importOpts({ platform: "linux" }))
    expect(res.warnings.some((w) => w.includes("platform"))).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. FS ADAPTER (2)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / E. fs adapter", () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "session-export-"))
  })

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  test("HELL-15: exportSessionToFile + importSessionFromFile round-trip", async () => {
    const session = savedSessionOf()
    const path = join(tmp, "envelope.json")
    await exportSessionToFile(session, exportOpts(), path)
    const res = await importSessionFromFile(path, importOpts())
    expect(res.session).toEqual(session)
  })

  test("HELL-16: importSessionFromFile on missing file → typed error", async () => {
    const path = join(tmp, "does-not-exist.json")
    try {
      await importSessionFromFile(path, importOpts())
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("malformed")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// EXTRA: deep-clone isolation (caller mutating after export does NOT corrupt
// the envelope). Documents Contract clause #5.
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export / extra. clone isolation", () => {
  test("HELL-17: mutating source session after export does not affect envelope", () => {
    const session = savedSessionOf()
    const env = exportSession(session, exportOpts())
    // Mutate the live source's messages — envelope must NOT change.
    session.messages.push({ role: "user", content: [{ type: "text", text: "mutated" }] })
    expect(env.session.messages.length).toBe(2)
  })

  test("HELL-18: exportSessionToJson produces JSON that round-trips via importSessionFromJson", () => {
    const session = savedSessionOf()
    const json = exportSessionToJson(session, exportOpts())
    const res = importSessionFromJson(json, importOpts())
    expect(res.session).toEqual(session)
  })
})
