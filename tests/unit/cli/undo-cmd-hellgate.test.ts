/**
 * RFC-def restore Surface A — `/undo` hunk-revert front-door hellgate.
 *
 * `/undo` surfaces the EXISTING RFC06-4 durable CAS undo journal
 * (`@/runner/hunk-mutation-journal`) over the CLI. This suite drives the REAL
 * slash command against a REAL journal store (in-memory AND durable-on-disk),
 * with FRESH-READBACK from disk for every "did it revert / did it refuse"
 * assertion — never the command's own return value.
 *
 * The load-bearing safety claims (per the destructive-restore contract):
 *   - front-door revert: a real apply receipt → `/undo <op> --yes` reverts the
 *     file when the disk still hash-matches `expectedCurrentHash`.
 *   - FAIL-CLOSED on CAS drift: an external edit after the apply ⇒ `/undo`
 *     REFUSES (exit 1, operator-visible notice) and the drifted file is LEFT
 *     UNCHANGED — never blind-overwritten, never treated as a new baseline.
 *   - explicit confirm: without `--yes` the command previews and does NOTHING.
 *   - gate-OFF byte-identical: `QUANTA_HUNK_UNDO` unset ⇒ `/undo` is NOT
 *     registered; even if invoked with no `hunkUndo` slot it prints "not wired".
 *
 * RED-ON-INJECTION anchor: the drift test asserts the file stays DRIFTED after a
 * refused undo. If the surface (or the journal it delegates to) dropped the CAS
 * check and blind-reverted, this file would become the pre-apply `B` — the test
 * flips refuse→overwrite RED. (The journal's own CAS unit is pinned in
 * `tests/unit/runner/hunk-mutation-journal.test.ts`; this pins the SURFACE
 * relays that refusal faithfully.)
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILTINS } from "@/apps/cli/slash-commands"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { undoCmd, __test as undoTest } from "@/apps/cli/undo-cmd"
import {
  applyHunkSelectionWithReceipt,
  type HunkMutationJournalStore,
  makeDurableJournalStore,
  makeInMemoryJournalStore,
} from "@/runner/hunk-mutation-journal"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const fresh = (): string => mkdtempSync(join(tmpdir(), "undo-cmd-"))

// 7-line before / partial after with two disjoint hunks (h1 @ line2).
const B = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
const A = ["line1", "L2X", "line3", "line4", "line5", "L6X", "line7"].join("\n")
const AFTER_H1 = ["line1", "L2X", "line3", "line4", "line5", "line6", "line7"].join("\n")

interface CapturedCtx extends SlashContext {
  readonly outBuf: string[]
  readonly errBuf: string[]
}

const makeCtx = (store?: HunkMutationJournalStore): CapturedCtx => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    ...(store !== undefined ? { hunkUndo: { store } } : {}),
  } as CapturedCtx
}

/** Apply h1 to B via the REAL journal wrapper, leaving AFTER_H1 on disk + a
 *  durable `applied` receipt in `store`. Returns the op path. */
const seedApply = async (
  store: HunkMutationJournalStore,
  path: string,
  operationId: string,
): Promise<void> => {
  writeFileSync(path, B)
  const out = await applyHunkSelectionWithReceipt(
    { operationId, path, before: B, after: A, selectedHunkIds: ["h1"] },
    { store },
  )
  if (out.status !== "applied") throw new Error(`seed apply failed: ${out.status}`)
}

/* ------------------------------------------------------------------ */
/* front-door: revert on hash match                                    */
/* ------------------------------------------------------------------ */

describe("Surface A — /undo front-door revert (hash match)", () => {
  test("real receipt → /undo <op> --yes reverts the file (fresh-readback)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-front")
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)

    const ctx = makeCtx(store)
    const code = await undoCmd.run(["op-front", "--yes"], ctx)

    expect(code).toBe(0)
    // FRESH-READBACK: file is back to the pre-apply original.
    expect(readFileSync(path, "utf8")).toBe(B)
    expect(ctx.outBuf.join("")).toContain("reverted")
  })

  test("durable-on-disk store: /undo reverts through the persisted receipt", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeDurableJournalStore(join(dir, "journal"))
    await seedApply(store, path, "op-dur")
    // A FRESH store instance over the SAME dir (proves durability, not memory).
    const store2 = makeDurableJournalStore(join(dir, "journal"))
    const ctx = makeCtx(store2)

    const code = await undoCmd.run(["op-dur", "--yes"], ctx)
    expect(code).toBe(0)
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  test("list mode (no args) surfaces the recent apply receipt", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-list")
    const ctx = makeCtx(store)
    const code = await undoCmd.run([], ctx)
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("op-list".slice(0, 8))
    expect(out).toContain("applied")
  })
})

/* ------------------------------------------------------------------ */
/* FAIL-CLOSED: refuse on CAS drift (the crux)                         */
/* ------------------------------------------------------------------ */

