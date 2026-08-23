/**
 * HELLGATE — StopCategory presentation table (aug-23 Grok-Build diff, 우선순위 0 / slice 1b)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13. Audit finding: all
 * 18 `STOP_REASON_CODE` values are produced and NONE is read by any surface —
 * `grep stopCategory src/apps/ apps/ surfaces/` = 0 hits. Six independent render
 * rails each re-derive their own mapping from the legacy 7-value `reason`, and
 * every one of them falls through to success-looking copy on anything it does
 * not recognize. That is the competitor bug we are not reproducing.
 *
 * This slice adds the ONE shared table those rails will consume (slice 1d).
 * A table nobody can drift from is the whole point, so the invariants are:
 *
 *  H1  EXHAUSTIVE — every `StopReasonCode` has a presentation entry. Typed as
 *      `Record<StopReasonCode, StopPresentation>` so a new code fails
 *      COMPILATION, plus a runtime guard for stale/extra keys (the
 *      `promax/classify.ts:140-156` precedent, mirrored in slice 1a).
 *
 *  H2  NO SILENT SUCCESS — `tone:"success"` is reserved for genuine completion.
 *      Every non-completion code must carry a non-success tone. This is the
 *      single assertion that would have caught the competitor's headline bug
 *      (a thrashed-to-a-standstill turn rendering as "Worked for 2m5s").
 *
 *  H3  TONE AGREES WITH THE EXIT CODE — `exitCodeForOutcome` (src/apps/agent/
 *      run.ts:54) is today the ONLY place that classifies outcomes correctly.
 *      It is the reference: success⇄0, incomplete⇄1, failed⇄1, blocked⇄2,
 *      refused⇄3, cancelled⇄130. A tone that disagrees with the shipped exit
 *      code means two truths in one codebase.
 *
 *  H4  RED-ON-INJECTION — the guard must actually fire on a holed table and on
 *      an extra key. A guard that silently passes is worse than none.
 *
 *  H5  LABELS ARE HUMAN AND DISTINCT — no empty labels, no duplicate labels
 *      across different codes (a rail that renders the label must not make two
 *      different stops indistinguishable).
 */

import { describe, expect, test } from "bun:test"
import {
  assertStopPresentationInSync,
  STOP_PRESENTATION_BY_REASON_CODE,
  STOP_REASON_CODE,
  type StopReasonCode,
  type StopTone,
  stopPresentationFor,
} from "@/agent/stop-category"

const ALL_CODES: readonly StopReasonCode[] = Object.values(STOP_REASON_CODE)

/** Tone → the exit code `exitCodeForOutcome` already ships for that class. */
const EXPECTED_EXIT_BY_TONE: Record<StopTone, number> = {
  success: 0,
  incomplete: 1,
  failed: 1,
  blocked: 2,
  refused: 3,
  cancelled: 130,
}

describe("H1 — the presentation table is exhaustive", () => {
  test("every StopReasonCode has an entry", () => {
    for (const code of ALL_CODES) {
      const entry = STOP_PRESENTATION_BY_REASON_CODE[code]
      expect(entry, `no presentation for "${code}"`).toBeDefined()
    }
    expect(Object.keys(STOP_PRESENTATION_BY_REASON_CODE).sort()).toEqual([...ALL_CODES].sort())
  })

  test("the shipped table passes its own guard", () => {
    expect(() => {
      assertStopPresentationInSync()
    }).not.toThrow()
  })
})

describe("H2 — no non-completion code renders as success", () => {
  test("success tone is reserved for genuine completion", () => {
    const successCodes = ALL_CODES.filter(
      (c) => STOP_PRESENTATION_BY_REASON_CODE[c].tone === "success",
    )
    expect(successCodes).toEqual([STOP_REASON_CODE.COMPLETED_NORMAL])
  })

  test("the two documented NON-success model stalls are not success", () => {
    // Both are documented in stop-category.ts as "NON-success, distinct from a
    // clean completion" — today every surface collapses them into `error` and
    // the CLI notifier prints a success tick.
    for (const code of [
      STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED,
      STOP_REASON_CODE.MODEL_MALFORMED_TOOL_USE,
    ]) {
      expect(STOP_PRESENTATION_BY_REASON_CODE[code].tone).not.toBe("success")
    }
  })

  test("max_turns is incomplete, not success", () => {
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.COMPLETED_MAX_TURNS].tone).toBe(
      "incomplete",
    )
  })
})

describe("H3 — tone agrees with the shipped exit-code classification", () => {
  test("every entry maps to a known tone with a defined exit class", () => {
    for (const code of ALL_CODES) {
      const { tone } = STOP_PRESENTATION_BY_REASON_CODE[code]
      expect(EXPECTED_EXIT_BY_TONE[tone], `tone "${tone}" has no exit class`).toBeDefined()
    }
  })

  test("interrupts are cancelled(130), budget/approval are blocked(2), refusal is refused(3)", () => {
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.USER_INTERRUPT].tone).toBe("cancelled")
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.SYSTEM_ABORT].tone).toBe("cancelled")
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.BUDGET_COST_CAP].tone).toBe("blocked")
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.BUDGET_LEDGER_BREACH].tone).toBe(
      "blocked",
    )
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.SHELL_NEEDS_APPROVAL].tone).toBe(
      "blocked",
    )
    expect(STOP_PRESENTATION_BY_REASON_CODE[STOP_REASON_CODE.MODEL_REFUSAL].tone).toBe("refused")
  })
})

describe("H4 — the guard is not vacuous (red-on-injection)", () => {
  test("a MISSING code throws", () => {
    const holed = { ...STOP_PRESENTATION_BY_REASON_CODE } as Record<string, unknown>
    delete holed[STOP_REASON_CODE.PROVIDER_RATE_LIMIT]
    expect(() => {
      assertStopPresentationInSync(holed as never, ALL_CODES)
    }).toThrow(/rate_limit/)
  })

  test("an EXTRA code throws", () => {
    const bloated = {
      ...STOP_PRESENTATION_BY_REASON_CODE,
      "not.a.real.code": { label: "x", tone: "failed" as StopTone },
    }
    expect(() => {
      assertStopPresentationInSync(bloated as never, ALL_CODES)
    }).toThrow(/not\.a\.real\.code/)
  })
})

describe("H5 — labels are usable", () => {
  test("no empty labels", () => {
    for (const code of ALL_CODES) {
      expect(STOP_PRESENTATION_BY_REASON_CODE[code].label.trim().length).toBeGreaterThan(0)
    }
  })

  test("labels are distinct across codes", () => {
    const labels = ALL_CODES.map((c) => STOP_PRESENTATION_BY_REASON_CODE[c].label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("lookup helper", () => {
  test("resolves a known code", () => {
    expect(stopPresentationFor(STOP_REASON_CODE.COMPLETED_MAX_TURNS).tone).toBe("incomplete")
  })

  test("an UNKNOWN code degrades to a non-success tone, never to success", () => {
    // The competitor's bug is precisely that unrecognized values fall through to
    // success. An unknown code is by definition not a verified completion.
    const fallback = stopPresentationFor("some.future.code")
    expect(fallback.tone).not.toBe("success")
    expect(fallback.label.trim().length).toBeGreaterThan(0)
  })
})
