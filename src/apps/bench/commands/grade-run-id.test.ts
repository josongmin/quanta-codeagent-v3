import { describe, expect, test } from "bun:test"
import { fullRemoteRunId } from "./grade"

describe("fullRemoteRunId", () => {
  test("bounds multi-instance selectors below filesystem component limits", () => {
    const selector = Array.from(
      { length: 3 },
      (_, index) => `instance_owner__repository-${index}-${"a".repeat(120)}`,
    ).join(",")
    const runId = fullRemoteRunId(selector, 1_787_320_004_352)

    expect(Buffer.byteLength(runId)).toBeLessThan(128)
    expect(runId).toMatch(/^fullremote-[A-Za-z0-9._-]+-3x-[a-f0-9]{12}-1787320004352$/)
  })

  test("selector hash prevents same-prefix collisions", () => {
    const prefix = `instance_owner__repo-${"a".repeat(80)}`
    expect(fullRemoteRunId(`${prefix}-one`, 42)).not.toBe(fullRemoteRunId(`${prefix}-two`, 42))
  })
})
