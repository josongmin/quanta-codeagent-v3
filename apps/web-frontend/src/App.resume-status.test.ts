import { describe, expect, it, vi } from "vitest"
import {
  armThreadSwapRedial,
  buildResumeConnectOptions,
  formatResumeStatus,
  type ResumeUiState,
} from "./App"

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

/**
 * ★ HELLGATE — P1 Phase 3b (frontend live-join): opening a persisted thread
 * re-dials the WS with `resumeThreadId` set so the daemon SWAPS its one live
 * session onto that thread (live-attach), not a read-only replay. This pins the
 * ConnectOptions the App feeds `client.connect` on a thread-open.
 */
describe("buildResumeConnectOptions (P1 Phase 3b swap re-dial)", () => {
  it("carries resumeThreadId so the daemon swap fires", () => {
    const opts = buildResumeConnectOptions({ url: "ws://h/s" }, "thread-7")
    expect(opts.resumeThreadId).toBe("thread-7")
    expect(opts.url).toBe("ws://h/s")
  })

  it("rides the auth token when present (mirrors mount-connect shape)", () => {
    const opts = buildResumeConnectOptions({ url: "ws://h/s", token: "tk" }, "thread-7")
    expect(opts.auth).toEqual({ token: "tk" })
    expect(opts.resumeThreadId).toBe("thread-7")
  })

  it("PAIRED CONTROL — no token ⇒ NO auth key (byte-identical to legacy no-token connect)", () => {
    const opts = buildResumeConnectOptions({ url: "ws://h/s" }, "thread-7")
    expect("auth" in opts).toBe(false)
  })
})

/**
 * ★ HELLGATE — P1 Phase 3b WIRING PROOF: the resume path must actually RE-DIAL
 * (disconnect → connect with `?thread`), not just compute options. Without this
 * a mutation that dropped the re-dial (reverting to a read-only replay) would be
 * invisible — buildResumeConnectOptions alone has no side effect. The daemon
 * reads `?thread` only at WS UPGRADE, so the order (disconnect BEFORE connect)
 * is load-bearing: the swap needs a fresh socket.
 */
describe("armThreadSwapRedial (P1 Phase 3b wiring)", () => {
  it("re-dials with the thread: disconnect BEFORE connect, carrying resumeThreadId", () => {
    const order: string[] = []
    const client = {
      disconnect: vi.fn(() => void order.push("disconnect")),
      connect: vi.fn(() => void order.push("connect")),
    }
    armThreadSwapRedial(client, { url: "ws://h/s", token: "tk" }, "thread-42")

    expect(order).toEqual(["disconnect", "connect"])
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledWith({
      url: "ws://h/s",
      resumeThreadId: "thread-42",
      auth: { token: "tk" },
    })
  })

  it("no-token path re-dials without an auth key (byte-identical legacy connect shape)", () => {
    const client = { disconnect: vi.fn(), connect: vi.fn() }
    armThreadSwapRedial(client, { url: "ws://h/s" }, "thread-42")
    expect(client.connect).toHaveBeenCalledWith({
      url: "ws://h/s",
      resumeThreadId: "thread-42",
    })
  })
})
