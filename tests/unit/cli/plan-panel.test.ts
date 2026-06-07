/**
 * Tests for `src/apps/cli/plan-panel.ts` (R10 plan-mode TUI).
 *
 * Coverage:
 *   1. `renderPlanPanel(null)` ⇒ "no active plan" placeholder, no throw.
 *   2. Empty plan (zero todos) ⇒ "(no steps)" placeholder + header.
 *   3. Partial plan ⇒ progress header `(N of M done)` + glyphs in expected
 *      positions + current pointer suffix.
 *   4. All-done plan ⇒ no `(current)` pointer rendered.
 *   5. Color OFF (setColorPolicy("off")) ⇒ stripAnsi(rendered) === rendered.
 *   6. Large plan (>maxRows) ⇒ truncates with "… N more" gap markers,
 *      header still shows FULL totals.
 *   7. Orphan todos (no phase) ⇒ appended in createdAt-ascending order.
 *   8. `/plan` slash command — not wired ⇒ prints the documented sentinel
 *      and exits 0 (default-OFF parity).
 *   9. `/plan` slash command — wired with snapshot ⇒ renders panel + exits 0.
 *  10. `/plan show` is accepted as an alias for the default view.
 *  11. `/plan <bogus>` rejects with exit 1 + error message.
 *  12. `/plan` — snapshot callback throws ⇒ exits 1 + error message (no
 *      uncaught throw bubbling to the REPL).
 */

