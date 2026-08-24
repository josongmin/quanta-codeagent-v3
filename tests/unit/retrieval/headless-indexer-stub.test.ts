/**
 * Coverage for the headless (no-filesystem) indexer stub.
 *
 * `headlessIndexerStub` exists so a test can drive the upsert seam, the delta
 * tracker and the `Tool` wrapper without a real workspace — that is what
 * ADR-0277 declared it for. It had ZERO consumers: not one test, not one app,
 * only two barrel re-exports. So the seam that exists to make the indexer
 * testable was itself the least-tested code in the slice, and its `runScan`
 * carried the highest remaining cognitive-complexity score in `src/` (61).
 *
 * These cases exist to make that score safe to attack. A refactor of something
 * nothing calls is unfalsifiable — "no test broke" means nothing when there are
 * no tests — so the contract goes down first, then the split.
 *
 * The contract, in the stub's own terms:
 *   - `scanInitial` reports EVERYTHING as added, whatever the tracker knew.
 *   - `scanDelta` reports only what changed against the tracker, and a delete
 *     reaches `upsert.delete` and leaves the corpus.
 *   - The injected map is MUTABLE and read live on each scan.
 *   - The refusal gates (`stopped`, in-progress, pre-aborted) come first.
 *   - An abort mid-scan is reported, and an upsert that throws surfaces as
 *     `scan-failed` rather than escaping.
 */

import { describe, expect, test } from "bun:test"

import { headlessIndexerStub } from "@/retrieval/indexer/headless-stub"
import type { FileChunk } from "@/retrieval/indexer/types"

type Files = Map<string, { readonly text: string; readonly mtime: number }>

const files = (entries: Record<string, string>): Files =>
  new Map(Object.entries(entries).map(([p, text]) => [p, { text, mtime: 1 }]))

interface Recorder {
  readonly upserted: string[]
  readonly deleted: string[]
  readonly port: { upsert(c: FileChunk): void; delete(p: string): void }
}

const recorder = (): Recorder => {
  const upserted: string[] = []
  const deleted: string[] = []
  return {
    upserted,
    deleted,
    port: {
      upsert(c) {
        upserted.push(c.path)
      },
      delete(p) {
        deleted.push(p)
      },
    },
  }
}

const statsOf = (res: unknown): Record<string, unknown> => {
  const r = res as { ok: boolean; value?: Record<string, unknown>; error?: unknown }
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  const v = r.value ?? {}
  return { ...v, skipped: [...((v.skipped as Map<string, string>) ?? new Map())] }
}
const errOf = (res: unknown): unknown => (res as { error?: { kind?: unknown } }).error?.kind

