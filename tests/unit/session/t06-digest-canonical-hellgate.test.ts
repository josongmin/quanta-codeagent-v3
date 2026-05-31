import { describe, expect, test } from "bun:test"
import {
  exportSession,
  importSession,
  type SavedSession,
  SESSION_VERSION,
  type SessionExportEnvelopeV2,
  type SessionExportOpts,
  SessionImportError,
  type SessionImportOpts,
} from "@/session"

/**
 * T06 — Session export digest canonical-serialization hellgate (L9 M4).
 *
 * Root cause: the v2 integrity digest was `sha256(JSON.stringify(body))` —
 * key-ORDER dependent. A benign re-serialization that reordered object keys
 * (a JSON proxy, a Postgres `jsonb` column, a hand-rebuilt envelope) produced
 * a spurious `digest-mismatch` on an UNTAMPERED body. The digest is now over a
 * KEY-SORTED canonical string, so it is invariant to key order while still
 * catching any real value/structure change.
 */

const QV = "0.1.0-test"

const saved = (over: Partial<SavedSession["meta"]> = {}): SavedSession => ({
  version: SESSION_VERSION,
  meta: {
    id: "sess-digest",
    title: "digest test",
    cwd: "/tmp/work",
    createdAt: 1_700_000_000_000,
    lastTouched: 1_700_000_500_000,
    archived: false,
    ...over,
  },
  reason: "test",
  turns: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
})

const opts: SessionExportOpts & { emitV2: true; withDigest: true } = {
  quantaVersion: QV,
  platform: "linux",
  now: () => 1_700_000_999_000,
  emitV2: true,
  withDigest: true,
}

const importOpts: SessionImportOpts = { quantaVersion: QV, platform: "linux" }

/** Recursively reorder every object's keys (reverse-sorted) to simulate a
 *  benign re-serialization that changes key order but no values. */
const reorderKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(reorderKeys)
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort().reverse()) out[k] = reorderKeys(obj[k])
    return out
  }
  return v
}

describe("T06 / session digest canonical serialization", () => {
  test("DIGEST-1: key-reordered (untampered) body still verifies — no false digest-mismatch", () => {
    const env = exportSession(saved(), opts) as SessionExportEnvelopeV2
    expect(env.digest).toBeDefined()
    // Reorder every object's keys in the envelope (benign re-serialization).
    const reordered = reorderKeys(env) as SessionExportEnvelopeV2
    // Sanity: the wire string genuinely changed (key order differs)...
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(env))
    // ...but the canonical digest verifies — import does NOT throw.
    expect(() => importSession(reordered, importOpts)).not.toThrow()
  })

  test("DIGEST-2: a real value tamper still fails closed (digest-mismatch)", () => {
    const env = exportSession(saved(), opts) as SessionExportEnvelopeV2
    const tampered = JSON.parse(JSON.stringify(env)) as SessionExportEnvelopeV2
    ;(tampered.session.meta as { title: string }).title = "EVIL"
    try {
      importSession(tampered, importOpts)
      expect.unreachable("tampered body must throw digest-mismatch")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionImportError)
      expect((e as SessionImportError).code).toBe("digest-mismatch")
    }
  })

  test("DIGEST-3: round-trip of an unmodified envelope verifies", () => {
    const env = exportSession(saved(), opts) as SessionExportEnvelopeV2
    const result = importSession(env, importOpts)
    expect(result.session.meta.id).toBe("sess-digest")
  })
})