import { describe, expect, test } from "bun:test"
import type { Plan, TodoItem, TodoStatus } from "../../../src/agent/plan/types"
import {
  PLAN_PANEL_NO_PLAN,
  PLAN_PANEL_NOT_WIRED,
  renderPlanHeader,
  renderPlanPanel,
} from "../../../src/apps/cli/plan-panel"
import { runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

const makeTodo = (id: string, content: string, status: TodoStatus, createdAt = 0): TodoItem => ({
  id,
  content,
  status,
  createdAt,
  updatedAt: createdAt,
  dependencies: [],
})

const makePlan = (todos: TodoItem[], opts: Partial<Plan> = {}): Plan => {
  const todoMap: Record<string, TodoItem> = {}
  for (const t of todos) todoMap[t.id] = t
  return {
    version: 0,
    name: opts.name ?? "Refactor pass",
    overview: opts.overview ?? "",
    isProject: false,
    todos: todoMap,
    phases: opts.phases ?? [
      {
        id: "ph-1",
        name: "default",
        todoIds: todos.map((t) => t.id),
        order: 0,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  }
}

const buildCtx = (): { ctx: SlashContext; out: () => string; err: () => string } => {
  let outBuf = ""
  let errBuf = ""
  return {
    ctx: {
      out: (s) => {
        outBuf += s
      },
      err: (s) => {
        errBuf += s
      },
      cwd: "/tmp",
    },
    out: () => outBuf,
    err: () => errBuf,
  }
}

describe("renderPlanPanel — null / empty edge cases", () => {
  test("null plan → 'no active plan' placeholder, no throw", () => {
    // Force OFF so the test isn't TTY-dependent.
    setColorPolicy("off")
    const out = renderPlanPanel(null)
    expect(out).toContain(PLAN_PANEL_NO_PLAN)
    expect(out.startsWith("╭")).toBe(true) // box-drawing top corner
    setColorPolicy(null)
  })

  test("empty plan (zero todos) → '(no steps)' placeholder + header", () => {
    setColorPolicy("off")
    const plan = makePlan([], { phases: [] })
    const out = renderPlanPanel(plan)
    expect(out).toContain("(no steps)")
    expect(out).toContain("(empty)") // header indicates emptiness
    setColorPolicy(null)
  })
})

describe("renderPlanPanel — partial plan", () => {
  test("renders progress header '(N of M done)' + glyphs + current pointer", () => {
    setColorPolicy("off")
    const plan = makePlan([
      makeTodo("a", "analyze codebase structure", "completed"),
      makeTodo("b", "identify hot paths", "completed"),
      makeTodo("c", "profile current performance", "completed"),
      makeTodo("d", "refactor parseConfig", "in_progress"),
      makeTodo("e", "add caching layer", "pending"),
      makeTodo("f", "update tests", "pending"),
      makeTodo("g", "update docs", "pending"),
    ])
    const out = renderPlanPanel(plan)
    const plain = stripAnsi(out)
    expect(plain).toContain("(3 of 7 done)")
    // Completed glyph
    expect(plain).toContain("✓ 1.")
    expect(plain).toContain("✓ 2.")
    expect(plain).toContain("✓ 3.")
    // Current step glyph + suffix
    expect(plain).toContain("▶ 4. refactor parseConfig")
    expect(plain).toContain("(current)")
    // Pending glyph
    expect(plain).toContain("○ 5.")
    expect(plain).toContain("○ 6.")
    expect(plain).toContain("○ 7.")
    // Header carries the plan name
    expect(plain).toContain("Refactor pass")
    setColorPolicy(null)
  })

  test("no in_progress → first pending becomes the current pointer", () => {
    setColorPolicy("off")
    const plan = makePlan([
      makeTodo("a", "step 1", "completed"),
      makeTodo("b", "step 2", "pending"),
      makeTodo("c", "step 3", "pending"),
    ])
    const out = stripAnsi(renderPlanPanel(plan))
    // `b` (the first pending) is marked current — it gets the (current) suffix
    // but keeps its pending glyph (we only pivot the marker, not the status).
    expect(out).toMatch(/○ 2\. step 2\s+\(current\)/)
  })
})

describe("renderPlanPanel — terminal plans", () => {
  test("all-done plan → no '(current)' suffix anywhere", () => {
    setColorPolicy("off")
    const plan = makePlan([
      makeTodo("a", "done one", "completed"),
      makeTodo("b", "done two", "completed"),
    ])
    const out = stripAnsi(renderPlanPanel(plan))
    expect(out).toContain("(2 of 2 done)")
    expect(out).not.toContain("(current)")
    setColorPolicy(null)
  })

  test("cancelled todos count against TOTAL but not DONE", () => {
    setColorPolicy("off")
    const plan = makePlan([
      makeTodo("a", "ok", "completed"),
      makeTodo("b", "skipped", "cancelled"),
      makeTodo("c", "wip", "in_progress"),
    ])
    const out = stripAnsi(renderPlanPanel(plan))
    // 1 completed, 3 total — cancelled is NOT counted as done.
    expect(out).toContain("(1 of 3 done)")
    setColorPolicy(null)
  })
})

describe("renderPlanPanel — color policy", () => {
  test("setColorPolicy('off') → stripAnsi(rendered) === rendered (no escapes)", () => {
    setColorPolicy("off")
    const plan = makePlan([
      makeTodo("a", "done", "completed"),
      makeTodo("b", "wip", "in_progress"),
      makeTodo("c", "pending", "pending"),
    ])
    const out = renderPlanPanel(plan)
    expect(stripAnsi(out)).toBe(out)
    setColorPolicy(null)
  })

  test("setColorPolicy('on') → output contains ANSI escapes", () => {
    setColorPolicy("on")
    const plan = makePlan([makeTodo("a", "wip", "in_progress")])
    const out = renderPlanPanel(plan)
    // ESC = \x1b — the wrap helpers prefix every colored span with it.
    expect(out).toContain("\x1b[")
    setColorPolicy(null)
  })
})

describe("renderPlanPanel — truncation for large plans", () => {
  test("plan with 30 todos and maxRows=10 → truncates with '… N more' gap", () => {
    setColorPolicy("off")
    const todos: TodoItem[] = []
    for (let i = 0; i < 30; i++) {
      // First 8 completed, then 1 in_progress, then 21 pending.
      const status: TodoStatus = i < 8 ? "completed" : i === 8 ? "in_progress" : "pending"
      todos.push(makeTodo(`t${i.toString().padStart(2, "0")}`, `step ${i + 1}`, status, i))
    }
    const out = stripAnsi(renderPlanPanel(makePlan(todos), { maxRows: 10 }))
    // Header still shows FULL totals.
    expect(out).toContain("(8 of 30 done)")
    // Gap markers present.
    expect(out).toMatch(/… \d+ more/)
    setColorPolicy(null)
  })

  test("plan within maxRows budget → no gap markers", () => {
    setColorPolicy("off")
    const todos: TodoItem[] = []
    for (let i = 0; i < 5; i++) {
      todos.push(makeTodo(`t${i}`, `step ${i + 1}`, "pending", i))
    }
    const out = stripAnsi(renderPlanPanel(makePlan(todos), { maxRows: 20 }))
    expect(out).not.toMatch(/… \d+ more/)
    setColorPolicy(null)
  })
})

describe("renderPlanPanel — orphan ordering", () => {
  test("todos NOT in any phase append in createdAt-ascending order", () => {
    setColorPolicy("off")
    const inPhase = makeTodo("a", "phased", "pending", 0)
    const orphanLate = makeTodo("b", "orphan late", "pending", 100)
    const orphanEarly = makeTodo("c", "orphan early", "pending", 50)
    // Phase only references `a` — `b` and `c` are orphans.
    const plan: Plan = {
      ...makePlan([inPhase, orphanLate, orphanEarly]),
      phases: [{ id: "ph", name: "p1", todoIds: ["a"], order: 0 }],
    }
    const out = stripAnsi(renderPlanPanel(plan))
    const lines = out.split("\n").filter((l) => /\d+\./.test(l))
    // Order: phased(a, 1) → orphan-early(c, 2) → orphan-late(b, 3).
    expect(lines[0]).toContain("phased")
    expect(lines[1]).toContain("orphan early")
    expect(lines[2]).toContain("orphan late")
    setColorPolicy(null)
  })
})

describe("renderPlanHeader — exposed for status-bar wiring", () => {
  test("returns 'name (D of T done)' for non-empty plans", () => {
    const plan = makePlan([makeTodo("a", "x", "completed"), makeTodo("b", "y", "pending")])
    expect(renderPlanHeader(plan)).toBe("Refactor pass (1 of 2 done)")
  })

  test("returns 'name (empty)' for zero-todo plans", () => {
    const plan = makePlan([], { phases: [] })
    expect(renderPlanHeader(plan)).toBe("Refactor pass (empty)")
  })
})

describe("/plan slash command — wiring", () => {
  test("planSnapshot undefined → prints not-wired sentinel and exits 0", async () => {
    setColorPolicy("off")
    const { ctx, out, err } = buildCtx()
    const code = await runSlashCommand("/plan", ctx)
    expect(code).toBe(0)
    expect(out()).toContain(PLAN_PANEL_NOT_WIRED)
    expect(err()).toBe("")
    setColorPolicy(null)
  })

  test("planSnapshot wired returning null → renders 'no active plan' placeholder", async () => {
    setColorPolicy("off")
    const { ctx, out } = buildCtx()
    const code = await runSlashCommand("/plan", {
      ...ctx,
      planSnapshot: () => null,
    })
    expect(code).toBe(0)
    expect(out()).toContain(PLAN_PANEL_NO_PLAN)
    setColorPolicy(null)
  })

  test("planSnapshot wired returning a plan → renders panel + exits 0", async () => {
    setColorPolicy("off")
    const { ctx, out } = buildCtx()
    const plan = makePlan([
      makeTodo("a", "first", "completed"),
      makeTodo("b", "second", "in_progress"),
    ])
    const code = await runSlashCommand("/plan", {
      ...ctx,
      planSnapshot: () => plan,
    })
    expect(code).toBe(0)
    expect(stripAnsi(out())).toContain("(1 of 2 done)")
    expect(stripAnsi(out())).toContain("▶ 2. second")
    setColorPolicy(null)
  })

  test("/plan show is accepted as an alias for the default view", async () => {
    setColorPolicy("off")
    const { ctx, out } = buildCtx()
    const plan = makePlan([makeTodo("a", "only", "pending")])
    const code = await runSlashCommand("/plan show", {
      ...ctx,
      planSnapshot: () => plan,
    })
    expect(code).toBe(0)
    expect(stripAnsi(out())).toContain("(0 of 1 done)")
    setColorPolicy(null)
  })

  test("/plan <bogus> → exits 1 + error line on stderr", async () => {
    const { ctx, err } = buildCtx()
    const code = await runSlashCommand("/plan bogus", {
      ...ctx,
      planSnapshot: () => null,
    })
    expect(code).toBe(1)
    expect(err()).toContain("unknown subcommand: bogus")
  })

  test("snapshot callback throwing → exits 1, caller's REPL survives", async () => {
    const { ctx, err } = buildCtx()
    const code = await runSlashCommand("/plan", {
      ...ctx,
      planSnapshot: () => {
        throw new Error("plan-store crashed")
      },
    })
    expect(code).toBe(1)
    expect(err()).toContain("snapshot failed: plan-store crashed")
  })
})
