/**
 * #1-P0 — LSP-grounding launch-proof verdict (jun-19 audit fix).
 *
 * The remote bench's localize steer is DEFAULT-ON, but nav silently degrades to
 * "unavailable" if pyright never launched on the box. This pure verdict drives
 * the LOUD non-fatal WARNING that makes an INERT-grounding run observable.
 */

import { describe, expect, it } from "bun:test"
import { pyrightLaunchProofVerdict } from "@/apps/bench/remote/full"

describe("pyrightLaunchProofVerdict", () => {
  it("READY: a clean version line means grounding is live", () => {
    const v = pyrightLaunchProofVerdict({ code: 0, stdout: "pyright 1.1.350\n" })
    expect(v.ready).toBe(true)
    expect(v.detail).toBe("pyright 1.1.350")
  })

  it("INERT: the MISSING sentinel (pyright not on PATH) is not ready", () => {
    expect(pyrightLaunchProofVerdict({ code: 7, stdout: "PYRIGHT_MISSING\n" }).ready).toBe(false)
  })

  it("INERT: a non-zero exit is not ready (probe failed)", () => {
    expect(pyrightLaunchProofVerdict({ code: 255, stdout: "Connection refused" }).ready).toBe(false)
  })

  it("INERT: empty stdout cannot confirm a launch ⇒ not ready", () => {
    expect(pyrightLaunchProofVerdict({ code: 0, stdout: "   \n" }).ready).toBe(false)
  })

  it("RED-ON-INJECTION: flipping ONLY the exit code flips the verdict", () => {
    const sameOut = "pyright 1.1.350"
    expect(pyrightLaunchProofVerdict({ code: 0, stdout: sameOut }).ready).toBe(true)
    // A regression that ignores the exit code would keep this 'ready' — it must not.
    expect(pyrightLaunchProofVerdict({ code: 1, stdout: sameOut }).ready).toBe(false)
  })

  it("defensive: a non-string stdout never throws ⇒ not ready", () => {
    expect(
      pyrightLaunchProofVerdict({ code: 0, stdout: undefined as unknown as string }).ready,
    ).toBe(false)
  })
})
