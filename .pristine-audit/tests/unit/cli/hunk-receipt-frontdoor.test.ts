/**
 * RFC06-4 (B5) — FRONT-DOOR proof: the real CLI per-hunk apply caller
 * (`runHunkSelect` in `cli-hunk-select-flow.ts`) produces a durable CAS undo
 * receipt when `hunkMutationReceipt` is on and a journal store is wired, and
 * that receipt drives an undo that REFUSES on disk drift (fail-closed CAS).
 *
 * This is NOT a projector unit — it drives the same `runHunkSelect` the CLI
 * approval prompt calls, through the same `applyHunkSelectionWithReceipt`
 * wrapper the composition would wire. Real disk, fresh-readback.
 *
 * RED-ON-INJECTION anchors:
 *   - Gate OFF (no `QUANTA_HUNK_MUTATION_RECEIPT`) ⇒ NO receipt persisted
 *     (byte-identical apply). Reverting the gate check would fail the OFF case.
 *   - Undo after external drift ⇒ `stale` + disk preserved. If the impl used
 *     `current` as the revert baseline (naive revert), the drift test would
 *     restore the original and fail.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDurableJournalStore, undoHunkMutation } from "@/runner/hunk-mutation-journal"
import { __resetRuntimeConfig } from "@/shared"
import { sha256Hex } from "@/storage"
import type { ActionDiff } from "../../../src/apps/cli/diff-preview"
import type { CliHitlDeps } from "../../../src/apps/cli/repl/cli-approval-prompt"
import { runHunkSelect } from "../../../src/apps/cli/repl/cli-hunk-select-flow"

const fresh = (): string => mkdtempSync(join(tmpdir(), "hunk-fd-"))

const B = ["a", "b", "c", "d", "e", "f", "g"].join("\n")
const A = ["a", "B2", "c", "d", "e", "F2", "g"].join("\n")
const AFTER_H1 = ["a", "B2", "c", "d", "e", "f", "g"].join("\n")

// Minimal fake CliHitlDeps — only the fields runHunkSelect touches.
const makeDeps = (cwd: string, store?: CliHitlDeps["mutationJournal"]): CliHitlDeps =>
  ({
    cwd,
    channel: { active: false } as CliHitlDeps["channel"],
    idleMonitor: { markActive() {} } as unknown as CliHitlDeps["idleMonitor"],
    rejectCounter: {
      recordAccept() {},
      recordDeny() {},
    } as unknown as CliHitlDeps["rejectCounter"],
    ...(store !== undefined ? { mutationJournal: store } : {}),
  }) as CliHitlDeps

// askLine that accepts only h1 (returns "1").
const askH1 = async (): Promise<string> => "1"

const setReceiptGate = (on: boolean): void => {
  if (on) process.env.QUANTA_HUNK_MUTATION_RECEIPT = "1"
  else delete process.env.QUANTA_HUNK_MUTATION_RECEIPT
  __resetRuntimeConfig()
}

const setUndoGate = (on: boolean): void => {
  if (on) process.env.QUANTA_HUNK_UNDO = "1"
  else delete process.env.QUANTA_HUNK_UNDO
  __resetRuntimeConfig()
}

afterEach(() => {
  delete process.env.QUANTA_HUNK_MUTATION_RECEIPT
  delete process.env.QUANTA_HUNK_UNDO
  __resetRuntimeConfig()
})

describe("RFC06-4 front-door — CLI runHunkSelect emits a durable CAS undo receipt", () => {
  it("gate ON + store wired ⇒ a receipt is persisted; undo restores original (fresh-readback)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    setReceiptGate(true)
    const store = makeDurableJournalStore(join(dir, "journal"))
    const diff: ActionDiff = { path, before: B, after: A }
    const ids = ["h1", "h2"]

    const decision = await runHunkSelect(makeDeps(dir, store), diff, ids, askH1)
    // The gate still returns the deny_and_steer partial decision.
    expect(typeof decision === "object" && decision !== null).toBe(true)
    // FRESH-READBACK: only h1 landed on disk.
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)

    // A durable receipt exists — find it (operationId is uuid-generated, so
    // scan the store dir via a fresh store lookup by reading the one file).
    const opId = onlyReceiptId(join(dir, "journal"))
    const store2 = makeDurableJournalStore(join(dir, "journal"))
    const receipt = await store2.load(opId)
    expect(receipt).not.toBeNull()
    if (receipt === null) throw new Error("unreachable")
    expect(receipt.state).toBe("applied")
    expect(receipt.appliedHunks).toEqual(["h1"])
    expect(receipt.expectedCurrentHash).toBe(sha256Hex(AFTER_H1))

    // Undo replays through the receipt — original restored.
    const undo = await undoHunkMutation(opId, { store: store2 })
    expect(undo.status).toBe("reverted")
    expect(readFileSync(path, "utf8")).toBe(B)
  })

  it("undo REFUSES after external drift (CAS fail-closed; disk preserved)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    setReceiptGate(true)
    const store = makeDurableJournalStore(join(dir, "journal"))
    await runHunkSelect(makeDeps(dir, store), { path, before: B, after: A }, ["h1", "h2"], askH1)

    const drifted = `${AFTER_H1}\n// external`
    writeFileSync(path, drifted)
    const opId = onlyReceiptId(join(dir, "journal"))
    const undo = await undoHunkMutation(opId, { store })
    expect(undo.status).toBe("stale")
    // Naive-revert red anchor: this must NOT be B.
    expect(readFileSync(path, "utf8")).toBe(drifted)
  })

  it("both gates OFF ⇒ NO receipt persisted (byte-identical apply)", async () => {
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    setReceiptGate(false)
    setUndoGate(false)
    const store = makeDurableJournalStore(join(dir, "journal"))
    await runHunkSelect(makeDeps(dir, store), { path, before: B, after: A }, ["h1", "h2"], askH1)
    // The apply still happened (only h1).
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)
    // But NO receipt file exists — the journal dir was never written.
    expect(receiptCount(join(dir, "journal"))).toBe(0)
  })

  it("QUANTA_HUNK_UNDO=1 alone ⇒ applies persist (so /undo is self-sufficient)", async () => {
    // The `/undo` gate makes the receipt path fire even without the receipt
    // gate — a journal with no persisted applies would be a silent dead surface.
    const dir = fresh()
    const path = join(dir, "f.txt")
    writeFileSync(path, B)
    setReceiptGate(false)
    setUndoGate(true)
    const store = makeDurableJournalStore(join(dir, "journal"))
    await runHunkSelect(makeDeps(dir, store), { path, before: B, after: A }, ["h1", "h2"], askH1)
    expect(readFileSync(path, "utf8")).toBe(AFTER_H1)
    // A receipt WAS persisted under the undo gate alone.
    expect(receiptCount(join(dir, "journal"))).toBe(1)
    const opId = onlyReceiptId(join(dir, "journal"))
    const undo = await undoHunkMutation(opId, { store })
    expect(undo.status).toBe("reverted")
    expect(readFileSync(path, "utf8")).toBe(B)
  })
})

// Helpers — read the one receipt file's operationId from the journal dir.
const receiptCount = (dir: string): number => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length
  } catch {
    return 0
  }
}
const onlyReceiptId = (dir: string): string => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  if (files.length !== 1) throw new Error(`expected 1 receipt, got ${files.length}`)
  const raw = readFileSync(join(dir, files[0] as string), "utf8")
  return (JSON.parse(raw) as { operationId: string }).operationId
}
