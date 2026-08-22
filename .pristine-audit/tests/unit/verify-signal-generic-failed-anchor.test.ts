import { describe, expect, it } from "bun:test"
import { isVerifyOutputFailing } from "@/agent/verify-signal"

// #13: `generic-failed-count` was UNANCHORED (`\b\d+ failed\b`), so a passing run
// whose output incidentally contains "N failed" in prose / log noise flipped to
// FAILING → verify-guard blocks the finish with a false-RED (burns a turn / can
// stall near budget end). Its sibling count matchers (`failures?`, `errors?`) are
// anchored to a summary boundary (`^` / `, ` / `= `); `failed` must be too. A real
// pytest/test-runner summary always places the count at that boundary, so
// anchoring keeps every true positive while dropping the prose false-RED.

const failing = (out: string): boolean => isVerifyOutputFailing("verify", undefined, out)

describe("generic-failed-count anchoring (#13)", () => {
  it("does NOT fire on 'N failed' embedded in benign prose / log noise", () => {
    expect(failing("retried 3 failed connections, then the suite passed: OK")).toBe(false)
    expect(failing("health check: 2 failed attempts recovered; all green")).toBe(false)
  })

  // Paired controls: every real summary form must STILL fire.
  it("STILL fires on real test-runner failure summaries", () => {
    expect(failing("===== 3 failed in 0.42s =====")).toBe(true) // pytest banner (`= ` boundary)
    expect(failing("3 failed, 2 passed in 1.2s")).toBe(true) // short-form, line start
    expect(failing("1 passed, 2 failed")).toBe(true) // count after `, ` separator
  })

  it("does not fire on a clean run", () => {
    expect(failing("12 passed in 3.1s")).toBe(false)
  })
})
