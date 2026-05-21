import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRetention, JsonlRecorderRetentionBusyError } from "@/stream"

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-retention-"))
  file = join(dir, "trajectory.jsonl")
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a synthetic jsonl with rows of known content and known utf-8 sizes. */
function writeRows(rows: string[]): void {
  writeFileSync(file, rows.length === 0 ? "" : `${rows.join("\n")}\n`)
}

function readRows(): string[] {
  const raw = readFileSync(file, "utf8")
  const parts = raw.split("\n")
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
  return parts
}

describe("applyRetention — happy paths", () => {
  test("file under cap → keep all rows, drop nothing", async () => {
    // 3 rows: 10, 10, 10 utf-8 bytes (excluding newline). With newlines, each
    // contributes 11 bytes on disk. Total on-disk: 33. Cap: 1000.
    writeRows(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"])
    const r = await applyRetention(file, { maxCumulativeBytes: 1000 })
    expect(r).toEqual({ keptRows: 3, droppedRows: 0, droppedBytes: 0 })
    expect(readRows()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"])
  })

  test("drop oldest rows to fit cap (newest-first preservation)", async () => {
    // 4 rows × 9 chars + 1 newline = 10 bytes per row on disk.
    // Cap = 25 ⇒ fits 2 rows (20 bytes), 3rd row (30 bytes total) would exceed.
    const rows = ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc", "ddddddddd"]
    writeRows(rows)
    const r = await applyRetention(file, { maxCumulativeBytes: 25 })
    expect(r.keptRows).toBe(2)
    expect(r.droppedRows).toBe(2)
    // droppedBytes = utf-8 bytes of the dropped row payloads (no newline).
    // 2 rows × 9 bytes = 18.
    expect(r.droppedBytes).toBe(18)
    // Newest-first preservation: the surviving rows are the LAST 2.
    expect(readRows()).toEqual(["ccccccccc", "ddddddddd"])
  })

  test("multi-byte utf-8 counted by bytes not characters", async () => {
    // "한" = 3 bytes utf-8. Row "한한한" = 9 bytes; with newline = 10 bytes.
    // Cap = 21 ⇒ fits 2 rows (20 bytes), 3rd would push to 30.
    const rows = ["한한한", "한한한", "한한한"]
    writeRows(rows)
    const r = await applyRetention(file, { maxCumulativeBytes: 21 })
    expect(r.keptRows).toBe(2)
    expect(r.droppedRows).toBe(1)
    expect(r.droppedBytes).toBe(9)
  })

  test("cap smaller than any single row → drop everything", async () => {
    writeRows(["aaaaaaaaaa", "bbbbbbbbbb"]) // each row = 11 bytes on disk
    const r = await applyRetention(file, { maxCumulativeBytes: 5 })
    expect(r.keptRows).toBe(0)
    expect(r.droppedRows).toBe(2)
    expect(r.droppedBytes).toBe(20)
    expect(readRows()).toEqual([])
  })

  test("empty file → no-op", async () => {
    writeRows([])
    const r = await applyRetention(file, { maxCumulativeBytes: 1000 })
    expect(r).toEqual({ keptRows: 0, droppedRows: 0, droppedBytes: 0 })
  })

  test("missing file → no-op (not an error)", async () => {
    // file path that does not exist
    const r = await applyRetention(join(dir, "nonexistent.jsonl"), {
      maxCumulativeBytes: 1000,
    })
    expect(r).toEqual({ keptRows: 0, droppedRows: 0, droppedBytes: 0 })
  })
})

describe("applyRetention — dry-run", () => {
  test("dry-run reports identical counts without modifying file", async () => {
    const rows = ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc", "ddddddddd"]
    writeRows(rows)
    const before = readFileSync(file, "utf8")
    const r = await applyRetention(file, { maxCumulativeBytes: 25, dryRun: true })
    expect(r.keptRows).toBe(2)
    expect(r.droppedRows).toBe(2)
    expect(r.droppedBytes).toBe(18)
    // File untouched.
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe("applyRetention — busy / atomicity", () => {
  test("sibling .tmp causes JsonlRecorderRetentionBusyError", async () => {
    writeRows(["a", "b", "c"])
    writeFileSync(`${file}.tmp`, "leftover")
    await expect(applyRetention(file, { maxCumulativeBytes: 1 })).rejects.toBeInstanceOf(
      JsonlRecorderRetentionBusyError,
    )
    // File unchanged.
    expect(readRows()).toEqual(["a", "b", "c"])
  })

  test("BusyError carries the tmp path", async () => {
    writeRows(["a"])
    writeFileSync(`${file}.tmp`, "x")
    try {
      await applyRetention(file, { maxCumulativeBytes: 1 })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(JsonlRecorderRetentionBusyError)
      expect((e as JsonlRecorderRetentionBusyError).tmpPath).toBe(`${file}.tmp`)
      expect((e as JsonlRecorderRetentionBusyError).code).toBe("jsonl_retention_busy")
    }
  })

  test("dry-run also respects busy guard (no write but still throws)", async () => {
    writeRows(["a", "b", "c"])
    writeFileSync(`${file}.tmp`, "leftover")
    await expect(
      applyRetention(file, { maxCumulativeBytes: 1, dryRun: true }),
    ).rejects.toBeInstanceOf(JsonlRecorderRetentionBusyError)
  })

  test("rejects invalid maxCumulativeBytes", async () => {
    writeRows(["a"])
    await expect(applyRetention(file, { maxCumulativeBytes: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(applyRetention(file, { maxCumulativeBytes: -1 })).rejects.toBeInstanceOf(
      RangeError,
    )
    await expect(
      applyRetention(file, { maxCumulativeBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(applyRetention(file, { maxCumulativeBytes: Number.NaN })).rejects.toBeInstanceOf(
      RangeError,
    )
  })
})

describe("applyRetention — exact byte accounting", () => {
  test("counts dropped bytes EXACTLY (no ± tolerance)", async () => {
    // Each row is JSON-shaped to mirror real trajectory rows.
    const rowA = JSON.stringify({ seq: 0, kind: "turn_start", data: { turn: 0 } })
    const rowB = JSON.stringify({ seq: 1, kind: "assistant_text", data: { delta: "hi" } })
    const rowC = JSON.stringify({ seq: 2, kind: "tool_call", data: { id: "tu1", name: "bash" } })
    writeRows([rowA, rowB, rowC])

    // utf-8 byte sizes:
    const bytesA = Buffer.byteLength(rowA, "utf8")
    const bytesB = Buffer.byteLength(rowB, "utf8")
    const bytesC = Buffer.byteLength(rowC, "utf8")
    // On-disk per row = bytes + 1 (newline). Cap = bytesC + 1 + 1 — that's
    // just barely enough to fit C alone (its on-disk size including newline).
    // B's on-disk would push us over.
    const cap = bytesC + 1

    const r = await applyRetention(file, { maxCumulativeBytes: cap })
    expect(r.keptRows).toBe(1)
    expect(r.droppedRows).toBe(2)
    expect(r.droppedBytes).toBe(bytesA + bytesB)
    expect(readRows()).toEqual([rowC])
  })

  test("cap exactly equals one row's on-disk size (boundary)", async () => {
    writeRows(["xxx"]) // 3 + 1 = 4 bytes on disk
    const r = await applyRetention(file, { maxCumulativeBytes: 4 })
    expect(r.keptRows).toBe(1)
    expect(r.droppedRows).toBe(0)
  })

  test("cap exactly one byte less than row's on-disk size → dropped", async () => {
    writeRows(["xxx"]) // 4 bytes on disk
    const r = await applyRetention(file, { maxCumulativeBytes: 3 })
    expect(r.keptRows).toBe(0)
    expect(r.droppedRows).toBe(1)
    expect(r.droppedBytes).toBe(3)
  })
})

describe("applyRetention — file output shape", () => {
  test("written file ends with single trailing newline (jsonl invariant)", async () => {
    writeRows(["aaaaaaaaa", "bbbbbbbbb", "ccccccccc"])
    await applyRetention(file, { maxCumulativeBytes: 11 }) // fits last row only
    const raw = readFileSync(file, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    // No double newlines.
    expect(raw.includes("\n\n")).toBe(false)
  })

  test("written file truncates to zero bytes when all dropped", async () => {
    writeRows(["aaaaaaaaa"])
    await applyRetention(file, { maxCumulativeBytes: 1 })
    const raw = readFileSync(file, "utf8")
    expect(raw).toBe("")
  })

  test("no tmp file remains after successful retention", async () => {
    writeRows(["a", "b", "c"])
    await applyRetention(file, { maxCumulativeBytes: 3 })
    expect(() => readFileSync(`${file}.tmp`, "utf8")).toThrow()
  })
})
