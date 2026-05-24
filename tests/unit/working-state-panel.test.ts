/**
 * Unit tests for `src/apps/cli/working-state-panel.ts` (catalog 대5 L4
 * WorkingState surfacing).
 *
 * Coverage axes:
 *   - empty snapshot          → renderer shows "(empty)" pill, transient
 *                                + summary row are "".
 *   - partial snapshot        → only filled fields appear; absent ones
 *                                contribute no rows.
 *   - full snapshot           → every field section is painted; row order
 *                                is stable.
 *   - colour-off              → stripAnsi-equivalent: setting `none` theme
 *                                drops escapes; the panel still renders
 *                                its semantic content.
 *   - long-list truncation    → over-cap lists tagged "… +N more"; over-
 *                                cap single-line `what`/`reason` ellipsised
 *                                to `MAX_LINE_LEN`.
 *   - posture inference       → blockers > next > hypothesis > owners >
 *                                idle, with explicit ordering tests.
 *   - transient cap           → very long transient capped at
 *                                `MAX_TRANSIENT_LEN`.
 *   - slash registration      → BUILTINS includes `/state` + `/working-state`.
 *   - slash command run path  → not-wired branch, success branch, args
 *                                rejection branch.
 *
 * Pure-renderer tests (no I/O). The slash branch uses an in-memory
 * `SlashContext` with stub callbacks — same harness shape as
 * `tests/unit/slash-commands.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import type { WorkingState } from "../../src/agent"
import { BUILTINS, runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import {
  __internal,
  formatWorkingStateSummaryRow,
  formatWorkingStateTransient,
  renderWorkingStatePanel,
} from "../../src/apps/cli/working-state-panel"
import { setColorPolicy, stripAnsi } from "../../src/ui/ui-helpers"

const emptySnap = (): WorkingState => ({
  ownerShortlist: [],
  blockers: [],
  nextStepQueue: [],
  deferredValidation: [],
})

const buildCtx = (
  workingState?: () => WorkingState | undefined,
): { ctx: SlashContext; out: { v: string }; err: { v: string } } => {
  const out = { v: "" }
  const err = { v: "" }
  const ctx: SlashContext = {
    out: (s) => {
      out.v += s
    },
    err: (s) => {
      err.v += s
    },
    cwd: "/tmp",
    ...(workingState !== undefined ? { workingState } : {}),
  }
  return { ctx, out, err }
}

describe("renderWorkingStatePanel", () => {
  test("empty snapshot ⇒ '(working state is empty)' inside the box", () => {
    setColorPolicy("off")
    const out = stripAnsi(renderWorkingStatePanel(emptySnap()))
    expect(out).toContain("Working state")
    expect(out).toContain("(working state is empty)")
    expect(out).not.toContain("Posture")
    expect(out).not.toContain("Blockers")
  })

  test("undefined snapshot ⇒ same empty box as empty snapshot", () => {
    setColorPolicy("off")
    const a = stripAnsi(renderWorkingStatePanel(undefined))
    const b = stripAnsi(renderWorkingStatePanel(emptySnap()))
    expect(a).toBe(b)
  })

  test("partial: only hypothesis ⇒ posture=investigating, no Blockers/Next/Owners rows", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ...emptySnap(),
      hypothesis: "config parsing is the hot path",
    }
    const out = stripAnsi(renderWorkingStatePanel(snap))
    expect(out).toContain("Posture:")
    expect(out).toContain("investigating")
    expect(out).toContain("Hypothesis:")
    expect(out).toContain("config parsing is the hot path")
    expect(out).not.toContain("Blockers:")
    expect(out).not.toContain("Next steps:")
    expect(out).not.toContain("Owners:")
  })

  test("partial: only next steps ⇒ posture=executing, numbered list", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ...emptySnap(),
      nextStepQueue: [
        { what: "profile parseConfig" },
        { what: "write failing test" },
        { what: "measure overhead", deferred: true },
      ],
    }
    const out = stripAnsi(renderWorkingStatePanel(snap))
    expect(out).toContain("executing")
    expect(out).toContain("1. profile parseConfig")
    expect(out).toContain("2. write failing test")
    expect(out).toContain("3. measure overhead (deferred)")
    expect(out).not.toContain("Blockers:")
  })

  test("full snapshot ⇒ every section appears, blocker posture wins", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ownerShortlist: [{ file: "src/auth/login.ts", reason: "@alice (auth team)" }],
      hypothesis: "session id is leaking",
      blockers: [{ what: "need access to staging logs", surface: "runtime" }],
      nextStepQueue: [{ what: "profile parseConfig" }],
      deferredValidation: [{ rail: "pytest", reason: "fixture not ready" }],
    }
    const out = stripAnsi(renderWorkingStatePanel(snap))
    expect(out).toContain("blocked")
    expect(out).toContain("Hypothesis: session id is leaking")
    expect(out).toContain("Next steps:")
    expect(out).toContain("1. profile parseConfig")
    expect(out).toContain("Blockers:")
    expect(out).toContain("[runtime] need access to staging logs")
    expect(out).toContain("Owners:")
    expect(out).toContain("src/auth/login.ts — @alice (auth team)")
    expect(out).toContain("Deferred:")
    expect(out).toContain("pytest: fixture not ready")
  })

  test("colour OFF ⇒ no ANSI escapes leak past stripAnsi (round-trip)", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ...emptySnap(),
      blockers: [{ what: "needs logs", surface: "runtime" }],
      nextStepQueue: [{ what: "step a" }],
    }
    const out = renderWorkingStatePanel(snap)
    // Color policy is OFF ⇒ `wrap` returns the bare string; the rendered
    // output equals its stripped form.
    expect(out).toBe(stripAnsi(out))
  })

  test("long-list truncation ⇒ next-step queue past MAX shows '… +N more'", () => {
    setColorPolicy("off")
    const big: WorkingState = {
      ...emptySnap(),
      nextStepQueue: Array.from({ length: 20 }, (_, i) => ({ what: `step ${i + 1}` })),
    }
    const out = stripAnsi(renderWorkingStatePanel(big))
    // First 12 (MAX_NEXT_STEPS) are visible; 8 remain.
    expect(out).toContain("1. step 1")
    expect(out).toContain("12. step 12")
    expect(out).not.toContain("13. step 13")
    expect(out).toContain("+8 more")
  })

  test("long-list truncation ⇒ a single oversized 'what' is ellipsised at MAX_LINE_LEN", () => {
    setColorPolicy("off")
    const huge = "x".repeat(__internal.MAX_LINE_LEN * 2)
    const snap: WorkingState = {
      ...emptySnap(),
      blockers: [{ what: huge, surface: "runtime" }],
    }
    const out = stripAnsi(renderWorkingStatePanel(snap))
    expect(out).toContain("…")
    // No single rendered row exceeds MAX_LINE_LEN + the row prefix
    // ("[runtime] " etc.) by more than a small margin.
    const longest = Math.max(...out.split("\n").map((l) => l.length))
    expect(longest).toBeLessThan(__internal.MAX_LINE_LEN + 40)
  })

  test("posture precedence: blockers > next > hypothesis > owners > idle", () => {
    expect(__internal.inferPosture(emptySnap())).toBe("idle")
    expect(
      __internal.inferPosture({
        ...emptySnap(),
        ownerShortlist: [{ file: "x.ts", reason: "r" }],
      }),
    ).toBe("scoping")
    expect(__internal.inferPosture({ ...emptySnap(), hypothesis: "h" })).toBe("investigating")
    expect(
      __internal.inferPosture({
        ...emptySnap(),
        nextStepQueue: [{ what: "n" }],
        hypothesis: "h",
      }),
    ).toBe("executing")
    expect(
      __internal.inferPosture({
        ...emptySnap(),
        blockers: [{ what: "b", surface: "runtime" }],
        nextStepQueue: [{ what: "n" }],
      }),
    ).toBe("blocked")
  })
})

describe("formatWorkingStateTransient", () => {
  test("empty snapshot ⇒ empty string (caller no-ops)", () => {
    expect(formatWorkingStateTransient(emptySnap())).toBe("")
    expect(formatWorkingStateTransient(undefined)).toBe("")
  })

  test("full snapshot ⇒ '[state updated: …]' with plural-correct counters", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ownerShortlist: [
        { file: "a.ts", reason: "x" },
        { file: "b.ts", reason: "y" },
      ],
      blockers: [{ what: "b1", surface: "runtime" }],
      nextStepQueue: [{ what: "n1" }, { what: "n2" }, { what: "n3" }],
      deferredValidation: [],
    }
    const out = stripAnsi(formatWorkingStateTransient(snap))
    expect(out).toBe("[state updated: 1 blocker, 3 next steps, 2 owners]")
  })

  test("hypothesis-only snapshot ⇒ falls back to posture", () => {
    setColorPolicy("off")
    const snap: WorkingState = { ...emptySnap(), hypothesis: "framing" }
    const out = stripAnsi(formatWorkingStateTransient(snap))
    expect(out).toBe("[state updated: investigating]")
  })

  test("very long transient ⇒ capped at MAX_TRANSIENT_LEN", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ownerShortlist: Array.from({ length: 999 }, (_, i) => ({
        file: `f${i}.ts`,
        reason: `r${i}`,
      })),
      blockers: Array.from({ length: 999 }, () => ({
        what: "x",
        surface: "runtime" as const,
      })),
      nextStepQueue: Array.from({ length: 999 }, () => ({ what: "x" })),
      deferredValidation: Array.from({ length: 999 }, () => ({ rail: "p", reason: "r" })),
    }
    const out = stripAnsi(formatWorkingStateTransient(snap))
    expect(out.length).toBeLessThanOrEqual(__internal.MAX_TRANSIENT_LEN)
  })
})

describe("formatWorkingStateSummaryRow", () => {
  test("empty ⇒ ''", () => {
    expect(formatWorkingStateSummaryRow(emptySnap())).toBe("")
    expect(formatWorkingStateSummaryRow(undefined)).toBe("")
  })

  test("full ⇒ posture + counted tokens (stable order)", () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ownerShortlist: [],
      blockers: [{ what: "b", surface: "runtime" }],
      nextStepQueue: [{ what: "n1" }, { what: "n2" }],
      deferredValidation: [{ rail: "pytest", reason: "later" }],
    }
    const out = stripAnsi(formatWorkingStateSummaryRow(snap))
    expect(out).toContain("◈ state:")
    expect(out).toContain("blocked")
    expect(out).toContain("1×blocker")
    expect(out).toContain("2×next")
    expect(out).toContain("1×deferred")
  })
})

describe("/state slash command", () => {
  test("registered in BUILTINS under '/state' and '/working-state' (alias)", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/state")
    expect(names).toContain("/working-state")
  })

  test("absent ctx.workingState ⇒ prints 'not wired' and exits 0 (parity with /skills)", async () => {
    const { ctx, out, err } = buildCtx(undefined)
    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    expect(out.v).toContain("not wired")
    expect(err.v).toBe("")
  })

  test("wired ctx.workingState ⇒ renders the panel to stdout, exits 0", async () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ...emptySnap(),
      nextStepQueue: [{ what: "profile parseConfig" }],
    }
    const { ctx, out, err } = buildCtx(() => snap)
    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    expect(out.v).toContain("Working state")
    expect(out.v).toContain("1. profile parseConfig")
    expect(err.v).toBe("")
  })

  test("wired but returns undefined ⇒ paints the empty box (no crash)", async () => {
    setColorPolicy("off")
    const { ctx, out, err } = buildCtx(() => undefined)
    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    expect(out.v).toContain("(working state is empty)")
    expect(err.v).toBe("")
  })

  test("extra positional args ⇒ exit 1 and stderr error message", async () => {
    const { ctx, out, err } = buildCtx(() => emptySnap())
    const code = await runSlashCommand("/state foo", ctx)
    expect(code).toBe(1)
    expect(out.v).toBe("")
    expect(err.v).toContain("takes no arguments")
  })

  test("/working-state alias dispatches to the same body", async () => {
    setColorPolicy("off")
    const snap: WorkingState = {
      ...emptySnap(),
      blockers: [{ what: "need staging logs", surface: "runtime" }],
    }
    const { ctx, out } = buildCtx(() => snap)
    const code = await runSlashCommand("/working-state", ctx)
    expect(code).toBe(0)
    expect(out.v).toContain("Working state")
    expect(out.v).toContain("need staging logs")
  })
})
