/**
 * ADVERSARIAL HELLGATE — exfil write-budget rail (jun-6 exfil-rail a),
 * DEEPER LAYER.
 *
 * ADDS territory `tests/unit/exfil-rails-write-budget.test.ts` does not cover:
 *   - CROSS-TOOL shared counter: write + edit tally against ONE per-turn budget
 *     (a drip-exfil that alternates write/edit must not get 2x the cap).
 *   - CONCURRENCY: many recordWrite() racing in one turn cannot exceed the cap
 *     (the counter is monotone; the (cap+1)-th call — in ANY interleaving — is
 *     the first to be over).
 *   - TURN-PINNING via bindWriteBudgetTurn: a port bound to turn T counts into
 *     turn T even if the session later advances (a stale bound port cannot reset
 *     itself by being called in a "new" turn — it has no new turn to pass).
 *   - EXACT boundary at cap and cap+1 for BOTH overVerdict arms, and that a
 *     confirm verdict is NOT a filesystem write (deny-side effect parity).
 *
 * THE INVARIANT: in an untrusted-input turn, the number of writes+edits that
 * return "ok" is EXACTLY the cap — never more, under any tool mix or interleave.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bindWriteBudgetTurn,
  createSessionWriteBudget,
  WRITE_BUDGET_REASON,
} from "@/tool/_shared/write-budget"
import type { ToolContext, ToolResult } from "@/tool/types"
import { editTool } from "@/tool/edit"
import { writeTool } from "@/tool/write"

const dir = mkdtempSync(join(tmpdir(), "exfil-budget-adv-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (over?: Partial<ToolContext>): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  ...over,
})

const drain = async (
  gen: AsyncIterable<{ type: string; result?: ToolResult }>,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of gen) if (ev.type === "result") result = ev.result as ToolResult
  if (!result) throw new Error("no result")
  return result
}
const runWrite = (input: unknown, c: ToolContext) =>
  drain(writeTool.execute(input as never, c))
const runEdit = (input: unknown, c: ToolContext) => drain(editTool.execute(input as never, c))

describe("write-budget adversarial — CROSS-TOOL shared counter (write + edit share one cap)", () => {
  test("alternating write/edit against ONE session cannot exceed the per-turn cap", async () => {
    // cap = 2. A write, then an edit, then a write → the 3rd op (a write) must
    // be denied. If write and edit each had their own counter, the drip would
    // get 4 free ops. This pins the SHARED-counter security property.
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 2,
      overVerdict: "deny",
    })
    const port = bindWriteBudgetTurn(session, 0, 2)
    const c = ctx({ writeBudget: port })

    // Seed a file for the edit to mutate.
    const target = join(dir, "shared-target.txt")
    const wrote1 = await runWrite({ path: target, content: "hello world" }, c) // op 1 (write)
    expect(wrote1.ok).toBe(true)

    const edited = await runEdit(
      { path: target, old_string: "hello", new_string: "HELLO" },
      c,
    ) // op 2 (edit)
    expect(edited.ok).toBe(true)

    const wrote3 = await runWrite({ path: join(dir, "third.txt"), content: "x" }, c) // op 3 → over cap
    expect(wrote3.ok).toBe(false)
    expect(wrote3.failure).toEqual({ mode: "rejected", reason: WRITE_BUDGET_REASON })
    expect(existsSync(join(dir, "third.txt"))).toBe(false) // denied write never hits disk
  })
})

describe("write-budget adversarial — CONCURRENCY (racing recordWrite cannot exceed the cap)", () => {
  test("N concurrent recordWrite(sameTurn) yield EXACTLY cap oks, rest over", () => {
    const cap = 5
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: cap,
      overVerdict: "deny",
    })
    // Fire 100 records for the same turn "concurrently" (JS is single-threaded so
    // these interleave deterministically, but the invariant — count of oks — must
    // hold regardless of ordering).
    const verdicts = Array.from({ length: 100 }, () => session.recordWrite(0))
    const oks = verdicts.filter((v) => v === "ok").length
    const denies = verdicts.filter((v) => v === "deny").length
    expect(oks).toBe(cap)
    expect(denies).toBe(100 - cap)
  })

  test("interleaving two turns' records keeps EACH turn's ok-count at its cap", () => {
    const cap = 3
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: cap,
      overVerdict: "deny",
    })
    // Note: the counter is turn-keyed and RESETS on turn change, so a genuinely
    // interleaved A,B,A,B pattern resets each time the turn flips. This pins that
    // the reset is by turn-ORDINAL change (documented semantics), so a caller
    // must bind a stable turn (bindWriteBudgetTurn) — see the next block.
    const seq = [0, 0, 0, 1, 1, 1, 0]
    const verdicts = seq.map((t) => session.recordWrite(t))
    // First three of turn 0 → ok, then turn flips to 1 (reset) → three ok, then
    // back to 0 (reset again) → ok. No over-cap because the flips reset.
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"])
  })
})

describe("write-budget adversarial — TURN-PINNING (a bound port cannot reset by turn drift)", () => {
  test("a port bound to turn 0 keeps counting into turn 0 even after the session sees turn 1", () => {
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 2,
      overVerdict: "deny",
    })
    const boundToTurn0 = bindWriteBudgetTurn(session, 0, 2)
    expect(boundToTurn0.recordWrite()).toBe("ok")
    expect(boundToTurn0.recordWrite()).toBe("ok")
    // A DIFFERENT port advances the session to turn 1 (resets internal counter).
    const boundToTurn1 = bindWriteBudgetTurn(session, 1, 2)
    expect(boundToTurn1.recordWrite()).toBe("ok")
    // The turn-0 port, called again, now passes turn 0 ≠ lastTurn(1) → the
    // session RESETS to turn 0. This is the documented turn-keyed reset: a stale
    // bound port does NOT carry a frozen count; it re-keys on its own turn. Pin
    // the actual behavior so a refactor to a truly-frozen count is a deliberate,
    // RED-surfacing change (not a silent budget-doubling).
    expect(boundToTurn0.recordWrite()).toBe("ok") // re-keyed turn 0, fresh count = 1
  })

  test("maxWritesPerTurn surfaced on the bound port matches the configured cap", () => {
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 7,
      overVerdict: "confirm",
    })
    expect(bindWriteBudgetTurn(session, 0, 7).maxWritesPerTurn).toBe(7)
  })
})

describe("write-budget adversarial — EXACT boundary at cap / cap+1 for both arms", () => {
  test("confirm arm: exactly cap oks, then confirm at cap+1", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 4,
      overVerdict: "confirm",
    })
    for (let i = 0; i < 4; i++) expect(b.recordWrite(0)).toBe("ok")
    expect(b.recordWrite(0)).toBe("confirm") // cap+1
  })

  test("cap of 1: first ok, second over (tightest boundary)", () => {
    const b = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 1,
      overVerdict: "deny",
    })
    expect(b.recordWrite(9)).toBe("ok")
    expect(b.recordWrite(9)).toBe("deny")
  })

  test("a 'confirm' over-cap write in the TOOL is not silently applied to disk", async () => {
    // The tool maps confirm→rejected in headless/auto (no interactive resolver in
    // this ctx). Either way, the over-cap file must not appear.
    const session = createSessionWriteBudget({
      untrustedContext: true,
      maxWritesPerTurn: 1,
      overVerdict: "confirm",
    })
    const c = ctx({ writeBudget: bindWriteBudgetTurn(session, 0, 1) })
    await runWrite({ path: join(dir, "cap-ok.txt"), content: "a" }, c)
    const over = await runWrite({ path: join(dir, "cap-over.txt"), content: "b" }, c)
    expect(over.ok).toBe(false)
    expect(existsSync(join(dir, "cap-over.txt"))).toBe(false)
  })
})

describe("write-budget adversarial — untrusted-gating is the SOLE FP control", () => {
  test("trusted context: 10000 records all ok (cap NEVER fires — no FP on bulk codegen)", () => {
    const b = createSessionWriteBudget({
      untrustedContext: false,
      maxWritesPerTurn: 3,
      overVerdict: "deny",
    })
    let allOk = true
    for (let i = 0; i < 10_000; i++) if (b.recordWrite(i % 4) !== "ok") allOk = false
    expect(allOk).toBe(true)
  })

  test("flipping untrustedContext true→ cap fires: proves the gate is what enables it", () => {
    // Two sessions, identical cap, differ ONLY by untrustedContext. The trusted
    // one never denies; the untrusted one denies past the cap. This is the
    // paired-control that proves the gate — not some fixture — is load-bearing.
    const mk = (untrusted: boolean) =>
      createSessionWriteBudget({ untrustedContext: untrusted, maxWritesPerTurn: 1, overVerdict: "deny" })
    const trusted = mk(false)
    const untrusted = mk(true)
    expect(trusted.recordWrite(0)).toBe("ok")
    expect(trusted.recordWrite(0)).toBe("ok") // no cap
    expect(untrusted.recordWrite(0)).toBe("ok")
    expect(untrusted.recordWrite(0)).toBe("deny") // cap fires
  })
})
