/**
 * Hellgate — image downsample planning (gap-other-agent GAP 1).
 *
 * quanta hard-rejects images >5MB (`MAX_IMAGE_BYTES`). Codex downsamples
 * (PIL LANCZOS → max longest-edge). quanta is pure-TS with NO image codec
 * vendored, so the actual decode/resize/encode is a DownsamplePort (host wires
 * a WASM/native codec; absent ⇒ reject, byte-identical to today). These are the
 * essential PURE decision functions.
 *
 * Invariants:
 *   1. planImageRead: under cap ⇒ "ok"; over cap + port ⇒ "downsample"; over cap
 *      + no port ⇒ "reject" (today's behavior — byte-identical when unwired).
 *   2. scaleToMaxDim: preserves aspect, caps the LONGEST edge, never UPSCALES,
 *      rounds to ≥1px, and guards non-finite / non-positive input.
 */
import { describe, expect, test } from "bun:test"
import { planImageRead, scaleToMaxDim } from "@/tool/image/downsample-plan"

const CAP = 5 * 1024 * 1024

describe("planImageRead — gate", () => {
  test("under cap ⇒ ok (regardless of port)", () => {
    expect(planImageRead(1000, CAP, false)).toBe("ok")
    expect(planImageRead(CAP, CAP, true)).toBe("ok") // == cap is ok
  })
  test("over cap: port ⇒ downsample, no port ⇒ reject (byte-identical today)", () => {
    expect(planImageRead(CAP + 1, CAP, true)).toBe("downsample")
    expect(planImageRead(CAP + 1, CAP, false)).toBe("reject")
  })
})

describe("scaleToMaxDim — aspect-preserving cap", () => {
  test("downscales the longest edge, preserves aspect", () => {
    expect(scaleToMaxDim(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024 })
    expect(scaleToMaxDim(2000, 4000, 2048)).toEqual({ width: 1024, height: 2048 })
  })
  test("never upscales (already within bound ⇒ unchanged)", () => {
    expect(scaleToMaxDim(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })
  test("rounds to at least 1px (extreme aspect)", () => {
    const r = scaleToMaxDim(10000, 1, 100)
    expect(r.width).toBe(100)
    expect(r.height).toBe(1)
  })
  test("guards garbage input (non-finite / non-positive) ⇒ unchanged", () => {
    expect(scaleToMaxDim(Number.NaN, 100, 50)).toEqual({ width: Number.NaN, height: 100 })
    expect(scaleToMaxDim(0, 100, 50)).toEqual({ width: 0, height: 100 })
    expect(scaleToMaxDim(100, 100, 0)).toEqual({ width: 100, height: 100 })
  })
})
