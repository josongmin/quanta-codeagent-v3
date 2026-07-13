/**
 * SOTA++ hellgate unit suite for the `/goal` slash command (Codex `/goal`
 * parity) — `src/apps/cli/slash/goal-cmd.ts`.
 *
 * This suite exercises the REAL command against a REAL `createObjectiveStore()`
 * (no mocks, no fakes of the store): every mutating assertion is verified by a
 * FRESH READBACK from the same store instance the command wrote through
 * (`port.get(TID)`), and every render assertion observes a REAL out-buffer the
 * ctx.out closure appends to. No `expect(true)`, no vacuous-narrowed literals:
 * the exact status string, the exact out substrings, and the exact numeric exit
 * code are pinned on every branch.
 *
 * Mutation-grade (red-on-injection) posture, branch by branch:
 *   - set:      cut `port.set`/`updateStatus("active")` → readback goes null /
 *               status drifts → red. Flip the joined-args or the `.trim()` →
 *               the stored goal string mismatches → red.
 *   - show:     cut the `Pursuing goal:` render or the budget line → substring
 *               assert red. Return non-zero → code assert red.
 *   - clear:    flip `updateStatus("paused")` → readback status stays "active"
 *               → red. Return the wrong branch for "no active objective" → red.
 *   - not-wired: any throw / non-zero code / missing "not wired" → red. The
 *               PAIRED CONTROL (§9) runs the identical args WITH the slot and
 *               proves the slot presence is the ONLY discriminator.
 *   - max-chars: off-by-one on the `> MAX_GOAL_CHARS` boundary → the exactly-at
 *               -limit case flips to exit 1 → red; the over-limit case flips to
 *               exit 0 → red.
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveStore, type ObjectivePort } from "@/agent/objective"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"

const TID = "thread-goal-cmd"

/** Read `MAX_GOAL_CHARS` from the target file so the boundary tests track the
 *  SUT's real limit rather than a hard-coded copy that could silently drift.
 *  (The constant is not exported; the file is tiny and this is a leaf-crate
 *  static read, so we parse it once at load time.) */
const MAX_GOAL_CHARS: number = (() => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(import.meta.dir, "../../src/apps/cli/slash/goal-cmd.ts"),
    "utf8",
  ) as string
  const m = src.match(/const\s+MAX_GOAL_CHARS\s*=\s*(\d+)/)
  if (!m) throw new Error("could not read MAX_GOAL_CHARS from goal-cmd.ts")
  return Number(m[1])
})()

/** A minimal SlashContext carrying only what `/goal` reads: out/err + the shared
 *  objective slot. `out` appends to `buf` for real render observation. */
const ctxWired = (port: ObjectivePort, buf: string[], threadId = TID): SlashContext => ({
  out: (s) => buf.push(s),
  err: () => {},
  cwd: "/tmp",
  goal: { port, threadId },
})

/** The SAME minimal ctx but WITHOUT the goal slot — the not-wired posture. This
 *  is the paired control: identical except `goal` is absent. */
const ctxBare = (buf: string[]): SlashContext => ({
  out: (s) => buf.push(s),
  err: () => {},
  cwd: "/tmp",
})

/** Concatenate the out-buffer for substring assertions (the command may emit in
 *  one or more `out()` calls). */
const text = (buf: string[]): string => buf.join("")

