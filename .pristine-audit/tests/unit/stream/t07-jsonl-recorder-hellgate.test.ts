import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlRecorder } from "@/stream/adapters/jsonl-recorder"
import type { AgentEvent } from "@/stream/types"

/**
 * T07 hellgate — JsonlRecorder lifecycle / observability (audit L6 M6 / M7).
 *
 * M6(a): `close()` must FLUSH before flipping `closed` — a flush failure must be
 *        retryable on a subsequent close, not trapped behind an early flag.
 * M6(b): every capped emit increments the dropped count (N>1 reflected), not a
 *        single one-shot `dropped=1`.
 * M7:    a cap-line write failure must be logged (parity with tryDegradedLine),
 *        and the dropped events are counted in `degraded()`.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t07-jsonl-rec-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe("T07 jsonl-recorder hellgate", () => {
  test("M6(a): a failed final flush stays retryable — second close() lands the data", () => {
    const path = join(dir, "a.jsonl")
    const rec = new JsonlRecorder(path, { now: () => 1, monotonic: () => 1 })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "x" })

    const realFlush = (rec as unknown as { flush: () => void }).flush.bind(rec)
    let fail = true
    ;(rec as unknown as { flush: () => void }).flush = function patched() {
      if (fail) {
        fail = false
        throw new Error("disk full")
      }
      realFlush()
    }

    // First close(): flush throws. If `closed` were flipped BEFORE the flush,
    // the buffer is trapped — a second close() would early-return and the data
    // would be permanently lost.
    rec.close()

    // Second close(): the flag must NOT have been set on the failed path, so the
    // retry actually flushes the buffered lines to disk.
    rec.close()

    const lines = readLines(path)
    expect(lines.some((l) => l.kind === "turn_start")).toBe(true)
    expect(lines.some((l) => l.kind === "assistant_text")).toBe(true)
  })

  test("M6(b): N>1 dropped events past the cap are all counted", () => {
    const path = join(dir, "b.jsonl")
    const rec = new JsonlRecorder(path, { maxLines: 2, now: () => 1, monotonic: () => 1 })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "1" })
    // Now over cap — emit several more; each must increment dropped.
    rec.emit({ type: "assistant_text", delta: "2" })
    rec.emit({ type: "assistant_text", delta: "3" })
    rec.emit({ type: "assistant_text", delta: "4" })
    rec.close()

    const degraded = rec.degraded()
    expect(degraded.length).toBe(1)
    // 3 events were dropped past the cap — not collapsed to 1.
    expect(degraded[0]?.count).toBeGreaterThanOrEqual(3)
  })

  test("baseline: normal emit + close writes lines and reports no drops", () => {
    const path = join(dir, "c.jsonl")
    const rec = new JsonlRecorder(path, { now: () => 1, monotonic: () => 1 })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "done", reason: "stop", turns: 1 } as AgentEvent)
    rec.close()
    expect(readLines(path).length).toBe(2)
    expect(rec.degraded()).toEqual([])
  })
})
