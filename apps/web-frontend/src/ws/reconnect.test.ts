import { describe, expect, it } from "vitest"
import {
  computeRetryDelayMs,
  RECONNECT_BACKOFF_CONSTANTS,
} from "./reconnect"

describe("computeRetryDelayMs", () => {
  it("returns the base delay for attempt 1 (first retry)", () => {
    expect(computeRetryDelayMs(1)).toBe(RECONNECT_BACKOFF_CONSTANTS.baseMs)
  })

  it("doubles the delay on each subsequent attempt until the cap", () => {
    expect(computeRetryDelayMs(2)).toBe(1000)
    expect(computeRetryDelayMs(3)).toBe(2000)
    expect(computeRetryDelayMs(4)).toBe(4000)
    expect(computeRetryDelayMs(5)).toBe(8000)
    expect(computeRetryDelayMs(6)).toBe(16000)
  })

  it("caps at 30000ms once exponential growth exceeds the cap", () => {
    expect(computeRetryDelayMs(7)).toBe(RECONNECT_BACKOFF_CONSTANTS.capMs)
    expect(computeRetryDelayMs(8)).toBe(RECONNECT_BACKOFF_CONSTANTS.capMs)
    expect(computeRetryDelayMs(100)).toBe(RECONNECT_BACKOFF_CONSTANTS.capMs)
  })

  it("clamps non-positive or non-finite inputs to the base delay", () => {
    expect(computeRetryDelayMs(0)).toBe(RECONNECT_BACKOFF_CONSTANTS.baseMs)
    expect(computeRetryDelayMs(-3)).toBe(RECONNECT_BACKOFF_CONSTANTS.baseMs)
    expect(computeRetryDelayMs(Number.NaN)).toBe(
      RECONNECT_BACKOFF_CONSTANTS.baseMs,
    )
    expect(computeRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(
      RECONNECT_BACKOFF_CONSTANTS.baseMs,
    )
  })

  it("constants are the documented policy (base=500, cap=30000, mult=2)", () => {
    expect(RECONNECT_BACKOFF_CONSTANTS.baseMs).toBe(500)
    expect(RECONNECT_BACKOFF_CONSTANTS.capMs).toBe(30000)
    expect(RECONNECT_BACKOFF_CONSTANTS.multiplier).toBe(2)
  })
})
