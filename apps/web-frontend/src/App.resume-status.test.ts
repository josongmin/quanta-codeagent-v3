import { describe, expect, it } from "vitest"
import { formatResumeStatus, type ResumeUiState } from "./App"

/**
 * B2 — resume banner state-machine copy. Pins the HONEST boundary distinction
 * (read-only history vs live) + pluralization + the null-on-idle contract as a
 * pure function (node env, no DOM) — the exact string the App renders into the
 * `thread-resume-status` banner.
 */
describe("formatResumeStatus (B2 resume banner copy)", () => {
  it("idle ⇒ null (no banner chrome)", () => {
    expect(formatResumeStatus({ phase: "idle" })).toBeNull()
  })

  it("resuming ⇒ names the thread being resumed", () => {
    expect(formatResumeStatus({ phase: "resuming", threadId: "t-9" })).toBe(
      "Resuming thread t-9…",
    )
  })

  it("resumed read-only-history ⇒ honest boundary note (new messages continue live session)", () => {
    const s: ResumeUiState = {
      phase: "resumed",
      threadId: "t-9",
      boundary: "read-only-history",
      count: 3,
    }
    const out = formatResumeStatus(s)
    expect(out).toContain("Resumed 3 events from thread t-9")
    // The load-bearing honesty: this was NOT a live re-attach.
    expect(out).toContain("read-only history")
    expect(out).toContain("new messages continue the live session")
  })

  it("resumed live-attach ⇒ marked (live), NOT read-only", () => {
    const out = formatResumeStatus({
      phase: "resumed",
      threadId: "t-9",
      boundary: "live-attach",
      count: 1,
    })
    // Singular pluralization.
    expect(out).toBe("Resumed 1 event from thread t-9 (live)")
    expect(out).not.toContain("read-only")
  })

  it("failed ⇒ clean 'could not resume' (no crash surface)", () => {
    expect(formatResumeStatus({ phase: "failed", threadId: "ghost" })).toBe(
      "Could not resume thread ghost.",
    )
  })
})