describe("headless indexer stub", () => {
  test("scanInitial reports every file as added and upserts its chunks", async () => {
    const rec = recorder()
    const ix = headlessIndexerStub({
      files: files({ "a.ts": "const a = 1\n", "b.ts": "const b = 2\n" }),
      upsert: rec.port,
    })
    expect(statsOf(await ix.scanInitial())).toEqual({
      filesScanned: 2,
      filesSkipped: 0,
      chunksProduced: 2,
      added: 2,
      modified: 0,
      deleted: 0,
      skipped: [],
    })
    expect([...rec.upserted].sort()).toEqual(["a.ts", "b.ts"])
    expect([...ix.getCorpus()].map((c) => c.path).sort()).toEqual(["a.ts", "b.ts"])
  })

  test("scanDelta after scanInitial sees nothing — the tracker absorbed it", async () => {
    const ix = headlessIndexerStub({ files: files({ "a.ts": "const a = 1\n" }) })
    await ix.scanInitial()
    expect(statsOf(await ix.scanDelta())).toMatchObject({ added: 0, modified: 0, deleted: 0 })
  })

  test("the injected map is live: an edit, an addition and a removal each show up", async () => {
    const rec = recorder()
    const map = files({ "a.ts": "const a = 1\n", "gone.ts": "const g = 1\n" })
    const ix = headlessIndexerStub({ files: map, upsert: rec.port })
    await ix.scanInitial()
    rec.upserted.length = 0

    map.set("a.ts", { text: "const a = 999\n", mtime: 2 }) // modified
    map.set("new.ts", { text: "const n = 1\n", mtime: 2 }) // added
    map.delete("gone.ts") // deleted

    expect(statsOf(await ix.scanDelta())).toMatchObject({
      filesScanned: 2,
      added: 1,
      modified: 1,
      deleted: 1,
    })
    expect([...rec.upserted].sort()).toEqual(["a.ts", "new.ts"])
    expect(rec.deleted).toEqual(["gone.ts"])
    // The deleted path leaves the corpus; the survivors stay.
    expect([...ix.getCorpus()].map((c) => c.path).sort()).toEqual(["a.ts", "new.ts"])
  })

  test("a same-content rewrite with a new mtime counts as modified", async () => {
    // The stamp is `{mtime, sha}` and the tracker compares both, so this is the
    // case that distinguishes "hashes the text" from "trusts the clock".
    const map = files({ "a.ts": "const a = 1\n" })
    const ix = headlessIndexerStub({ files: map })
    await ix.scanInitial()
    map.set("a.ts", { text: "const a = 1\n", mtime: 77 })
    expect(statsOf(await ix.scanDelta())).toMatchObject({ modified: 1, added: 0 })
  })

  test("scanInitial ALWAYS reports everything as added, even when the tracker knew", async () => {
    // The `mode === "initial"` ternaries are indistinguishable from the delta
    // counts on a FRESH tracker — `parts.added` is already everything. Only a
    // second `scanInitial`, after the tracker has absorbed the corpus,
    // separates the two, and it is the whole reason the ternaries exist.
    const map = files({ "a.ts": "const a = 1\n", "b.ts": "const b = 2\n" })
    const ix = headlessIndexerStub({ files: map })
    await ix.scanInitial()
    expect(statsOf(await ix.scanDelta())).toMatchObject({ added: 0, modified: 0 })
    expect(statsOf(await ix.scanInitial())).toMatchObject({
      added: 2,
      modified: 0,
      deleted: 0,
      filesScanned: 2,
    })
  })

  test("an abort raised DURING the upserts stops before the deletes", async () => {
    // The signal is polled between files and the deletes run AFTER the upserts,
    // so an abort raised by the first upsert must leave `upsert.delete`
    // uncalled. Nothing else in this file distinguishes "checks the signal
    // between phases" from "checks it once at the start".
    //
    // Measured, so the claim is not larger than the test: dropping the `&&`
    // short-circuit in `flushUpserts` does NOT fail here, and should not — the
    // delete loop re-checks the signal at its own first iteration, so both
    // forms are observably identical. What this case does catch is the check
    // disappearing from the delete loop as well.
    const ac = new AbortController()
    const deleted: string[] = []
    const map = files({ "a.ts": "const a = 1\n", "gone.ts": "const g = 1\n" })
    const ix = headlessIndexerStub({
      files: map,
      upsert: {
        upsert() {
          ac.abort()
        },
        delete(p) {
          deleted.push(p)
        },
      },
    })
    // Seed the tracker WITHOUT the aborting signal, so the abort below is the
    // only thing that can stop the scan.
    await ix.scanInitial()
    deleted.length = 0

    map.set("a.ts", { text: "const a = 2\n", mtime: 2 }) // an upsert to trip on
    map.delete("gone.ts") // a delete that must never be reached

    const res = await ix.scanDelta({ signal: ac.signal })
    expect(errOf(res)).toBe("aborted")
    expect(deleted).toEqual([])
  })

  test("an abort raised during the CHUNK phase stops before any upsert", async () => {
    // The chunk loop polls the signal too, one phase earlier than the case
    // above. Tripping it needs the abort to fire while the stub is still
    // reading the injected map, which a map that aborts on its first `get`
    // does exactly — and nothing else in this file reaches that check.
    const ac = new AbortController()
    const upserted: string[] = []
    const base = files({ "a.ts": "const a = 1\n", "b.ts": "const b = 2\n" })
    const abortingMap = new Map(base) as typeof base
    const realGet = abortingMap.get.bind(abortingMap)
    abortingMap.get = (k: string) => {
      ac.abort()
      return realGet(k)
    }
    const ix = headlessIndexerStub({
      files: abortingMap,
      upsert: {
        upsert(c) {
          upserted.push(c.path)
        },
        delete() {},
      },
    })
    expect(errOf(await ix.scanInitial({ signal: ac.signal }))).toBe("aborted")
    expect(upserted).toEqual([])
  })

  test("refusal gates: stopped, and pre-aborted", async () => {
    const ix = headlessIndexerStub({ files: files({ "a.ts": "x\n" }) })
    const ac = new AbortController()
    ac.abort()
    expect(errOf(await ix.scanInitial({ signal: ac.signal }))).toBe("aborted")
    ix.stop()
    expect(errOf(await ix.scanInitial())).toBe("stopped")
    expect(errOf(await ix.scanDelta())).toBe("stopped")
  })

  test("an upsert that throws surfaces as scan-failed, not as an escaping error", async () => {
    // The stub's contract is a Result, not an exception. A port that throws is
    // the realistic case — that is what a full disk or a closed store looks like.
    const ix = headlessIndexerStub({
      files: files({ "a.ts": "const a = 1\n" }),
      upsert: {
        upsert() {
          throw new Error("store closed")
        },
        delete() {},
      },
    })
    const res = (await ix.scanInitial()) as { ok: boolean; error?: { kind?: string } }
    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe("scan-failed")
    // …and the indexer is usable again afterwards: `scanning` was released.
    expect(errOf(await ix.scanInitial())).toBe("scan-failed")
  })

  test("an empty corpus scans clean rather than erroring", async () => {
    const ix = headlessIndexerStub({ files: new Map() })
    expect(statsOf(await ix.scanInitial())).toMatchObject({
      filesScanned: 0,
      chunksProduced: 0,
      added: 0,
    })
    expect([...ix.getCorpus()]).toEqual([])
  })

  test("a file whose text produces no chunks is scanned but contributes none", async () => {
    // Empty text: the file IS tracked (it counts as scanned and as added) while
    // the chunker yields nothing, so `chunksProduced` and the corpus disagree
    // with `added` on purpose.
    const ix = headlessIndexerStub({ files: files({ "empty.ts": "" }) })
    expect(statsOf(await ix.scanInitial())).toMatchObject({
      filesScanned: 1,
      added: 1,
      chunksProduced: 0,
    })
    expect([...ix.getCorpus()]).toEqual([])
  })

  test("getCorpus snapshots — a scan during iteration cannot corrupt it", async () => {
    const map = files({ "a.ts": "const a = 1\n" })
    const ix = headlessIndexerStub({ files: map })
    await ix.scanInitial()
    const it = ix.getCorpus()[Symbol.iterator]()
    const first = it.next()
    map.set("b.ts", { text: "const b = 1\n", mtime: 2 })
    await ix.scanDelta()
    // The iterator keeps yielding the corpus as it stood when it was created.
    expect(first.done).toBe(false)
    expect(it.next().done).toBe(true)
  })
})
