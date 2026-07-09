/**
 * Unit tests for `src/apps/cli/working-state-panel.ts` (catalog 대5 L4
 * WorkingState surfacing).
 *
 * Coverage axes:
 *   - empty snapshot          → renderer shows "(empty)" pill.
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
 *                                no-active-plan, with explicit ordering tests.
 *                                The header is "Plan posture" and the
 *                                empty-plan value is "no active plan" (NOT a
 *                                bare "idle") so the line reads as a summary
 *                                of the model's plan scratchpad, never a live
 *                                turn-lifecycle status this pure renderer
 *                                cannot verify.
 *   - slash registration      → BUILTINS includes `/state` + `/working-state`.
 *   - slash command run path  → not-wired branch, success branch, args
 *                                rejection branch.
 *
 * Pure-renderer tests (no I/O). The slash branch uses an in-memory
 * `SlashContext` with stub callbacks — same harness shape as
 * `tests/unit/slash-commands.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import type { WorkingState } from "../../../src/agent"
import { BUILTINS, runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"
// UUX-5-12 (2026-07-10): `formatWorkingStateTransient` / `formatWorkingStateSummaryRow`
// were deleted from the panel module — they had NO production consumer (only
// these tests imported them). Their describes were removed with them.
import { __internal, renderWorkingStatePanel } from "../../../src/apps/cli/working-state-panel"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

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
    expect(out).toContain("Plan posture:")
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

  test("posture precedence: blockers > next > hypothesis > owners > no-active-plan", () => {
    expect(__internal.inferPosture(emptySnap())).toBe("no active plan")
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

  // Status-honesty: this pure renderer has NO access to the real turn
  // lifecycle (the surface threads only the read-only WorkingState getter —
  // see `SlashContext.workingState`), so the posture line must NOT read as a
  // live turn status. Empty plan ⇒ "no active plan" (a plan-scoped phrase),
  // never a bare "idle" that could contradict a turn that is actually
  // running. The header is "Plan posture" (plan-scoped), not bare "Posture".
  //
  // TEETH: the OLD wording (header "Posture:" + empty value "idle") fails
  // both assertions below — `inferPosture` returning "idle" trips the first,
  // and a bare "Posture:" header (no "Plan") trips the second.
  test("status honesty: empty plan ⇒ 'no active plan', never a bare 'idle'", () => {
    setColorPolicy("off")
    // The inferred value for an empty scratchpad is plan-scoped, NOT "idle".
    expect(__internal.inferPosture(emptySnap())).toBe("no active plan")
    expect(__internal.inferPosture(emptySnap())).not.toBe("idle")
  })

  test("status honesty: posture line is plan-scoped ('Plan posture'), never bare 'Posture:'", () => {
    setColorPolicy("off")
    // A non-empty scratchpad paints the posture line. The label must read as
    // a plan-scratchpad summary, not a live turn status. A bare "idle" value
    // must never appear even when no plan fields are set on a non-empty snap.
    const snap: WorkingState = { ...emptySnap(), hypothesis: "still framing" }
    const out = stripAnsi(renderWorkingStatePanel(snap))
    expect(out).toContain("Plan posture:")
    // The bare "Posture:" header (without the "Plan " qualifier) would read
    // as a live lifecycle status — it must NOT appear.
    expect(out).not.toMatch(/(^|\n)\s*Posture:/)
    // And the word "idle" (a live-lifecycle term) must never surface.
    expect(out).not.toContain("idle")
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
