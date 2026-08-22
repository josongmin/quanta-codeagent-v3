/**
 * F4 — BenchObserver must give its JsonlRecorder a monotonic clock so bench
 * agent-stream events carry `monotonicNs` (used for latency math). The clock is
 * a run-local origin via `process.hrtime.bigint()`, returned as a BOUNDED,
 * JS-safe number (microseconds since origin — NOT absolute ns, which overflows
 * Number). Before this fix the recorder was constructed with `{ctx,strict,now}`
 * but NO `monotonic`, so every bench line was missing `monotonicNs`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TrajectoryEvent } from "@/shared"
import { BenchObserver } from "../../src/runner/batch/observe"

const readLines = (path: string): TrajectoryEvent[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEvent)

describe("BenchObserver — monotonicNs wiring (F4)", () => {
  test("recorder emits monotonicNs on agent-stream events; value is JS-safe", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-mono-"))
    try {
      const obs = new BenchObserver({ dir, runId: "run-1", attempt: 0, now: () => 1_000 }, "inst-1")
      obs.recorder.emit({ type: "turn_start", turn: 0 })
      obs.recorder.emit({ type: "assistant_text", delta: "hello" })
      obs.recorder.emit({ type: "turn_start", turn: 1 })
      obs.close()

      const lines = readLines(join(dir, "run-1", "inst-1.0.jsonl"))
      expect(lines.length).toBeGreaterThan(0)
      for (const e of lines) {
        // Every recorded line carries a monotonicNs field...
        expect(typeof e.monotonicNs).toBe("number")
        // ...that is a finite, non-negative, JS-safe number (no ns overflow).
        expect(Number.isSafeInteger(e.monotonicNs as number)).toBe(true)
        expect(e.monotonicNs as number).toBeGreaterThanOrEqual(0)
      }
      // Monotonic non-decreasing across the run (a real latency clock).
      const monos = lines.map((e) => e.monotonicNs as number)
      for (let i = 1; i < monos.length; i++) {
        expect(monos[i]).toBeGreaterThanOrEqual(monos[i - 1] as number)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
