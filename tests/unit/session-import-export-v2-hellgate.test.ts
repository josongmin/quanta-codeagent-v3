import { describe, expect, test } from "bun:test"
import {
  type AnySessionExportEnvelope,
  exportSession,
  exportSessionToJson,
  importSession,
  importSessionFromJson,
  type SavedSession,
  SESSION_VERSION,
  type SessionExportEnvelope,
  type SessionExportEnvelopeV2,
  type SessionExportOpts,
  SessionImportError,
  type SessionImportOpts,
} from "@/session"

/**
 * Session import/export v2 — hellgate (ADR-0170).
 *
 * Seals the v2 envelope contract additively over ADR-0157 (v1). Slices:
 *
 *   A. Export v2  (4 cases) — emitV2 flag + auto-populated trace id +
 *                              capabilities + opt-in digest + opt-out digest.
 *   B. Import v2  (4 cases) — round-trip v2 surface (v2Meta), digest verify
 *                              on tamper, strictVersion compatibility, v1
 *                              import on a v1 envelope (no v2Meta surfaces).
 *   C. Forward-compat (2)   — v1+v2 share sidecar shape; future version=3 →
 *                              `unsupported-version`.
 *   D. JSON helpers (2)     — exportSessionToJson + importSessionFromJson
 *                              honor emitV2.
 *
 * 12 cases, all closed-port. Pure module under test; no FS, no clock without
 * injection.
 */

const QV = "0.1.0-test"

