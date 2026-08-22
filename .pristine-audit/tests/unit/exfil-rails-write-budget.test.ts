/**
 * jun-6 exfil-rail (a) — per-turn write/edit budget hellgate (TDD red→green).
 *
 * Per RFC jun-6-exfil-egress-rails.md §6 (a):
 *  - cap FIRES at N in an untrusted-context turn (Nth+1 write → confirm/deny)
 *  - cap OFF when trusted (`untrustedContext:false`) → unlimited writes all `ok`
 *  - unwired (`ctx.writeBudget` absent) → byte-identical (no counter touched)
 *  - knob/cap absent ⇒ inert
 *  - counter RESETS at turn boundary (write 1 of turn 2 is `ok` after turn 1 cap)
 *  - NO false positive on a normal (trusted) bulk-write turn
 *  Covers BOTH the pure port and the write/edit tool integration.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bindWriteBudgetTurn,
  createSessionWriteBudget,
  WRITE_BUDGET_REASON,
} from "@/tool/_shared/write-budget"
import type { ToolContext, ToolResult } from "@/tool/types"
import { writeTool } from "@/tool/write"

const dir = mkdtempSync(join(tmpdir(), "exfil-budget-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("createSessionWriteBudget — pure turn-keyed counter", () => {
  test("untrusted: first N `ok`, (N+1)th → overVerdict", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 3,
      overVerdict: "confirm",
    })
    expect(b.recordWrite(0)).toBe("ok")
    expect(b.recordWrite(0)).toBe("ok")
    expect(b.recordWrite(0)).toBe("ok")
    expect(b.recordWrite(0)).toBe("confirm")
    expect(b.recordWrite(0)).toBe("confirm")
  })

  test("deny verdict honored", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 1,
      overVerdict: "deny",
    })
    expect(b.recordWrite(7)).toBe("ok")
    expect(b.recordWrite(7)).toBe("deny")
  })

  test("trusted context ⇒ INERT (1000 writes all `ok`)", () => {
    const b = createSessionWriteBudget({
      untrustedContext: false,
      maxWritesPerTurn: 3,
      overVerdict: "deny",
    })
    for (let i = 0; i < 1000; i++) expect(b.recordWrite(0)).toBe("ok")
  })

  test("invalid cap (0 / negative / NaN) ⇒ INERT even when untrusted", () => {
    for (const max of [0, -5, Number.NaN, 2.5]) {
      const b = createSessionWriteBudget({
        untrustedContext: true,
        maxWritesPerTurn: max,
        overVerdict: "deny",
      })
      for (let i = 0; i < 50; i++) expect(b.recordWrite(0)).toBe("ok")
    }
  })

  test("PER-TURN RESET: turn 2 starts fresh after turn 1 hit the cap", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 2,
      overVerdict: "deny",
    })
    expect(b.recordWrite(1)).toBe("ok")
    expect(b.recordWrite(1)).toBe("ok")
    expect(b.recordWrite(1)).toBe("deny") // turn 1 over cap
    // New turn ordinal ⇒ counter resets ⇒ first write of turn 2 is `ok`.
    expect(b.recordWrite(2)).toBe("ok")
    expect(b.recordWrite(2)).toBe("ok")
    expect(b.recordWrite(2)).toBe("deny")
  })

  test("interleaved turns do not leak count (each turn independent)", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 1,
      overVerdict: "deny",
    })
    expect(b.recordWrite(0)).toBe("ok")
    expect(b.recordWrite(0)).toBe("deny")
    expect(b.recordWrite(1)).toBe("ok") // turn advanced ⇒ reset
  })
})

// ── tool integration ────────────────────────────────────────────────────────

const ctx = (over?: Partial<ToolContext>): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  ...over,
})

const runWrite = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of writeTool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("write tool — budget integration", () => {
  test("FIRES at the cap in an untrusted turn (deny + typed reason)", async () => {
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 2,
      overVerdict: "deny",
    })
    const port = bindWriteBudgetTurn(session, 0, 2)
    const c = ctx({ writeBudget: port })
    expect((await runWrite({ path: join(dir, "a.txt"), content: "1" }, c)).ok).toBe(true)
    expect((await runWrite({ path: join(dir, "b.txt"), content: "2" }, c)).ok).toBe(true)
    const third = await runWrite({ path: join(dir, "c.txt"), content: "3" }, c)
    expect(third.ok).toBe(false)
    expect(third.failure).toEqual({ mode: "rejected", reason: WRITE_BUDGET_REASON })
    // The over-cap write must NOT touch the filesystem (no partial write).
    expect(() => readFileSync(join(dir, "c.txt"), "utf8")).toThrow()
  })

  test("message surfaces the configured cap", async () => {
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 1,
      overVerdict: "deny",
    })
    const c = ctx({ writeBudget: bindWriteBudgetTurn(session, 0, 1) })
    await runWrite({ path: join(dir, "m1.txt"), content: "x" }, c)
    const over = await runWrite({ path: join(dir, "m2.txt"), content: "y" }, c)
    expect(over.output).toContain("1")
    expect(over.output.toLowerCase()).toContain("budget")
  })

  test("TRUSTED turn ⇒ no false positive (bulk writes all succeed)", async () => {
    const session = createSessionWriteBudget({
      untrustedContext: false,
      maxWritesPerTurn: 2,
      overVerdict: "deny",
    })
    const c = ctx({ writeBudget: bindWriteBudgetTurn(session, 0, 2) })
    for (let i = 0; i < 20; i++) {
      const r = await runWrite({ path: join(dir, `bulk-${i}.txt`), content: "z" }, c)
      expect(r.ok).toBe(true)
    }
  })

  test("UNWIRED (ctx.writeBudget absent) ⇒ byte-identical (unlimited writes)", async () => {
    const c = ctx()
    for (let i = 0; i < 20; i++) {
      const r = await runWrite({ path: join(dir, `unwired-${i}.txt`), content: "z" }, c)
      expect(r.ok).toBe(true)
    }
  })
})
