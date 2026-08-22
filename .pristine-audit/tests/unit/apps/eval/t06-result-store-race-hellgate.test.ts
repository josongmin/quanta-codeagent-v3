import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResultStore } from "@/apps/eval/storage/result-store"

/**
 * T06 — Eval result-store concurrent append hellgate (L5 M-9).
 *
 * Proof rail: concurrent `append()` calls to the SAME runId serialise through
 * the per-runId write tail — no interleaved / lost JSONL lines — AND the
 * internal write-tail map does not leak a settled promise per runId forever
 * (it is pruned once drained).
 */

let dir: string
const mk = (): ResultStore => {
  dir = mkdtempSync(join(tmpdir(), "t06-eval-store-"))
  return new ResultStore({ dir, now: () => 1_700_000_000_000 })
}

const rec = (i: number) =>
  ({
    tier: "tier1" as const,
    usecase: `uc-${i}`,
    payload: { kind: "grounding" as const, score: i },
  }) as unknown as Parameters<ResultStore["append"]>[1]

const cleanup = (): void => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
}

describe("T06 / eval result-store concurrent append", () => {
  test("STORE-1: N concurrent appends to one runId produce N intact JSONL lines", async () => {
    const store = mk()
    try {
      const runId = "20260531-000000-tier1-aaaa"
      await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(runId, rec(i))))
      await store.drain()
      const text = readFileSync(store.fileFor(runId), "utf8")
      const lines = text.split("\n").filter((l) => l !== "")
      expect(lines).toHaveLength(50)
      // Every line is a well-formed JSON object (no torn / interleaved write).
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    } finally {
      cleanup()
    }
  })

  test("STORE-2: write tail map is pruned after drain (no per-runId leak)", async () => {
    const store = mk()
    try {
      for (let r = 0; r < 20; r++) {
        await store.append(`20260531-000000-tier1-${r.toString(16).padStart(4, "0")}`, rec(r))
      }
      await store.drain()
      // Reach into the private map via an index cast — the contract is "settled
      // tails do not accumulate". After drain there must be no retained tails.
      const tails = (store as unknown as { writeTails: Map<string, unknown> }).writeTails
      expect(tails.size).toBe(0)
    } finally {
      cleanup()
    }
  })
})