// ─────────────────────────────────────────────────────────────────────────────
// 1. SET path
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal <objective> — set path", () => {
  test("records the goal, marks it active, confirms — fresh readback", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []

    const code = await goalCmd.run(["ship", "the", "feature"], ctxWired(port, buf))

    expect(code).toBe(0)
    // Fresh readback from the REAL store — not the return of set, the store.
    const o = port.get(TID)
    expect(o).not.toBeNull()
    // Multi-word args joined with a single space.
    expect(o?.goal).toBe("ship the feature")
    // Status transitioned to the explicit "active" intent.
    expect(o?.status).toBe("active")
    // Real render observed.
    expect(text(buf)).toContain("Pursuing goal set")
    expect(text(buf)).toContain("ship the feature")
  })

  test("single-word goal is stored verbatim", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const code = await goalCmd.run(["refactor"], ctxWired(port, buf))
    expect(code).toBe(0)
    expect(port.get(TID)?.goal).toBe("refactor")
    expect(port.get(TID)?.status).toBe("active")
  })

  test("leading/trailing whitespace is trimmed before storing", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    // args.join(" ") = "  padded goal  "; the command `.trim()`s it.
    const code = await goalCmd.run(["", "", "padded goal", "", ""], ctxWired(port, buf))
    expect(code).toBe(0)
    // Red-on-injection: drop the `.trim()` and this is "  padded goal  ".
    expect(port.get(TID)?.goal).toBe("padded goal")
  })

  test("interior whitespace within a single arg is preserved (only ends trimmed)", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const code = await goalCmd.run(["  keep   inner   spaces  "], ctxWired(port, buf))
    expect(code).toBe(0)
    expect(port.get(TID)?.goal).toBe("keep   inner   spaces")
  })

  test("the confirmation names QUANTA_GOAL_ENFORCE (honest not-auto posture)", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    await goalCmd.run(["do", "it"], ctxWired(port, buf))
    // The command promises the goal is recorded-only without the enforce gate.
    expect(text(buf)).toContain("QUANTA_GOAL_ENFORCE")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHOW path
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal (no arg) — show path", () => {
  test("with an active goal → renders 'Pursuing goal: <goal>' + status", async () => {
    const port = createObjectiveStore()
    // Seed via the command itself, then show.
    await goalCmd.run(["build", "the", "thing"], ctxWired(port, []))

    const buf: string[] = []
    const code = await goalCmd.run([], ctxWired(port, buf))

    expect(code).toBe(0)
    const out = text(buf)
    expect(out).toContain("Pursuing goal: build the thing")
    // Status line present and reflects the real derived status.
    expect(out).toContain("status: active")
  })

  test("with a budget set → shows the tokens line", async () => {
    const port = createObjectiveStore()
    // Seed directly through the store with a maxTokens cap + used tokens so the
    // show path's `budgetLine` branch is exercised. The command has no budget
    // arg; the budget arrives via the LLM `objective_*` tools in production.
    port.set(TID, { goal: "budgeted goal", budget: { maxTokens: 1000 } })
    port.updateStatus(TID, "active")
    port.recordUsage(TID, { tokens: 250 })

    const buf: string[] = []
    const code = await goalCmd.run([], ctxWired(port, buf))

    expect(code).toBe(0)
    const out = text(buf)
    expect(out).toContain("Pursuing goal: budgeted goal")
    // Exact tokens line: `${tokensUsed}/${maxTokens} tokens`.
    expect(out).toContain("250/1000 tokens")
  })

  test("with NO budget → the tokens line is absent (not '/undefined')", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["no", "budget"], ctxWired(port, []))
    const buf: string[] = []
    await goalCmd.run([], ctxWired(port, buf))
    const out = text(buf)
    // Red-on-injection: if the budgetLine were emitted unconditionally it would
    // render "undefined" — pin its absence.
    expect(out).not.toContain("tokens")
    expect(out).not.toContain("undefined")
  })

  test("with NO goal → usage hint, no crash, exit 0", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    // No goal ever set for this thread.
    const code = await goalCmd.run([], ctxWired(port, buf))
    expect(code).toBe(0)
    const out = text(buf)
    expect(out).toContain("No goal set")
    expect(out).toContain("/goal <objective>")
    // Did not fabricate a "Pursuing goal" line.
    expect(out).not.toContain("Pursuing goal:")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLEAR path
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal clear|stop — clear path", () => {
  test("'clear' on an active goal → status becomes paused (readback)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["some", "goal"], ctxWired(port, []))
    expect(port.get(TID)?.status).toBe("active") // precondition

    const buf: string[] = []
    const code = await goalCmd.run(["clear"], ctxWired(port, buf))

    expect(code).toBe(0)
    // Fresh readback: the explicit status flipped to paused.
    expect(port.get(TID)?.status).toBe("paused")
    // The goal text itself is NOT wiped — only paused.
    expect(port.get(TID)?.goal).toBe("some goal")
    expect(text(buf).toLowerCase()).toContain("paused")
  })

  test("'stop' is an alias for clear → status paused (readback)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["another", "goal"], ctxWired(port, []))

    const buf: string[] = []
    const code = await goalCmd.run(["stop"], ctxWired(port, buf))

    expect(code).toBe(0)
    expect(port.get(TID)?.status).toBe("paused")
    expect(text(buf).toLowerCase()).toContain("paused")
  })

  test("'clear' with NO active goal → graceful 'no active objective', exit 0", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const code = await goalCmd.run(["clear"], ctxWired(port, buf))
    expect(code).toBe(0)
    // Readback confirms nothing was created as a side effect.
    expect(port.get(TID)).toBeNull()
    const out = text(buf).toLowerCase()
    expect(out).toContain("no active objective")
    // Must NOT claim it paused something.
    expect(out).not.toContain("stop auto-pursuing")
  })

  test("a paused goal can be re-activated by setting it again (readback)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["goal", "one"], ctxWired(port, []))
    await goalCmd.run(["clear"], ctxWired(port, []))
    expect(port.get(TID)?.status).toBe("paused") // precondition

    const buf: string[] = []
    const code = await goalCmd.run(["goal", "two"], ctxWired(port, buf))
    expect(code).toBe(0)
    // Re-set flips it back to active AND replaces the text.
    expect(port.get(TID)?.status).toBe("active")
    expect(port.get(TID)?.goal).toBe("goal two")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. NOT-WIRED degrade (default-OFF proof)
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — not wired (no goal slot)", () => {
  test("bare ctx → 'not wired', exit 0, NO throw", async () => {
    const buf: string[] = []
    let code: number | undefined
    // The whole point: no throw. If run() threw, this await rejects and the
    // test fails loudly (red-on-injection for the undefined-guard).
    code = await goalCmd.run(["ship", "something"], ctxBare(buf))
    expect(code).toBe(0)
    expect(text(buf)).toContain("not wired")
  })

  test("not-wired posture is identical regardless of args (set/show/clear)", async () => {
    for (const args of [[], ["clear"], ["stop"], ["a", "goal"]]) {
      const buf: string[] = []
      const code = await goalCmd.run(args, ctxBare(buf))
      expect(code).toBe(0)
      expect(text(buf)).toContain("not wired")
    }
  })

  test("not-wired hint names the enabling env gates", async () => {
    const buf: string[] = []
    await goalCmd.run([], ctxBare(buf))
    const out = text(buf)
    expect(out).toContain("QUANTA_OBJECTIVE_TOOLS")
    expect(out).toContain("QUANTA_GOAL_ENFORCE")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. MAX-CHARS guard (boundary)
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — max-chars boundary", () => {
  test("exactly AT the limit → accepted (exit 0, stored)", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const atLimit = "x".repeat(MAX_GOAL_CHARS)
    expect(atLimit.length).toBe(MAX_GOAL_CHARS) // sanity on the fixture itself

    const code = await goalCmd.run([atLimit], ctxWired(port, buf))
    // Red-on-injection: an off-by-one to `>=` flips this to exit 1.
    expect(code).toBe(0)
    expect(port.get(TID)?.goal).toBe(atLimit)
    expect(text(buf)).not.toContain("too long")
  })

  test("one char OVER the limit → rejected (exit 1, NOT stored)", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const over = "x".repeat(MAX_GOAL_CHARS + 1)

    const code = await goalCmd.run([over], ctxWired(port, buf))
    expect(code).toBe(1)
    expect(text(buf)).toContain("too long")
    // Fresh readback: the over-limit goal was NOT recorded.
    expect(port.get(TID)).toBeNull()
  })

  test("the too-long message reports the actual length and the cap", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const over = "y".repeat(MAX_GOAL_CHARS + 5)
    await goalCmd.run([over], ctxWired(port, buf))
    const out = text(buf)
    expect(out).toContain(String(MAX_GOAL_CHARS + 5))
    expect(out).toContain(String(MAX_GOAL_CHARS))
  })

  test("well under the limit → accepted (exit 0)", async () => {
    const port = createObjectiveStore()
    const buf: string[] = []
    const code = await goalCmd.run(["short"], ctxWired(port, buf))
    expect(code).toBe(0)
    expect(port.get(TID)?.goal).toBe("short")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. RETURN CODES — exact numeric exit per branch
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — exact return codes", () => {
  test("set → 0, show → 0, clear → 0, not-wired → 0, too-long → 1", async () => {
    // set
    {
      const port = createObjectiveStore()
      expect(await goalCmd.run(["g"], ctxWired(port, []))).toBe(0)
      // show (goal exists)
      expect(await goalCmd.run([], ctxWired(port, []))).toBe(0)
      // clear
      expect(await goalCmd.run(["clear"], ctxWired(port, []))).toBe(0)
    }
    // show (no goal)
    expect(await goalCmd.run([], ctxWired(createObjectiveStore(), []))).toBe(0)
    // clear (no goal)
    expect(await goalCmd.run(["clear"], ctxWired(createObjectiveStore(), []))).toBe(0)
    // not-wired
    expect(await goalCmd.run(["g"], ctxBare([]))).toBe(0)
    // too-long
    expect(
      await goalCmd.run(["z".repeat(MAX_GOAL_CHARS + 1)], ctxWired(createObjectiveStore(), [])),
    ).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. IDEMPOTENT / REPLACE
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — set replaces prior goal", () => {
  test("a second set replaces the first (readback the new goal)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["first", "objective"], ctxWired(port, []))
    expect(port.get(TID)?.goal).toBe("first objective") // precondition

    const buf: string[] = []
    const code = await goalCmd.run(["second", "objective"], ctxWired(port, buf))
    expect(code).toBe(0)
    // Replaced, not appended or ignored.
    expect(port.get(TID)?.goal).toBe("second objective")
    expect(port.get(TID)?.status).toBe("active")
    // list() has exactly one objective for this thread — not two.
    expect(port.list().filter((o) => o.threadId === TID)).toHaveLength(1)
  })

  test("re-setting the SAME text is idempotent (still one objective, active)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["same"], ctxWired(port, []))
    await goalCmd.run(["same"], ctxWired(port, []))
    expect(port.get(TID)?.goal).toBe("same")
    expect(port.get(TID)?.status).toBe("active")
    expect(port.list().filter((o) => o.threadId === TID)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. UNICODE / SPECIAL CHARS preserved verbatim
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — unicode & special chars preserved", () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ["emoji", "ship 🚀 the rocket"],
    ["cjk", "목표를 달성하다"],
    ["symbols", "fix bug #42 in a<b && c>d"],
    ["quotes", `handle "quoted" and 'apostrophe' text`],
    ["mixed", "café — naïve façade ∑∆ 日本語 🎯"],
  ]

  for (const [label, goal] of CASES) {
    test(`preserves ${label} verbatim in the store`, async () => {
      const port = createObjectiveStore()
      const buf: string[] = []
      const code = await goalCmd.run([goal], ctxWired(port, buf))
      expect(code).toBe(0)
      // Exact byte-for-byte (well, code-point) preservation on readback.
      expect(port.get(TID)?.goal).toBe(goal)
      // And it survives the show render too.
      const showBuf: string[] = []
      await goalCmd.run([], ctxWired(port, showBuf))
      expect(text(showBuf)).toContain(goal)
    })
  }

  test("multi-word unicode goal joins with spaces, not mangled", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["실행", "🚀", "완료"], ctxWired(port, []))
    expect(port.get(TID)?.goal).toBe("실행 🚀 완료")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. PAIRED CONTROL — slot presence is the ONLY discriminator
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — paired control (wired vs not-wired on identical args)", () => {
  test("SAME args: with slot → set+active+'Pursuing goal set'; without slot → 'not wired'", async () => {
    const args = ["deliver", "the", "milestone"]

    // Treatment: wired.
    const port = createObjectiveStore()
    const wiredBuf: string[] = []
    const wiredCode = await goalCmd.run(args, ctxWired(port, wiredBuf))

    // Control: byte-identical ctx MINUS the goal slot.
    const bareBuf: string[] = []
    const bareCode = await goalCmd.run(args, ctxBare(bareBuf))

    // Both exit 0 (default-OFF byte-identical exit posture).
    expect(wiredCode).toBe(0)
    expect(bareCode).toBe(0)

    // The ONLY behavioral difference: the wired path mutated the store and
    // confirmed a set; the bare path touched nothing and declined.
    expect(port.get(TID)?.goal).toBe("deliver the milestone")
    expect(port.get(TID)?.status).toBe("active")
    expect(text(wiredBuf)).toContain("Pursuing goal set")
    expect(text(wiredBuf)).not.toContain("not wired")

    expect(text(bareBuf)).toContain("not wired")
    expect(text(bareBuf)).not.toContain("Pursuing goal set")
  })

  test("clear: with slot → pauses; without slot → not wired (no store to touch)", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["x"], ctxWired(port, []))

    const wiredBuf: string[] = []
    await goalCmd.run(["clear"], ctxWired(port, wiredBuf))
    expect(port.get(TID)?.status).toBe("paused")
    expect(text(wiredBuf).toLowerCase()).toContain("paused")

    const bareBuf: string[] = []
    await goalCmd.run(["clear"], ctxBare(bareBuf))
    expect(text(bareBuf)).toContain("not wired")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. THREAD ISOLATION — the command writes only the ctx.threadId
// ─────────────────────────────────────────────────────────────────────────────
describe("/goal — thread isolation", () => {
  test("two threads on the SAME store keep independent goals", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["goal", "for", "A"], ctxWired(port, [], "thread-A"))
    await goalCmd.run(["goal", "for", "B"], ctxWired(port, [], "thread-B"))

    expect(port.get("thread-A")?.goal).toBe("goal for A")
    expect(port.get("thread-B")?.goal).toBe("goal for B")

    // Clearing A does not touch B.
    await goalCmd.run(["clear"], ctxWired(port, [], "thread-A"))
    expect(port.get("thread-A")?.status).toBe("paused")
    expect(port.get("thread-B")?.status).toBe("active")
  })

  test("show on thread-B reads B's goal, not A's", async () => {
    const port = createObjectiveStore()
    await goalCmd.run(["alpha"], ctxWired(port, [], "thread-A"))
    await goalCmd.run(["beta"], ctxWired(port, [], "thread-B"))

    const buf: string[] = []
    await goalCmd.run([], ctxWired(port, buf, "thread-B"))
    const out = text(buf)
    expect(out).toContain("Pursuing goal: beta")
    expect(out).not.toContain("alpha")
  })
})
