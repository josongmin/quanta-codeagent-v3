// §6.5 long-tail — RealtimePort.listVoices() (Codex ThreadRealtimeListVoices
// parity). Port-method (NOT a model-facing tool — realtime is an I/O primitive,
// the surface owns the RTCPeerConnection). Covers the default adapter
// (voicesProvider seam) + the headless stub (voices option) + byte-identity
// (no provider ⇒ voices-unsupported).

import { describe, expect, test } from "bun:test"
import { createBunWebSocketAdapter, createHeadlessStub, type VoiceInfo } from "@/realtime"

const VOICES: readonly VoiceInfo[] = [
  { id: "alloy", label: "Alloy", description: "neutral" },
  { id: "verse", label: "Verse" },
]

describe("listVoices — headless stub", () => {
  test("voices OMITTED ⇒ voices-unsupported (byte-identical to pre-§6.5)", async () => {
    const stub = createHeadlessStub()
    const r = await stub.port.listVoices()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("voices-unsupported")
  })

  test("voices SET ⇒ ok with the server-advertised list", async () => {
    const stub = createHeadlessStub({ voices: VOICES })
    const r = await stub.port.listVoices()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((v) => v.id)).toEqual(["alloy", "verse"])
      expect(r.value[0]?.description).toBe("neutral")
    }
  })

  test("voices SET to [] ⇒ ok with an empty list (distinct from unsupported)", async () => {
    const stub = createHeadlessStub({ voices: [] })
    const r = await stub.port.listVoices()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })

  test("listVoices works regardless of connection lifecycle (server-query, not a frame)", async () => {
    const stub = createHeadlessStub({ voices: VOICES })
    // never connected
    const r = await stub.port.listVoices()
    expect(r.ok).toBe(true)
  })

  test("returned list is a defensive copy (mutating it does not corrupt the stub)", async () => {
    const stub = createHeadlessStub({ voices: VOICES })
    const r = await stub.port.listVoices()
    if (r.ok) (r.value as VoiceInfo[]).push({ id: "x", label: "X" })
    const r2 = await stub.port.listVoices()
    if (r2.ok) expect(r2.value).toHaveLength(2)
  })
})

describe("listVoices — default Bun adapter", () => {
  test("no voicesProvider ⇒ voices-unsupported (default MVP WS has no voices RPC)", async () => {
    const port = createBunWebSocketAdapter()
    const r = await port.listVoices()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("voices-unsupported")
  })

  test("voicesProvider wired ⇒ delegates to it", async () => {
    const port = createBunWebSocketAdapter({
      voicesProvider: async () => ({ ok: true, value: VOICES }),
    })
    const r = await port.listVoices()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((v) => v.id)).toEqual(["alloy", "verse"])
  })

  test("a THROWING voicesProvider maps to a typed io-error (NO-THROW boundary)", async () => {
    const port = createBunWebSocketAdapter({
      voicesProvider: async () => {
        throw new Error("network down")
      },
    })
    const r = await port.listVoices()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("io-error")
      if (r.error.kind === "io-error") expect(r.error.degradeReason).toContain("network down")
    }
  })

  test("a provider that returns Err propagates it verbatim", async () => {
    const port = createBunWebSocketAdapter({
      voicesProvider: async () => ({
        ok: false,
        error: { kind: "auth-failed", degradeReason: "401" },
      }),
    })
    const r = await port.listVoices()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("auth-failed")
  })
})
