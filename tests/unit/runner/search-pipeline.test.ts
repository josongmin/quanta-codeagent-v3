import { describe, expect, test } from "bun:test"
import type { IndexerFileChunk } from "@/retrieval"
import { createTrackedSemanticUpsert } from "@/runner/assemble/search-pipeline"

const chunk = (path: string, startLine: number, endLine: number): IndexerFileChunk => ({
  path,
  startLine,
  endLine,
  text: `${path}:${startLine}-${endLine}`,
  mtime: 0,
  sha: "0",
})

describe("createTrackedSemanticUpsert", () => {
  test("returns null when no scan mutations were observed", () => {
    const tracked = createTrackedSemanticUpsert({
      async upsert() {},
      async delete() {},
    })
    expect(tracked.takeBatch()).toBeNull()
  })

  test("groups chunk ids by path and resets after takeBatch", async () => {
    const tracked = createTrackedSemanticUpsert({
      async upsert() {},
      async delete() {},
    })
    await tracked.upsert.upsert(chunk("a.ts", 1, 5))
    await tracked.upsert.upsert(chunk("a.ts", 6, 10))
    await tracked.upsert.upsert(chunk("b.ts", 1, 3))
    const batch = tracked.takeBatch()
    expect(batch).not.toBeNull()
    expect(batch?.changedPaths.get("a.ts")).toEqual(["a.ts:1-5", "a.ts:6-10"])
    expect(batch?.changedPaths.get("b.ts")).toEqual(["b.ts:1-3"])
    expect(batch?.deletedPaths).toEqual([])
    expect(tracked.takeBatch()).toBeNull()
  })

  test("delete tombstones survive until a later upsert for the same path or clear()", async () => {
    const tracked = createTrackedSemanticUpsert({
      async upsert() {},
      async delete() {},
    })
    await tracked.upsert.delete("gone.ts")
    let batch = tracked.takeBatch()
    expect(batch?.deletedPaths).toEqual(["gone.ts"])

    await tracked.upsert.delete("swap.ts")
    await tracked.upsert.upsert(chunk("swap.ts", 1, 5))
    batch = tracked.takeBatch()
    expect(batch?.deletedPaths).toEqual([])
    expect(batch?.changedPaths.get("swap.ts")).toEqual(["swap.ts:1-5"])

    await tracked.upsert.upsert(chunk("drop.ts", 1, 1))
    tracked.clear()
    expect(tracked.takeBatch()).toBeNull()
  })
})
