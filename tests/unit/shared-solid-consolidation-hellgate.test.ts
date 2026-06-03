import { describe, expect, it } from "bun:test"
import { chunkBatches } from "@/shared/chunk"
import { isAbortError } from "@/shared/errors"
import { isAbortError as embedderAbort } from "@/retrieval/embedders/_abort"
import { chunkBatches as memoryEmbedderChunk } from "@/agent/memory-embedder"

/**
 * T7-shared-solid consolidation. Proves the ONE canonical `isAbortError` /
 * `chunkBatches` exports replace the drifted per-slice copies AND that the
 * reconciled semantics fix the adversarial cases the drift produced.
 */
describe("shared-solid consolidation: isAbortError canonical semantics", () => {
  it("classifies platform/typed aborts by structural .name (no instanceof Error requirement)", () => {
    // The prior `@/memory/auto-trigger` copy required `e instanceof Error`,
    // which FALSE-NEGATIVES on a DOMException-shaped abort (the exact platform
    // cancellation we most need to catch: Node fetch / web-stream cancel).
    expect(isAbortError({ name: "AbortError" })).toBe(true)
    expect(isAbortError({ name: "TimeoutError" })).toBe(true)
    // A real Error instance still classifies via .name.
    const e = new Error("cancelled")
    e.name = "AbortError"
    expect(isAbortError(e)).toBe(true)
  })

  it("does NOT classify a real fault whose message merely mentions 'abort'", () => {
    // The prior `@/memory/auto-trigger` copy matched `message.includes('abort')`,
    // FALSE-POSITIVING a genuine fault as a cancellation (which then re-throws
    // instead of being recorded as a structured TriggerError). The canonical
    // version classifies ONLY by structured .name — never message text.
    const sqlFault = new Error("failed to abort the pending transaction")
    expect(sqlFault.name).toBe("Error")
    expect(isAbortError(sqlFault)).toBe(false)

    const rebootFault = new Error("the operation was aborted by the remote host")
    expect(isAbortError(rebootFault)).toBe(false)
  })

  it("returns false on non-object / nullish / unrelated names", () => {
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError("AbortError")).toBe(false)
    expect(isAbortError({ name: "RangeError" })).toBe(false)
    expect(isAbortError({})).toBe(false)
  })

  it("the retrieval embedder _abort re-export IS the canonical function (no second copy)", () => {
    expect(embedderAbort).toBe(isAbortError)
  })
})

describe("shared-solid consolidation: chunkBatches canonical", () => {
  it("memory-embedder re-export IS the canonical function (no second copy)", () => {
    expect(memoryEmbedderChunk).toBe(chunkBatches)
  })

  it("splits into contiguous batches of at most size, preserving order", () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ])
  })

  it("guards size<=0 by clamping to batch-of-1 (no infinite loop)", () => {
    // Adversarial: size 0 with the raw `i += size` loop would spin forever and
    // hang the process. The canonical guard clamps to 1.
    expect(chunkBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]])
    expect(chunkBatches([1, 2, 3], -7)).toEqual([[1], [2], [3]])
  })

  it("guards non-finite size (NaN / Infinity) — clamps to batch-of-1, never hangs", () => {
    // NaN and Infinity both fail Number.isFinite, so the canonical guard clamps
    // to batch-of-1 rather than risking `i += NaN` (never advances → hang) or
    // an Infinity step. The assertion ALSO proves termination.
    expect(chunkBatches([1, 2], Number.NaN)).toEqual([[1], [2]])
    expect(chunkBatches([1, 2, 3], Number.POSITIVE_INFINITY)).toEqual([[1], [2], [3]])
  })

  it("floors fractional sizes and never emits a zero-length batch", () => {
    expect(chunkBatches([1, 2, 3, 4], 2.9)).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(chunkBatches([], 4)).toEqual([])
  })

  it("returns FRESH mutable batches that do not alias the readonly source", () => {
    const src: readonly number[] = [1, 2, 3, 4]
    const batches = chunkBatches(src, 2)
    batches[0]?.push(99)
    // Mutating a batch must not touch the source array.
    expect(src).toEqual([1, 2, 3, 4])
    expect(batches[0]).toEqual([1, 2, 99])
  })
})
