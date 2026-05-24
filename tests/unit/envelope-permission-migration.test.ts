/**
 * ADR-0135 — TurnContext envelope migration tests.
 *
 * Locks the contract:
 *   - schema_version is now a union of {1, 2}; v1 records still decode.
 *   - `permission_profile` is a union of (legacy enum) ∪ (struct).
 *   - `file_system_sandbox_policy` is OPTIONAL — absent on legacy records.
 *   - Round-trip is byte-identical for BOTH shapes (encoder never coerces).
 *   - Cross-version: legacy enum + v1 wraps → re-encode → byte-identical v1.
 */
import { describe, expect, test } from "bun:test"
import {
  decodeSessionLine,
  encodeSessionLine,
  type SessionEnvelopeRecord,
  SessionEnvelopeRecordSchema,
  TurnContextRecordSchema,
} from "@/session"

const isoNow = "2026-05-21T00:00:00.000Z"

/** A pristine v1-shaped turn_context (legacy enum + no FSP). */
const legacyTurn = (): SessionEnvelopeRecord =>
  ({
    type: "turn_context",
    schema_version: 1,
    turn_id: "t-1",
    cwd: "/tmp",
    current_date: isoNow,
    timezone: "America/Los_Angeles",
    approval_policy: "on-request",
    sandbox_policy: "workspace-write",
    permission_profile: "default", // legacy enum
    model: "gpt-5",
    personality: "default",
    collaboration_mode: "solo",
    realtime_active: false,
    effort: "medium",
    summary: "",
    user_instructions: "",
    truncation_policy: "none",
    parent_thread_id: null,
    thread_role: "root",
  }) as SessionEnvelopeRecord

/** A v2-shaped turn_context (struct permission_profile + FSP). */
const v2Turn = (): SessionEnvelopeRecord =>
  ({
    type: "turn_context",
    schema_version: 2,
    turn_id: "t-2",
    cwd: "/repo",
    current_date: isoNow,
    timezone: "UTC",
    approval_policy: "never",
    sandbox_policy: "read-only",
    permission_profile: {
      fileSystem: {
        type: "restricted",
        entries: [{ path: { type: "special", kind: "project" }, access: "write" }],
      },
      approval: { mode: "session", promptUser: true },
      network: { mode: "allow-list", allowHosts: ["api.openai.com"] },
      sandbox: {
        osSandbox: "seatbelt",
        readOnly: false,
        workspaceWrite: true,
        networkIsolated: true,
      },
      control: { managedBy: "team", auditRequired: true },
    },
    model: "gpt-5",
    personality: "default",
    collaboration_mode: "supervised",
    realtime_active: false,
    effort: "high",
    summary: "",
    user_instructions: "",
    truncation_policy: "summarize",
    parent_thread_id: null,
    thread_role: "root",
    file_system_sandbox_policy: {
      type: "restricted",
      entries: [{ path: { type: "special", kind: "project" }, access: "write" }],
    },
  }) as SessionEnvelopeRecord

/* ---------------- schema_version union ---------------- */

describe("ADR-0135 — schema_version backward-compat union", () => {
  test("v1 record decodes successfully", () => {
    const r = TurnContextRecordSchema.safeParse(legacyTurn())
    expect(r.success).toBe(true)
  })

  test("v2 record decodes successfully", () => {
    const r = TurnContextRecordSchema.safeParse(v2Turn())
    expect(r.success).toBe(true)
  })

  test("schema_version 999 still rejects (closed union)", () => {
    const r = TurnContextRecordSchema.safeParse({ ...legacyTurn(), schema_version: 999 })
    expect(r.success).toBe(false)
  })

  test("schema_version 0 also rejects", () => {
    const r = TurnContextRecordSchema.safeParse({ ...legacyTurn(), schema_version: 0 })
    expect(r.success).toBe(false)
  })
})

/* ---------------- permission_profile union ---------------- */

