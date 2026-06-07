/**
 * Hellgate — CDP method allowlist (ADR-0427, strengthen #1).
 *
 * Proves the quanta differentiator: dangerous CDP methods are denied IN CODE,
 * not just in prose. Control = the 6 allowed methods pass. Adversarial = a broad
 * sweep of dangerous methods (Runtime.evaluate / Input / Storage / Cookies /
 * Browser / Target / System / download / navigate) are all rejected. Partition
 * guard = the allowlist is exactly 6 entries (a silent addition fails the test).
 *
 *  HELL-CDP-01: every allowed method passes isCdpMethodAllowed
 *  HELL-CDP-02: every dangerous method is denied
 *  HELL-CDP-03: allowlist size is frozen at 7 (no silent grow)
 *  HELL-CDP-04: malformed / empty / case-variant methods denied (default-deny)
 *  HELL-CDP-05: headless port.cdp() enforces the same gate end-to-end
 */

import { describe, expect, test } from "bun:test"
import { assertOk } from "../_support/assert-ok"
import { CDP_ALLOWED_METHODS, createHeadlessBrowser, isCdpMethodAllowed } from "@/browser"

const DANGEROUS = [
  // R1 audit [17]: Runtime.evaluate is model-reachable arbitrary JS → denied.
  "Runtime.evaluate",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Storage.clearDataForOrigin",
  "Storage.getCookies",
  "Network.getAllCookies",
  "Network.setCookie",
  "Browser.setDownloadBehavior",
  "Page.setDownloadBehavior",
  "Page.navigate",
  "Target.createTarget",
  "Target.attachToTarget",
  "Fetch.enable",
  "Fetch.continueRequest",
  "SystemInfo.getInfo",
  "Page.captureScreenshot",
] as const

describe("HELLGATE CDP-allowlist — dangerous methods denied in code", () => {
  // HELL-CDP-01 — control: allowed pass
  for (const m of CDP_ALLOWED_METHODS) {
    test(`HELL-CDP-01: ${m} ⇒ allowed`, () => {
      expect(isCdpMethodAllowed(m)).toBe(true)
    })
  }

  // HELL-CDP-02 — adversarial: dangerous denied
  for (const m of DANGEROUS) {
    test(`HELL-CDP-02: ${m} ⇒ denied`, () => {
      expect(isCdpMethodAllowed(m)).toBe(false)
    })
  }

  // HELL-CDP-03 — partition: list frozen (silent grow fails here)
  test("HELL-CDP-03: allowlist is exactly the 6 read-only methods (no Runtime.evaluate)", () => {
    expect(CDP_ALLOWED_METHODS.length).toBe(6)
    expect(([...CDP_ALLOWED_METHODS] as string[]).sort()).toEqual(
      [
        "CSS.getComputedStyleForNode",
        "DOM.getDocument",
        "DOM.querySelector",
        "Log.enable",
        "Network.enable",
        "Performance.getMetrics",
      ].sort(),
    )
    // ★ Runtime.evaluate must NOT be model-reachable (R1 audit [17])
    expect([...CDP_ALLOWED_METHODS]).not.toContain("Runtime.evaluate")
  })

  // HELL-CDP-04 — default-deny on malformed / case variants
  test("HELL-CDP-04: malformed / empty / case-variant ⇒ denied", () => {
    expect(isCdpMethodAllowed("")).toBe(false)
    expect(isCdpMethodAllowed("runtime.evaluate")).toBe(false) // wrong case
    expect(isCdpMethodAllowed("Runtime.Evaluate")).toBe(false)
    expect(isCdpMethodAllowed("Runtime.evaluate ")).toBe(false) // trailing space
    expect(isCdpMethodAllowed("Network")).toBe(false)
  })

  // HELL-CDP-05 — end-to-end through the port
  test("HELL-CDP-05: headless port.cdp() enforces the gate", async () => {
    const b = createHeadlessBrowser()
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    assertOk(h)

    const allowed = await b.cdp(h.value, "DOM.getDocument")
    expect(allowed.ok).toBe(true)

    const denied = await b.cdp(h.value, "Input.dispatchMouseEvent")
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error.kind).toBe("cdp-method-denied")
      if (denied.error.kind === "cdp-method-denied") {
        expect(denied.error.method).toBe("Input.dispatchMouseEvent")
      }
    }
  })
})
