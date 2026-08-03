/**
 * RFC06-4 (B5) — anchored mutation receipt + CAS undo journal.
 *
 * The journal is a durable receipt wrapper around the EXISTING
 * `applyHunkSelection` engine (single-owner: `@/runner/hunk-apply`). It does NOT
 * reimplement hunk math or write files by any second path — it records
 * intent → calls `applyHunkSelection` exactly once → persists a terminal
 * receipt `{operationId, path, originalBefore, proposedAfter, expectedCurrent,
 * appliedHunks}` with content HASHES. Undo replays via the journal and REFUSES
 * on `expectedCurrent` drift (fail-closed CAS), never treating the current file
 * as a new baseline (no success-before-effect).
 *
 * Test posture: real-disk, FRESH-READBACK (every "did it land / did it revert"
 * assertion re-reads from disk, never the return value). Every guard assertion
 * is red-on-injection wired in the accompanying comments — the CAS check is
 * proven by drifting the file and observing REFUSAL + disk preservation, not by
 * a stub.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyHunkSelectionWithReceipt,
  type HunkMutationJournalStore,
  makeInMemoryJournalStore,
  undoHunkMutation,
} from "@/runner/hunk-mutation-journal"
import { sha256Hex } from "@/storage"

const fresh = (): string => mkdtempSync(join(tmpdir(), "hunk-journal-"))

// 7-line before / partial after with two disjoint hunks (h1 @ line2, h2 @ line6).
const B = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
const A = ["line1", "L2X", "line3", "line4", "line5", "L6X", "line7"].join("\n")
// Applying only h1 to B:
const AFTER_H1 = ["line1", "L2X", "line3", "line4", "line5", "line6", "line7"].join("\n")

describe("RFC06-4 — apply produces a durable mutation receipt", () => {
  it("records intent → applies once → persists a terminal receipt with the four content hashes", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const store = makeInMemoryJournalStore()

    const out = await applyHunkSelectionWithReceipt(
      { operationId: "op-1", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store },
    )

    expect(out.status).toBe("applied")
    // FRESH-READBACK: only h1 landed.
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)

    // The durable receipt is the intent→effect→terminal artefact.
    const receipt = await store.load("op-1")
    expect(receipt).not.toBeNull()
    if (receipt === null) throw new Error("unreachable")
    expect(receipt.operationId).toBe("op-1")
    expect(receipt.state).toBe("applied")
    expect(receipt.appliedHunks).toEqual(["h1"])
    // Hashes — before/after/expected-current, per the Mutation Receipt primitive.
    expect(receipt.originalBeforeHash).toBe(sha256Hex(B))
    expect(receipt.proposedAfterHash).toBe(sha256Hex(A))
    expect(receipt.expectedCurrentHash).toBe(sha256Hex(AFTER_H1))
  })

  it("does NOT persist an `applied` receipt when the apply is stale (no success-before-effect)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    // Disk drifted vs `before` BEFORE the apply — the engine returns stale.
    writeFileSync(path, "DRIFTED")
    const store = makeInMemoryJournalStore()

    const out = await applyHunkSelectionWithReceipt(
      { operationId: "op-stale", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store },
    )

    expect(out.status).toBe("stale")
    // FRESH-READBACK: disk untouched.
    expect(readFileSync(path, "utf8")).toBe("DRIFTED")
    // No terminal `applied` receipt was written for an effect that never happened.
    const receipt = await store.load("op-stale")
    // Either absent, or present but NOT `applied` — never a success receipt.
    if (receipt !== null) expect(receipt.state).not.toBe("applied")
  })
})

describe("RFC06-4 — CAS undo verifies expectedCurrent and fails closed on drift", () => {
  it("undo restores originalBefore when disk still matches expectedCurrent (fresh-readback)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const store = makeInMemoryJournalStore()
    await applyHunkSelectionWithReceipt(
      { operationId: "op-2", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store },
    )
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)

    const undo = await undoHunkMutation("op-2", { store })
    expect(undo.status).toBe("reverted")
    // FRESH-READBACK: file is back to the pre-apply original.
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  it("undo REFUSES and preserves disk when the file drifted since the apply (CAS drift)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const store = makeInMemoryJournalStore()
    await applyHunkSelectionWithReceipt(
      { operationId: "op-3", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store },
    )
    // External edit AFTER the apply — expectedCurrent no longer matches disk.
    const drifted = `${AFTER_H1}\n// external edit`
    writeFileSync(path, drifted)

    const undo = await undoHunkMutation("op-3", { store })
    // Fail-closed: the current file is NOT a new baseline. Undo refuses.
    expect(undo.status).toBe("stale")
    // RED-ON-INJECTION anchor: if the impl used `current` as the revert baseline
    // (naive revert), this would be `B` — proving the CAS check is load-bearing.
    expect(readFileSync(path, "utf8")).toBe(drifted)
  })

  it("undo on an unknown operationId fails closed (no journal entry ⇒ no write)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const store = makeInMemoryJournalStore()

    const undo = await undoHunkMutation("op-missing", { store })
    expect(undo.status).toBe("not-found")
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  it("undo is idempotent: a second undo after a successful revert refuses (already reverted)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    const store = makeInMemoryJournalStore()
    await applyHunkSelectionWithReceipt(
      { operationId: "op-4", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store },
    )
    const first = await undoHunkMutation("op-4", { store })
    expect(first.status).toBe("reverted")
    expect(readFileSync(path, "utf8")).toBe(B)

    // Second undo: the receipt is now `reverted`; expectedCurrent no longer
    // describes disk (disk is originalBefore). Fail-closed — no double-revert.
    const second = await undoHunkMutation("op-4", { store })
    expect(second.status).not.toBe("reverted")
    expect(readFileSync(path, "utf8")).toBe(B)
  })
})

describe("RFC06-4 — journal store durable round-trip (reuses atomic write, no second ODB)", () => {
  it("a receipt persisted through a durable store is loadable by a fresh store instance", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    // Two store instances over the SAME durable dir — proves persistence, not
    // an in-process map.
    const { makeDurableJournalStore } = await import("@/runner/hunk-mutation-journal")
    const store1: HunkMutationJournalStore = makeDurableJournalStore(join(dir, "journal"))
    await applyHunkSelectionWithReceipt(
      { operationId: "op-dur", path, before: B, after: A, selectedHunkIds: ["h1"] },
      { store: store1 },
    )
    const store2: HunkMutationJournalStore = makeDurableJournalStore(join(dir, "journal"))
    const loaded = await store2.load("op-dur")
    expect(loaded).not.toBeNull()
    if (loaded === null) throw new Error("unreachable")
    expect(loaded.operationId).toBe("op-dur")
    expect(loaded.expectedCurrentHash).toBe(sha256Hex(AFTER_H1))
  })
})
