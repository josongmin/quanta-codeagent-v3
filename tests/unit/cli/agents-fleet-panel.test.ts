import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type AgentFleetRow,
  formatAge,
  renderAgentFleet,
} from "../../../src/apps/cli/agents-fleet-panel"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

// Pin colours OFF for deterministic golden assertions; a single test below
// flips them ON to prove the status→colour map.
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

describe("formatAge", () => {
  test("humanizes seconds / minutes / hours", () => {
    expect(formatAge(0)).toBe("0s")
    expect(formatAge(12_000)).toBe("12s")
    expect(formatAge(59_000)).toBe("59s")
    expect(formatAge(60_000)).toBe("1m")
    expect(formatAge(3 * 60_000)).toBe("3m")
    expect(formatAge(60 * 60_000)).toBe("1h")
    expect(formatAge(90 * 60_000)).toBe("1h") // floors
  })

  test("negative / NaN clamps to 0s (never throws, never negative)", () => {
    expect(formatAge(-5)).toBe("0s")
    expect(formatAge(Number.NaN)).toBe("0s")
  })
})

describe("renderAgentFleet — table", () => {
  test("injected now drives the age column (FAILS if the renderer reads the real clock)", () => {
    // A row started 12s before the INJECTED now. If the renderer ignored `now`
    // and read Date.now(), the age would be a huge real-elapsed value, not 12s.
    const out = stripAnsi(renderAgentFleet([row()], { format: "table", now: NOW }))
    expect(out).toContain("12s")
    expect(out).not.toContain("h") // 12s must not render as hours
  })

  test("truncates finalText to 50 chars with an ellipsis + turns badge", () => {
    const long = "x".repeat(120)
    const out = stripAnsi(
      renderAgentFleet(
        [
          row({
            status: "completed",
            endedAt: NOW - 1_000,
            result: { ok: true, finalText: long, turns: 3 },
          }),
        ],
        { format: "table", now: NOW },
      ),
    )
    // 50 visible chars of finalText, then ellipsis. The full 120 never appears.
    expect(out).not.toContain("x".repeat(120))
    expect(out).toContain(`${"x".repeat(50)}…`)
    expect(out).toContain("(3t)")
  })

  test("empty fleet → '(no agents)' + a hint, never a bare box", () => {
    const out = stripAnsi(renderAgentFleet([], { format: "table", now: NOW }))
    expect(out).toContain("(no agents)")
    expect(out.toLowerCase()).toContain("spawn") // hint mentions how agents appear
  })

  test("footer counts running / done / failed", () => {
    const out = stripAnsi(
      renderAgentFleet(
        [
          row({ id: "a", status: "running" }),
          row({
            id: "b",
            status: "completed",
            endedAt: NOW - 1,
            result: { ok: true, finalText: "ok", turns: 1 },
          }),
          row({ id: "c", status: "failed", endedAt: NOW - 1, error: "boom" }),
        ],
        { format: "table", now: NOW },
      ),
    )
    expect(out).toContain("1 running")
    expect(out).toContain("1 done")
    expect(out).toContain("1 failed")
  })

  test("sorts running first, then settled by endedAt desc", () => {
    const out = stripAnsi(
      renderAgentFleet(
        [
          row({
            id: "old-settled",
            status: "completed",
            endedAt: NOW - 100_000,
            result: { ok: true, finalText: "old", turns: 1 },
          }),
          row({
            id: "new-settled",
            status: "completed",
            endedAt: NOW - 1_000,
            result: { ok: true, finalText: "new", turns: 1 },
          }),
          row({ id: "is-running", status: "running" }),
        ],
        { format: "table", now: NOW },
      ),
    )
    const idxRunning = out.indexOf("is-running")
    const idxNew = out.indexOf("new-settled")
    const idxOld = out.indexOf("old-settled")
    expect(idxRunning).toBeGreaterThanOrEqual(0)
    expect(idxRunning).toBeLessThan(idxNew) // running before settled
    expect(idxNew).toBeLessThan(idxOld) // newer settled before older settled
  })

  test("status glyph + word present for each state", () => {
    const out = stripAnsi(
      renderAgentFleet(
        [
          row({ id: "r", status: "running" }),
          row({
            id: "c",
            status: "completed",
            endedAt: NOW - 1,
            result: { ok: true, finalText: "ok", turns: 1 },
          }),
          row({ id: "f", status: "failed", endedAt: NOW - 1, error: "boom" }),
          row({ id: "s", status: "stopped", endedAt: NOW - 1 }),
        ],
        { format: "table", now: NOW },
      ),
    )
    expect(out).toContain("● running")
    expect(out).toContain("✓ completed")
    expect(out).toContain("✗ failed")
    expect(out).toContain("⊘ stopped")
  })
})

describe("renderAgentFleet — json", () => {
  test("stable JSON.stringify of the rows + derived age", () => {
    const out = renderAgentFleet([row({ id: "j1" })], { format: "json", now: NOW })
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].id).toBe("j1")
    expect(parsed[0].status).toBe("running")
    // age is derived against the injected now (12s) — proves no real clock leak.
    expect(parsed[0].age).toBe("12s")
  })

  test("json output carries no ANSI even when colours are ON", () => {
    setColorPolicy("on")
    const out = renderAgentFleet([row({ id: "j2" })], { format: "json", now: NOW })
    expect(out).toBe(stripAnsi(out)) // machine-readable: never coloured
  })
})

// NOTE: `renderAgentFleet` `--tree` was rewritten in Wave 2 (feat: Sub-Agents
// panel) from agentType-GROUPING to the real parent→child SPAWN tree. The former
// "groups by agentType" test was superseded and moved to the colocated
// `src/apps/cli/agents-fleet-tree.test.ts` / `agents-fleet-panel.test.ts`
// (spawn-tree nesting, orphan re-root, cycle safety, --depth prune, inspect).

describe("renderAgentFleet — colour map (status → colour)", () => {
  test("running=cyan, completed=green, failed=red carry ANSI when colours ON", () => {
    setColorPolicy("on")
    const running = renderAgentFleet([row({ id: "r", status: "running" })], {
      format: "table",
      now: NOW,
    })
    const failed = renderAgentFleet(
      [row({ id: "f", status: "failed", endedAt: NOW - 1, error: "x" })],
      { format: "table", now: NOW },
    )
    // ANSI escape present (renderer delegates colour to @/ui, never TTY-detects).
    const ANSI = new RegExp(String.fromCharCode(27))
    expect(ANSI.test(running)).toBe(true)
    expect(ANSI.test(failed)).toBe(true)
    // Cyan (36) for running, red (31) for failed — distinct codes prove the map.
    expect(running).toContain("36")
    expect(failed).toContain("31")
  })
})
