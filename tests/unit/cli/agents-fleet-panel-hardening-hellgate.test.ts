/**
 * HELLGATE hardening battery for `agents-fleet-panel` (the `/agents` PURE
 * renderer). Each case below is derived from an adversarial audit of
 * `src/apps/cli/agents-fleet-panel.ts` and is written to go RED if a specific
 * mutation is injected into production (collapse cap, countFleet domain,
 * id-truncation, group-ordering, surrogate-safe slicing, empty-fleet path).
 *
 * Conventions copied from `agents-fleet-panel.test.ts`:
 *   - colours pinned OFF for deterministic golden assertions
 *   - `row()` helper builds an `AgentFleetRow` with sane defaults
 *   - `opts.now` injected (renderer is clock-free / deterministic)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AgentFleetRow, renderAgentFleet } from "../../../src/apps/cli/agents-fleet-panel"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

beforeEach(() => setColorPolicy("off"))
afterEach(() => setColorPolicy(null))

const NOW = 1_000_000

const row = (over: Partial<AgentFleetRow> = {}): AgentFleetRow => ({
  id: "task_aaaaaaaa-0000-0000-0000-000000000001",
  description: "investigate flaky test",
  agentType: "explorer",
  status: "running",
  startedAt: NOW - 12_000, // 12s ago
  ...over,
})

/** Build N settled (completed) rows with distinct, greppable ids and a
 *  monotonically-increasing `endedAt` so ordering is deterministic. */
const settledRows = (n: number): AgentFleetRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({
      id: `done${String(i).padStart(2, "0")}`,
      status: "completed",
      endedAt: NOW - (n - i) * 1_000, // i=last → most recent
      result: { ok: true, finalText: `result ${i}`, turns: 1 },
    }),
  )

const tableOpts = { format: "table" as const, now: NOW }

describe("collapse teeth — settled rows capped at 8 without --all", () => {
  // INVARIANT: with no --all, exactly DEFAULT_SETTLED_SHOWN(=8) settled rows
  // render, running rows are NEVER collapsed, and a "… N more settled (use
  // --all)" note discloses the hidden count.
  // MUTATION-KILL: dropping the collapse (showing all 12) → "more settled"
  // note disappears AND a 9th+ settled id appears → RED.
  test("12 settled + 2 running, default opts: 8 settled shown, both running, note present", () => {
    const rows = [
      ...settledRows(12),
      row({ id: "runA", status: "running" }),
      row({ id: "runB", status: "running" }),
    ]
    const out = stripAnsi(renderAgentFleet(rows, tableOpts))

    // Both running rows are always present (running is never collapsed).
    expect(out).toContain("runA")
    expect(out).toContain("runB")

    // Exactly 8 of the 12 settled ids render. settledRows order by endedAt desc
    // → the 8 most-recent (done11..done04) are shown; done00..done03 hidden.
    const shownSettled = settledRows(12)
      .map((r) => r.id)
      .filter((id) => out.includes(id))
    expect(shownSettled.length).toBe(8)

    // The 4 oldest must NOT appear; the 8 newest must.
    for (const id of ["done00", "done01", "done02", "done03"]) {
      expect(out).not.toContain(id)
    }
    for (const id of ["done04", "done05", "done11"]) {
      expect(out).toContain(id)
    }

    // Disclosure note with the EXACT hidden count (12 - 8 = 4).
    expect(out).toContain("… 4 more settled (use --all)")
  })
})

describe("--all defeats collapse", () => {
  // INVARIANT: opts.all === true bypasses collapseSettled entirely — all 12
  // settled render and NO disclosure note appears.
  test("12 settled with {all:true}: all present, no 'more settled' note", () => {
    const rows = settledRows(12)
    const out = stripAnsi(renderAgentFleet(rows, { ...tableOpts, all: true }))

    for (let i = 0; i < 12; i++) {
      expect(out).toContain(`done${String(i).padStart(2, "0")}`)
    }
    expect(out).not.toContain("more settled")
    expect(out).not.toContain("use --all")
  })
})

describe("footer counts span the FULL fleet, not the shown subset", () => {
  // INVARIANT: countFleet runs over the ORIGINAL `rows`, not the collapsed
  // `shown` subset. So even though only 8 settled render, the footer reports
  // all 10 done + 0 failed + 1 running.
  // MUTATION-KILL: countFleet(shown) instead of countFleet(rows) → footer would
  // read "1 running · 8 done · 0 failed" → RED.
  test("10 completed + 1 failed + 1 running, no --all: footer over full fleet", () => {
    const rows = [
      ...settledRows(10), // 10 completed → done
      row({ id: "fail0", status: "failed", endedAt: NOW - 500, error: "boom" }),
      row({ id: "run0", status: "running" }),
    ]
    const out = stripAnsi(renderAgentFleet(rows, tableOpts))

    // Only 8 settled visible (10 completed + 1 failed = 11 settled > 8 cap),
    // proving collapse is active...
    const visibleDone = settledRows(10)
      .map((r) => r.id)
      .filter((id) => out.includes(id)).length
    expect(visibleDone).toBeLessThan(10)

    // ...yet the footer counts the FULL fleet: 1 running, 10 done, 0 failed.
    // (failed=fail0 → 1 failed; 10 completed → done. Footer is whole-fleet.)
    expect(out).toContain("1 running · 10 done · 1 failed")
  })
})

