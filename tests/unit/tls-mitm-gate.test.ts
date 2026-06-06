/**
 * jun-7 TLS-MITM — operator-opt-in GATE unit tests.
 *
 * MITM mints a trust anchor the agent's client accepts — a STRONGER tradeoff
 * than the other knobs. The gate must require BOTH the master switch `=1` AND a
 * verbatim ack phrase, and stay OFF for every weaker/partial signal (so a stray
 * `=1` copied from another knob, or a templated CI matrix, cannot silently
 * enable MITM).
 */

import { describe, expect, test } from "bun:test"
import {
  TLS_MITM_ACK_ENV,
  TLS_MITM_ACK_PHRASE,
  TLS_MITM_ENV,
  tlsMitmAuthorized,
} from "@/runtime/network-proxy/mitm-gate"

describe("tlsMitmAuthorized gate", () => {
  test("ON only when BOTH the switch =1 AND the verbatim ack are present", () => {
    expect(
      tlsMitmAuthorized({ [TLS_MITM_ENV]: "1", [TLS_MITM_ACK_ENV]: TLS_MITM_ACK_PHRASE }),
    ).toBe(true)
  })

  test("OFF when the ack is missing (switch alone is NOT enough)", () => {
    expect(tlsMitmAuthorized({ [TLS_MITM_ENV]: "1" })).toBe(false)
  })

  test("OFF when the switch is missing (ack alone is NOT enough)", () => {
    expect(tlsMitmAuthorized({ [TLS_MITM_ACK_ENV]: TLS_MITM_ACK_PHRASE })).toBe(false)
  })

  test("OFF for a wrong/typo ack phrase (must be verbatim)", () => {
    expect(tlsMitmAuthorized({ [TLS_MITM_ENV]: "1", [TLS_MITM_ACK_ENV]: "yes" })).toBe(false)
    expect(
      tlsMitmAuthorized({
        [TLS_MITM_ENV]: "1",
        [TLS_MITM_ACK_ENV]: `${TLS_MITM_ACK_PHRASE} `,
      }),
    ).toBe(false)
  })

  test("OFF for truthy-but-not-exactly-1 switch values", () => {
    for (const v of ["true", "on", "yes", "2", " 1"]) {
      expect(
        tlsMitmAuthorized({ [TLS_MITM_ENV]: v, [TLS_MITM_ACK_ENV]: TLS_MITM_ACK_PHRASE }),
      ).toBe(false)
    }
  })

  test("OFF on an empty env (default)", () => {
    expect(tlsMitmAuthorized({})).toBe(false)
  })

  test("the ack phrase is self-documenting (names the tradeoff)", () => {
    expect(TLS_MITM_ACK_PHRASE).toContain("mitm")
    expect(TLS_MITM_ACK_PHRASE).toContain("trust-anchor")
  })
})
