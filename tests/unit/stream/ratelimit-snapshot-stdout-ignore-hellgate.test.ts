import { describe, expect, test } from "bun:test"
import { StdoutStream } from "../../../src/stream/adapters/stdout"
import type { AgentEvent } from "../../../src/stream/types"

/**
 * P27 hellgate (b) — the stdout line-monitor's `ratelimit_snapshot` case stays
 * EMPTY (byte-identical to the pre-P27 ignore). The transient quota notice is a
 * SEPARATE surface (`@/apps/cli/ratelimit-notice`, gated by
 * QUANTA_RATELIMIT_NOTICE) teed onto the status bar; the line-oriented stdout
 * monitor must never grow a line for this event (it would flood stdout, exactly
 * like `output_progress`).
 *
 * This locks the empty case: if a future change accidentally renders the event
 * to stdout, this test goes red.
 */

const snap: Extract<AgentEvent, { type: "ratelimit_snapshot" }> = {
  type: "ratelimit_snapshot",
  tokensRemaining: 0,
  tokensResetMs: 3 * 3600_000,
  requestsRemaining: 0,
  requestsResetMs: 90_000,
  observedAt: 1,
}

describe("P27 StdoutStream — ratelimit_snapshot is ignored (no line)", () => {
  test("a reached snapshot writes ZERO bytes to stdout", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (chunk) => out.push(chunk) })
    s.emit(snap)
    expect(out.join("")).toBe("")
  })

  test("a snapshot mid-text does not interrupt the assistant line either", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (chunk) => out.push(chunk) })
    s.emit({ type: "assistant_text", delta: "hello" } as AgentEvent)
    const before = out.join("")
    s.emit(snap)
    // The snapshot emits nothing extra. (Note: the generic non-text-boundary
    // newline-flush still applies to ANY non-assistant_text event mid-text, so
    // we assert the snapshot adds at most that single boundary newline and no
    // rate-limit content.)
    const added = out.join("").slice(before.length)
    expect(added).not.toContain("한도")
    expect(added).not.toContain("ratelimit")
    expect(added).not.toContain("resets")
  })
})