describe("stopped counts as done, not failed", () => {
  // INVARIANT: countFleet treats "stopped" in the `done` bucket alongside
  // "completed"; only true "failed" rows increment `failed`.
  // MUTATION-KILL: routing stopped → failed → footer "0 done · 2 failed" → RED.
  test("one stopped + one failed: stopped in done, excluded from failed", () => {
    const rows = [
      row({ id: "stop0", status: "stopped", endedAt: NOW - 1 }),
      row({ id: "fail0", status: "failed", endedAt: NOW - 1, error: "x" }),
    ]
    const out = stripAnsi(renderAgentFleet(rows, tableOpts))
    // stopped → done(1), failed → failed(1), no running.
    expect(out).toContain("0 running · 1 done · 1 failed")
  })
})

describe("long-id truncation", () => {
  // INVARIANT: shortId drops the `task_` prefix and keeps a 12-char head; a
  // 45-char raw id never leaks its tail into the table.
  // MUTATION-KILL: emitting the full id (no slice) → the 40-z run appears → RED.
  test("task_zzz...(40 z): 12-char head shown, full 40-z string absent", () => {
    const longId = `task_${"z".repeat(40)}`
    const out = stripAnsi(renderAgentFleet([row({ id: longId, status: "running" })], tableOpts))
    // task_ stripped, then 12 chars → "zzzzzzzzzzzz" (12 z's).
    expect(out).toContain("z".repeat(12))
    // The full 40-z run must never appear (would mean no truncation).
    expect(out).not.toContain("z".repeat(40))
    // And the 13-char run must be absent too (proves the cut is at 12, not more).
    expect(out).not.toContain("z".repeat(13))
  })
})

describe("running-row ordering + determinism + no input mutation", () => {
  // INVARIANT: running rows render in input order (stable); the renderer is a
  // pure function of (rows, opts) and never mutates the caller's array.
  test("3 running rows render in input order", () => {
    const rows = [
      row({ id: "r1", status: "running" }),
      row({ id: "r2", status: "running" }),
      row({ id: "r3", status: "running" }),
    ]
    const out = stripAnsi(renderAgentFleet(rows, tableOpts))
    const i1 = out.indexOf("r1")
    const i2 = out.indexOf("r2")
    const i3 = out.indexOf("r3")
    expect(i1).toBeGreaterThanOrEqual(0)
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })

  test("100 running rows: deterministic output + input array unmutated", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ id: `r${String(i).padStart(3, "0")}`, status: "running" }),
    )
    // Deep snapshot of input BEFORE rendering.
    const before = JSON.parse(JSON.stringify(rows))

    const out1 = renderAgentFleet(rows, tableOpts)
    const out2 = renderAgentFleet(rows, tableOpts)

    // Determinism: identical (rows, opts) → byte-identical output.
    expect(out1).toBe(out2)

    // No input mutation: the comparator copies before sorting.
    expect(rows).toEqual(before)
  })
})

// NOTE: `--tree` agentType-GROUPING was replaced in Wave 2 (feat: Sub-Agents
// panel) by the real parent→child SPAWN tree. The former "tree group ordering —
// byte sort, untyped last" invariant no longer exists; spawn-tree ordering /
// nesting is covered by the colocated `src/apps/cli/agents-fleet-tree.test.ts`.

describe("surrogate-safe unicode truncation", () => {
  // INVARIANT: finalText truncation uses code-point-aware slicing
  // (sliceWholeChars), so a string of astral emoji never gets cut mid-surrogate
  // and never emits a U+FFFD replacement char.
  // MUTATION-KILL: a naive `.slice(0, 50)` on UTF-16 units would split a
  // surrogate pair → a lone surrogate → FFFD artifact → RED.
  test("60x 🚀 finalText: truncated, no U+FFFD lone-surrogate artifact", () => {
    const rocket = "\u{1F680}" // 🚀, an astral (surrogate-pair) code point
    const finalText = rocket.repeat(60) // 60 code points, 120 UTF-16 units
    const out = stripAnsi(
      renderAgentFleet(
        [
          row({
            id: "emoji0",
            status: "completed",
            endedAt: NOW - 1,
            result: { ok: true, finalText, turns: 2 },
          }),
        ],
        tableOpts,
      ),
    )
    // Truncated: the full 60-rocket run must not appear.
    expect(out).not.toContain(rocket.repeat(60))
    // An ellipsis indicates truncation happened.
    expect(out).toContain("…")
    // No lone-surrogate replacement char anywhere in the output.
    expect([...out].every((c) => c.codePointAt(0) !== 0xfffd)).toBe(true)
  })

  test("emoji agentType does not throw", () => {
    expect(() =>
      renderAgentFleet([row({ id: "e", agentType: "🚀explorer", status: "running" })], tableOpts),
    ).not.toThrow()
    // tree path groups by agentType — also must not throw on astral type names.
    expect(() =>
      renderAgentFleet([row({ id: "e", agentType: "🚀explorer", status: "running" })], {
        format: "tree",
        now: NOW,
      }),
    ).not.toThrow()
  })
})

describe("empty fleet — json vs panel", () => {
  // INVARIANT: empty json is machine-clean "[]" (json path runs BEFORE the
  // empty-panel short-circuit); empty table/tree falls to the "(no agents)" box.
  test("json([]) is exactly '[]'", () => {
    const out = renderAgentFleet([], { format: "json", now: NOW })
    expect(out).toBe("[]")
  })

  test("table([]) and tree([]) render the (no agents) box", () => {
    const tableOut = stripAnsi(renderAgentFleet([], tableOpts))
    const treeOut = stripAnsi(renderAgentFleet([], { format: "tree", now: NOW }))
    expect(tableOut).toContain("(no agents)")
    expect(treeOut).toContain("(no agents)")
    // Not the json sentinel.
    expect(tableOut).not.toBe("[]")
  })
})
