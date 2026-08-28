/**
 * ★ HELLGATE — the pre-compaction WARNING and actual COMPACTION must resolve the
 * same threshold (aug-28).
 *
 * THE DEFECT. The usage view carries two different model facts: `model` is the
 * REAL active id (deliberately — reporting must name what ran) while `max` is
 * resolved from the CONTEXT-WINDOW KEY (`<model>-1m` when the 1M beta is granted).
 * The CLI's warning derived its threshold from `view.model`, so with 1M active:
 *
 *   actual compaction threshold : 923_000   (window key)
 *   warning threshold           : 123_000   (model id)
 *
 * The warning therefore latched on at ~110k and NEVER cleared for the remaining
 * 800k, announcing "auto-summary imminent" at 700%+ of a threshold that was 8x
 * away. It was invisible for two reasons: (1) the pre-existing test hand-built a
 * view whose `model` was already the window key — a shape production never emits;
 * (2) the 1M key was being EATEN upstream by the responses-continuation wrapper,
 * so the divergence could not fire until that was fixed in the same campaign.
 *
 * The fix is a published `windowModel` on the snapshot/view: ONE producer resolves
 * the window key, every display consumes it.
 *
 * RED-on-injection: revert `notify-and-warning.ts` to `view?.model` ⇒ the 1M cases
 * below fail (a warning at 130k, and a 732%-of-limit line at 900k).
 */
import { describe, expect, test } from "bun:test"
import { resolveCompactionLimitTokens } from "@/agent/compaction/token-baseline"
import { snapshotToBreakdownInput } from "@/agent/context/usage-breakdown"
import { buildNotifyAndContextWarning } from "@/apps/cli/repl/factories/notify-and-warning"
import type { SegmentedUsageView } from "@/apps/cli/status-line"

/** The 1M-beta shape production emits: `model` = the real id, `windowModel` = the
 *  `-1m` resolution key, `max` = the granted window. */
const view1M = (used: number): SegmentedUsageView => ({
  segments: [{ id: "history", tokens: used }],
  total: used,
  max: 1_000_000,
  model: "claude-sonnet-4-6",
  windowModel: "claude-sonnet-4-6-1m",
})

/** The ordinary shape: no window pin, so the threshold comes from the model id. */
const viewPlain = (used: number): SegmentedUsageView => ({
  segments: [{ id: "history", tokens: used }],
  total: used,
  max: 200_000,
  model: "claude-sonnet-4-6",
})

/** The LIVE warning closure the REPL installs — built by the real factory, so a
 *  revert of its threshold derivation reds these cases (a local re-implementation
 *  of the same expression would not). `stderr.isTTY` is forced on because the
 *  factory only installs the warning for a TTY. */
const liveWarn = (view: SegmentedUsageView | undefined): string => {
  const priorTty = process.stderr.isTTY
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
  try {
    const { contextWarning } = buildNotifyAndContextWarning({
      cwd: "/tmp",
      contextUsageView: () => view,
    })
    return contextWarning?.() ?? ""
  } finally {
    Object.defineProperty(process.stderr, "isTTY", { value: priorTty, configurable: true })
  }
}

const warn = (view: SegmentedUsageView): string => liveWarn(view)

describe("context warning agrees with the compaction threshold", () => {
  test("the two thresholds are genuinely different (the premise is real, not hypothetical)", () => {
    expect(resolveCompactionLimitTokens(undefined, "claude-sonnet-4-6")).toBe(123_000)
    expect(resolveCompactionLimitTokens(undefined, "claude-sonnet-4-6-1m")).toBe(923_000)
  })

  test("1M session: NO warning at 130k (compaction is 923k away) — the latch is gone", () => {
    expect(warn(view1M(130_000))).toBe("")
  })

  test("1M session: NO warning at 700k either (mid-window is not 'imminent')", () => {
    expect(warn(view1M(700_000))).toBe("")
  })

  test("1M session: the warning DOES fire near the real threshold", () => {
    const out = warn(view1M(900_000))
    expect(out).not.toBe("")
    // …and it never claims a nonsense percentage of a threshold 8x away.
    expect(out).not.toMatch(/\b[2-9]\d\d%/)
  })

  test("paired control — a non-1M session is byte-identical to before (fires at ~123k)", () => {
    expect(warn(viewPlain(100_000))).toBe("")
    expect(warn(viewPlain(130_000))).not.toBe("")
  })

  test("no `windowModel` published ⇒ falls back to `model` (legacy shape still works)", () => {
    const legacy: SegmentedUsageView = { ...viewPlain(130_000) }
    expect(warn(legacy)).not.toBe("")
  })

  test("the PRODUCER→display hop carries the key (not just the type)", () => {
    // A snapshot with a window pin must surface `windowModel` on the breakdown the
    // CLI view is built from — otherwise the display silently falls back to
    // `model` and the divergence returns.
    const input = snapshotToBreakdownInput({
      system: [{ text: "sys" }],
      max: 1_000_000,
      model: "claude-sonnet-4-6",
      windowModel: "claude-sonnet-4-6-1m",
    } as never)
    expect(input.windowModel).toBe("claude-sonnet-4-6-1m")
    // Paired control: no pin ⇒ the field stays ABSENT (never a literal undefined,
    // which `exactOptionalPropertyTypes` would reject downstream).
    const bare = snapshotToBreakdownInput({ system: [{ text: "sys" }], max: 200_000 } as never)
    expect("windowModel" in bare).toBe(false)
  })
})
