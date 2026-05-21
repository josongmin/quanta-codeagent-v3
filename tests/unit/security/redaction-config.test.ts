import { describe, expect, test } from "bun:test"
import {
  normalizeRedactionConfig,
  REDACTION_DISABLED_WITHOUT_ACK_MESSAGE,
  RedactionConfigError,
} from "@/security"

describe("normalizeRedactionConfig — startup contract", () => {
  test("undefined ⇒ enabled, no ack, empty whitelist (default-ON)", () => {
    const cfg = normalizeRedactionConfig(undefined)
    expect(cfg.enabled).toBe(true)
    expect(cfg.acknowledgedRisk).toBeUndefined()
    expect(cfg.whitelist).toHaveLength(0)
  })

  test("empty object ⇒ enabled by default", () => {
    const cfg = normalizeRedactionConfig({})
    expect(cfg.enabled).toBe(true)
  })

  test("disabled:false ⇒ enabled (no ack required)", () => {
    const cfg = normalizeRedactionConfig({ disabled: false })
    expect(cfg.enabled).toBe(true)
  })

  test("disabled:true WITHOUT ack ⇒ throws with EXACT message", () => {
    expect(() => normalizeRedactionConfig({ disabled: true })).toThrow(
      REDACTION_DISABLED_WITHOUT_ACK_MESSAGE,
    )
    expect(() =>
      normalizeRedactionConfig({ disabled: true, acknowledgedRisk: "" }),
    ).toThrow(REDACTION_DISABLED_WITHOUT_ACK_MESSAGE)
    // Whitespace-only ack is not a real explanation.
    expect(() =>
      normalizeRedactionConfig({ disabled: true, acknowledgedRisk: "   " }),
    ).toThrow(REDACTION_DISABLED_WITHOUT_ACK_MESSAGE)
  })

  test("throws RedactionConfigError specifically (not bare Error)", () => {
    try {
      normalizeRedactionConfig({ disabled: true })
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(RedactionConfigError)
    }
  })

  test("disabled:true WITH non-empty ack ⇒ disabled, ack preserved", () => {
    const cfg = normalizeRedactionConfig({
      disabled: true,
      acknowledgedRisk: "internal pentest fixture only",
    })
    expect(cfg.enabled).toBe(false)
    expect(cfg.acknowledgedRisk).toBe("internal pentest fixture only")
  })

  test("whitelist passed through and frozen", () => {
    const wl = [/^TEST_TOKEN_/]
    const cfg = normalizeRedactionConfig({ whitelist: wl })
    expect(cfg.whitelist.length).toBe(1)
    expect(() => {
      ;(cfg.whitelist as unknown[]).push(/forbidden/)
    }).toThrow()
  })
})