describe("Surface A — /undo fails closed on CAS drift (no blind overwrite)", () => {
  test("external edit after apply ⇒ /undo REFUSES + file left unchanged", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-drift")

    // External edit AFTER the apply — disk no longer matches expectedCurrentHash.
    const drifted = `${AFTER_H1}\n// external edit`
    writeFileSync(path, drifted)

    const ctx = makeCtx(store)
    const code = await undoCmd.run(["op-drift", "--yes"], ctx)

    // Fail-closed: the surface relays the journal's refusal.
    expect(code).toBe(1)
    expect(ctx.errBuf.join("")).toContain("refused")
    // RED-ON-INJECTION: if the CAS check were dropped and the file blind-reverted
    // to the naive baseline, this would be `B`. The drifted bytes MUST survive.
    expect(readFileSync(path, "utf8")).toBe(drifted)
  })

  test("double-undo: second /undo after a successful revert refuses (already reverted)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-twice")
    const ctx1 = makeCtx(store)
    expect(await undoCmd.run(["op-twice", "--yes"], ctx1)).toBe(0)
    expect(readFileSync(path, "utf8")).toBe(B)

    // Second undo: receipt is now `reverted` ⇒ not offered as a revertible
    // target (resolveOpId filters to `applied`), so the surface reports it as
    // "no revertible mutation" and never touches disk.
    const ctx2 = makeCtx(store)
    const code = await undoCmd.run(["op-twice", "--yes"], ctx2)
    expect(code).toBe(1)
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  test("unknown operationId ⇒ refuse, no write", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-known")
    const ctx = makeCtx(store)
    const code = await undoCmd.run(["op-DOES-NOT-EXIST", "--yes"], ctx)
    expect(code).toBe(1)
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)
  })
})

/* ------------------------------------------------------------------ */
/* explicit confirm                                                    */
/* ------------------------------------------------------------------ */

describe("Surface A — /undo requires explicit confirm", () => {
  test("without --yes: preview only, file UNCHANGED", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    const store = makeInMemoryJournalStore()
    await seedApply(store, path, "op-preview")
    const ctx = makeCtx(store)
    const code = await undoCmd.run(["op-preview"], ctx)
    expect(code).toBe(0)
    expect(ctx.outBuf.join("")).toContain("Re-run with --yes")
    // FRESH-READBACK: no revert happened.
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)
  })
})

/* ------------------------------------------------------------------ */
/* gate-OFF byte-identical + not-wired                                 */
/* ------------------------------------------------------------------ */

describe("Surface A — /undo gate-OFF + not-wired posture", () => {
  test("no hunkUndo slot ⇒ 'not wired' + exit 2, no throw", async () => {
    const ctx = makeCtx(/* no store */)
    const code = await undoCmd.run(["op-x", "--yes"], ctx)
    expect(code).toBe(2)
    expect(ctx.outBuf.join("")).toContain("not wired")
    expect(ctx.outBuf.join("")).toContain(undoTest.HUNK_UNDO_GATE)
  })

  test("gate OFF ⇒ /undo is NOT registered in BUILTINS (byte-identical absence)", () => {
    // The test process runs with QUANTA_HUNK_UNDO unset (default OFF), so the
    // env-gated registry never spreads `undoCmd`.
    expect(process.env.QUANTA_HUNK_UNDO).toBeUndefined()
    expect(BUILTINS.find((c) => c.name === "/undo")).toBeUndefined()
  })

  test("isHunkUndoEnabled: default OFF, truthy vocab ON", async () => {
    const { isHunkUndoEnabled } = await import("@/apps/cli/undo-cmd")
    expect(isHunkUndoEnabled({})).toBe(false)
    expect(isHunkUndoEnabled({ QUANTA_HUNK_UNDO: "0" })).toBe(false)
    expect(isHunkUndoEnabled({ QUANTA_HUNK_UNDO: "1" })).toBe(true)
    expect(isHunkUndoEnabled({ QUANTA_HUNK_UNDO: "true" })).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("Surface A — /undo pure resolvers", () => {
  test("resolveOpId only offers `applied` receipts + rejects ambiguity", () => {
    const now = new Date().toISOString()
    const mk = (operationId: string, state: "applied" | "reverted") => ({
      operationId,
      path: "/x",
      originalBefore: "",
      originalBeforeHash: "",
      proposedAfter: "",
      proposedAfterHash: "",
      expectedCurrentHash: "",
      appliedHunks: [] as string[],
      state,
      createdAt: now,
      updatedAt: now,
    })
    const receipts = [mk("abc-1", "applied"), mk("abc-2", "applied"), mk("rev-1", "reverted")]
    // Ambiguous prefix.
    expect(typeof undoTest.resolveOpId(receipts, "abc")).toBe("string")
    // Unique applied.
    const hit = undoTest.resolveOpId(receipts, "abc-1")
    expect(typeof hit === "object" && hit.operationId).toBe("abc-1")
    // A reverted receipt is NOT a revertible target.
    expect(typeof undoTest.resolveOpId(receipts, "rev-1")).toBe("string")
  })
})
