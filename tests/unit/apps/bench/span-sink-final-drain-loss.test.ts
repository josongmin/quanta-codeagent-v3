/**
 * A FINAL DRAIN THAT FAILS IS PERMANENT LOSS, AND MUST SAY SO.
 *
 * `flush` detaches the buffer (`buf.length = 0`) BEFORE the upload, so a failed
 * put has already lost its batch — there is nothing left in memory to retry
 * with. The sink's `catch` nonetheless said "the next batch retries the
 * upload", which is true for a mid-run hiccup and false for the LAST drain,
 * where there is no next batch. With no counter and no log, `stop()` resolved
 * successfully while the trace buffer went with the process.
 */
import { describe, expect, test } from "bun:test"
import { s3SpanSink } from "@/apps/bench/span-sink"
import type { RemoteBackend } from "@/shared/remote-store"

const failingBackend = (): RemoteBackend =>
  ({
    list: async () => [],
    put: async () => {
      throw new Error("s3 down")
    },
  }) as unknown as RemoteBackend

const okBackend = (): RemoteBackend =>
  ({ list: async () => [], put: async () => undefined }) as unknown as RemoteBackend

describe("the span sink accounts for what it loses", () => {
  test("🔴 a failed FINAL drain is counted, not resolved away", async () => {
    const sink = s3SpanSink(failingBackend(), "p")
    sink.write('{"a":1}')
    sink.write('{"a":2}')
    await sink.flush({ final: true })
    expect(sink.droppedLines?.(), "the lost spans were not counted").toBe(2)
  })

  test("🔴 a mid-run failure is counted too — the batch is already detached", async () => {
    const sink = s3SpanSink(failingBackend(), "p")
    sink.write('{"a":1}')
    await sink.flush()
    expect(sink.droppedLines?.()).toBe(1)
  })

  test("PAIRED CONTROL: a successful drain loses nothing", async () => {
    // without this, a counter that always reported a loss would pass above
    const sink = s3SpanSink(okBackend(), "p")
    sink.write('{"a":1}')
    await sink.flush({ final: true })
    expect(sink.droppedLines?.()).toBe(0)
  })

  test("PAIRED CONTROL: an empty drain is a no-op", async () => {
    const sink = s3SpanSink(failingBackend(), "p")
    await sink.flush({ final: true })
    expect(sink.droppedLines?.()).toBe(0)
  })
})