const savedSessionOf = (over: Partial<SavedSession> = {}): SavedSession => ({
  version: SESSION_VERSION,
  meta: {
    id: "sess-v2-abc",
    title: "v2 test session",
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

type ExportOptsV2 = SessionExportOpts & { readonly emitV2: true }
const exportOptsV2 = (over: Partial<SessionExportOpts> = {}): ExportOptsV2 => ({
  quantaVersion: QV,
  platform: "linux",
  now: () => 1_700_000_999_000,
  ...over,
  emitV2: true,
})

type ExportOptsV1 = SessionExportOpts & { readonly emitV2?: false | undefined }
const exportOptsV1 = (
  over: Partial<Omit<SessionExportOpts, "emitV2">> & { readonly emitV2?: false } = {},
): ExportOptsV1 => {
  const base: ExportOptsV1 = {
    quantaVersion: QV,
    platform: "linux",
    now: () => 1_700_000_999_000,
  }
  // exactOptional-friendly merge: skip undefined values rather than spreading
  // them (a `Partial<...>` spread can introduce `emitV2: undefined` which
  // violates `emitV2?: false | undefined`).
  return Object.assign(base, over) as ExportOptsV1
}

const importOpts = (over: Partial<SessionImportOpts> = {}): SessionImportOpts => ({
  quantaVersion: QV,
  platform: "linux",
  ...over,
})

// ────────────────────────────────────────────────────────────────────────────
// A. EXPORT v2 (4)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export-v2 / A. export v2", () => {
  test("HELL-V2-1: emitV2:true → version===2, trace id is 16-hex, capabilities array", () => {
    const env = exportSession(savedSessionOf(), exportOptsV2())
    expect(env.version).toBe(2)
    expect(env.exporterMeta.exportTraceId).toMatch(/^[0-9a-f]{16}$/)
    expect(Array.isArray(env.exporterMeta.capabilities)).toBe(true)
    expect(env.exporterMeta.capabilities.length).toBeGreaterThan(0)
  })

  test("HELL-V2-2: annotations passed through to envelope as-is", () => {
    const env = exportSession(
      savedSessionOf(),
      exportOptsV2({ annotations: { reviewer: "alice", priority: "high" } }),
    )
    expect(env.annotations).toEqual({ reviewer: "alice", priority: "high" })
  })

  test("HELL-V2-3: withDigest:true → digest present + algo='sha256' + hex non-empty", () => {
    const env = exportSession(savedSessionOf(), exportOptsV2({ withDigest: true }))
    expect(env.digest).toBeDefined()
    expect(env.digest?.algo).toBe("sha256")
    expect(env.digest?.hex.length).toBeGreaterThan(0)
    // sha256 hex length is 64.
    expect(env.digest?.hex.length).toBe(64)
  })

  test("HELL-V2-4: withDigest absent (default) → no digest key on envelope", () => {
    const env = exportSession(savedSessionOf(), exportOptsV2())
    expect("digest" in env).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. IMPORT v2 (4)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export-v2 / B. import v2", () => {
  test("HELL-V2-5: round-trip v2 → result.v2Meta populated with all three fields", () => {
    const env = exportSession(
      savedSessionOf(),
      exportOptsV2({
        annotations: { tag: "smoke" },
        capabilities: ["images", "documents"],
      }),
    )
    const res = importSession(env, importOpts())
    expect(res.v2Meta).toBeDefined()
    expect(res.v2Meta?.annotations).toEqual({ tag: "smoke" })
    expect(res.v2Meta?.capabilities).toEqual(["images", "documents"])
    expect(res.v2Meta?.exportTraceId).toMatch(/^[0-9a-f]{16}$/)
    // session round-trips equal.
    expect(res.session).toEqual(savedSessionOf())
  })

  test("HELL-V2-6: tampering session AFTER export (with digest) → digest-mismatch on import", () => {
    const env = exportSession(savedSessionOf(), exportOptsV2({ withDigest: true }))
    // Mutate a field of the envelope's cloned session — the wire body no
    // longer matches the digest the exporter computed. Mutable cast: the
    // exposed type is `readonly`, but a hostile transport could rewrite the
    // bytes; hellgate simulates that.
    const tampered = env as SessionExportEnvelopeV2 & {
      session: SavedSession & { meta: SavedSession["meta"] & { title: string } }
    }
    ;(tampered.session.meta as { title: string }).title = "tampered title"
    try {
      importSession(env, importOpts())
      expect.unreachable("should have thrown digest-mismatch")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("digest-mismatch")
    }
  })

  test("HELL-V2-7: strictVersion + same quantaVersion v2 envelope → no throw, v2Meta surfaces", () => {
    const env = exportSession(savedSessionOf(), exportOptsV2())
    const res = importSession(env, importOpts({ strictVersion: true }))
    expect(res.versionDelta.same).toBe(true)
    expect(res.v2Meta).toBeDefined()
    expect(res.warnings).toEqual([])
  })

  test("HELL-V2-8: v1-exported envelope → byte-identical legacy result (no v2Meta key)", () => {
    const env = exportSession(savedSessionOf(), exportOptsV1())
    expect(env.version).toBe(1)
    const res = importSession(env, importOpts())
    expect(res.session).toEqual(savedSessionOf())
    // Critical: v2Meta key must NOT exist on a v1 import result.
    expect("v2Meta" in res).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. FORWARD-COMPAT (2)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export-v2 / C. forward-compat", () => {
  test("HELL-V2-9: v1 and v2 sidecar fields share the same shape (interop)", () => {
    const sidecar = {
      conversationCheckpoint: '{"ckpt":7}',
      budgetLedger: '{"events":[]}',
      planQueue: '{"items":[]}',
    }
    const v1 = exportSession(savedSessionOf(), exportOptsV1({ sidecar }))
    const v2 = exportSession(savedSessionOf(), exportOptsV2({ sidecar }))
    expect(v1.sidecar).toEqual(sidecar)
    expect(v2.sidecar).toEqual(sidecar)
    // Both import paths return the same sidecar bytes.
    const r1 = importSession(v1, importOpts())
    const r2 = importSession(v2, importOpts())
    expect(r1.sidecar).toEqual(r2.sidecar ?? {})
  })

  test("HELL-V2-10: future version=3 → unsupported-version (correct rejection)", () => {
    const base = exportSession(savedSessionOf(), exportOptsV2()) as SessionExportEnvelopeV2
    // Synthesize a "v3" envelope by mutating the version field. The shape is
    // otherwise valid v2 — the only deciding factor must be the version
    // number itself, not adjacent fields.
    const future = { ...base, version: 3 } as unknown as AnySessionExportEnvelope
    try {
      importSession(future, importOpts())
      expect.unreachable("should have thrown unsupported-version")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("unsupported-version")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. JSON HELPERS (2)
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export-v2 / D. JSON helpers", () => {
  test("HELL-V2-11: exportSessionToJson with emitV2 → JSON parses to v2 shape", () => {
    const json = exportSessionToJson(
      savedSessionOf(),
      exportOptsV2({ annotations: { src: "ci" }, withDigest: true }),
    )
    const parsed = JSON.parse(json) as SessionExportEnvelopeV2
    expect(parsed.version).toBe(2)
    expect(parsed.exporterMeta.capabilities.length).toBeGreaterThan(0)
    expect(parsed.exporterMeta.exportTraceId).toMatch(/^[0-9a-f]{16}$/)
    expect(parsed.annotations).toEqual({ src: "ci" })
    expect(parsed.digest?.algo).toBe("sha256")
  })

  test("HELL-V2-12: importSessionFromJson on v2 JSON → v2Meta surfaces in result", () => {
    const json = exportSessionToJson(
      savedSessionOf(),
      exportOptsV2({ annotations: { src: "ci" }, withDigest: true }),
    )
    const res = importSessionFromJson(json, importOpts())
    expect(res.v2Meta).toBeDefined()
    expect(res.v2Meta?.annotations).toEqual({ src: "ci" })
    expect(res.v2Meta?.exportTraceId).toMatch(/^[0-9a-f]{16}$/)
    // Digest verification on the round-tripped JSON must pass (the bytes
    // match what the exporter signed).
    expect(res.session).toEqual(savedSessionOf())
  })
})

// ────────────────────────────────────────────────────────────────────────────
// EXTRA: v1 envelope unchanged on the wire — byte-for-byte exporter parity
// proves "default false (v1, byte-identical to today)". Belt-and-braces over
// the existing v1 hellgate's HELL-1 round-trip.
// ────────────────────────────────────────────────────────────────────────────
describe("session-import-export-v2 / extra. v1 wire parity", () => {
  test("HELL-V2-13: emitV2 absent and emitV2:false produce identical v1 envelopes", () => {
    const a = exportSession(savedSessionOf(), exportOptsV1()) as SessionExportEnvelope
    const b = exportSession(
      savedSessionOf(),
      exportOptsV1({ emitV2: false }),
    ) as SessionExportEnvelope
    expect(a).toEqual(b)
    expect(a.version).toBe(1)
    // v1 export NEVER carries v2-only fields.
    expect("annotations" in a).toBe(false)
    expect("digest" in a).toBe(false)
  })
})