describe("ADR-0135 — permission_profile union (enum ∪ struct)", () => {
  test("legacy enum 'default' accepted", () => {
    const r = TurnContextRecordSchema.safeParse(legacyTurn())
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.permission_profile).toBe("default")
  })

  test("legacy enum 'trusted' accepted", () => {
    const r = TurnContextRecordSchema.safeParse({ ...legacyTurn(), permission_profile: "trusted" })
    expect(r.success).toBe(true)
  })

  test("struct shape with all 4 pillars accepted", () => {
    const r = TurnContextRecordSchema.safeParse(v2Turn())
    expect(r.success).toBe(true)
    if (!r.success) return
    const pp = r.data.permission_profile
    expect(typeof pp).toBe("object")
    if (typeof pp !== "object") return
    expect(pp.approval.mode).toBe("session")
    expect(pp.network.mode).toBe("allow-list")
    expect(pp.sandbox.osSandbox).toBe("seatbelt")
    expect(pp.control.managedBy).toBe("team")
  })

  test("struct missing a pillar rejects (strict mode catches typos)", () => {
    const turn = v2Turn() as unknown as Record<string, unknown>
    const profile = { ...(turn.permission_profile as Record<string, unknown>) }
    delete profile.network
    const broken = { ...turn, permission_profile: profile }
    const r = TurnContextRecordSchema.safeParse(broken)
    expect(r.success).toBe(false)
  })

  test("unknown enum value rejects", () => {
    const r = TurnContextRecordSchema.safeParse({ ...legacyTurn(), permission_profile: "guest" })
    expect(r.success).toBe(false)
  })
})

/* ---------------- file_system_sandbox_policy ---------------- */

describe("ADR-0135 — file_system_sandbox_policy (optional second layer)", () => {
  test("absent on legacy v1 record is OK", () => {
    const r = TurnContextRecordSchema.safeParse(legacyTurn())
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.file_system_sandbox_policy).toBeUndefined()
  })

  test("present on v2 record decodes the full entry list", () => {
    const r = TurnContextRecordSchema.safeParse(v2Turn())
    expect(r.success).toBe(true)
    if (!r.success) return
    const fsp = r.data.file_system_sandbox_policy
    expect(fsp).toBeDefined()
    if (!fsp) return
    expect(fsp.type).toBe("restricted")
    expect(fsp.entries.length).toBe(1)
  })

  test("malformed FSP rejects (strict catches wrong access value)", () => {
    const turn = v2Turn()
    const broken = {
      ...turn,
      file_system_sandbox_policy: {
        type: "restricted",
        entries: [{ path: { type: "path", value: "/x" }, access: "execute" }],
      },
    }
    const r = TurnContextRecordSchema.safeParse(broken)
    expect(r.success).toBe(false)
  })
})

/* ---------------- round-trip determinism ---------------- */

describe("ADR-0135 — byte-identical round trip", () => {
  test("v1 record round-trips byte-identically (legacy enum stays enum)", () => {
    const original = legacyTurn()
    const line1 = encodeSessionLine(original)
    const decoded = decodeSessionLine(line1)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const line2 = encodeSessionLine(decoded.value)
    expect(line2).toBe(line1)
  })

  test("v2 record round-trips byte-identically (struct stays struct)", () => {
    const original = v2Turn()
    const line1 = encodeSessionLine(original)
    const decoded = decodeSessionLine(line1)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const line2 = encodeSessionLine(decoded.value)
    expect(line2).toBe(line1)
  })

  test("cross-version: v1 wire → decode → v1 wire is still byte-identical", () => {
    // The classical "legacy session on disk" path — the encoder NEVER coerces
    // up to v2, so a v1 record encodes back as v1.
    const original = legacyTurn()
    const line1 = encodeSessionLine(original)
    expect(line1.includes('"schema_version":1')).toBe(true)
    const decoded = decodeSessionLine(line1)
    if (!decoded.ok) throw new Error("unreachable")
    const line2 = encodeSessionLine(decoded.value)
    expect(line2).toBe(line1)
    expect(line2.includes('"schema_version":1')).toBe(true)
  })

  test("envelope union schema also accepts both v1 and v2", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(legacyTurn()).success).toBe(true)
    expect(SessionEnvelopeRecordSchema.safeParse(v2Turn()).success).toBe(true)
  })
})
