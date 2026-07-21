/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-1-02): ONE normalizer for
 *   `ApprovalDecisionResult`, and NO raw string comparison anywhere else.
 *
 * Pinned bug: `ApprovalDecisionResult` is a union of bare strings
 * (`"approve" | "deny"`) and rich objects (`{decision, scope?, steer?}`). The
 * session-turn-driver normalized it INLINE (private), so other consumers
 * re-interpreted the union by hand — the precompact confirm
 * (`surface-compose.ts`) checked `decision === "approve"` strictly and
 * misclassified `{decision:"approve", scope:"session"}` (the operator's
 * "[a]lways" answer) as a DEFERRAL.
 *
 * Contract under test:
 *   1. `normalizeApprovalDecision` (SSOT, `@/runner/orchestrate`) maps every
 *      union shape losslessly; garbage throws (NO-FALLBACK, mirrors
 *      `normalizeConfirm`).
 *   2. `isApprovedDecision` is the ONLY sanctioned boolean projection.
 *   3. GREP-GATE: the bare `decision === "approve"` comparison pattern is BANNED
 *      in the known approvalPrompt-consumer files — the normalizer is the only
 *      reader of raw shapes.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ApprovalDecisionResultError,
  isApprovedDecision,
  normalizeApprovalDecision,
} from "@/runner/orchestrate"

describe("HELLGATE WS-A — normalizeApprovalDecision maps every shape losslessly", () => {
  test('bare "approve" ⇒ {decision:"approve"}', () => {
    expect(normalizeApprovalDecision("approve")).toEqual({ decision: "approve" })
  })

  test('bare "deny" ⇒ {decision:"deny"}', () => {
    expect(normalizeApprovalDecision("deny")).toEqual({ decision: "deny" })
  })

  test("rich approve preserves scope — the UUX-1-02 regression shape", () => {
    expect(normalizeApprovalDecision({ decision: "approve", scope: "session" })).toEqual({
      decision: "approve",
      scope: "session",
    })
  })

  test("rich approve with scope 'once' / 'session_prefix' preserved", () => {
    expect(normalizeApprovalDecision({ decision: "approve", scope: "once" })).toEqual({
      decision: "approve",
      scope: "once",
    })
    expect(normalizeApprovalDecision({ decision: "approve", scope: "session_prefix" })).toEqual({
      decision: "approve",
      scope: "session_prefix",
    })
  })

  test("rich deny preserves steer", () => {
    expect(
      normalizeApprovalDecision({ decision: "deny", steer: "try the readonly variant" }),
    ).toEqual({
      decision: "deny",
      steer: "try the readonly variant",
    })
  })

  test("an empty-after-trim steer is dropped to a plain deny (never a phantom steer)", () => {
    expect(normalizeApprovalDecision({ decision: "deny", steer: "   " })).toEqual({
      decision: "deny",
    })
  })

  test("garbage shapes THROW (no silent coercion — mirrors normalizeConfirm)", () => {
    for (const bad of [undefined, null, 42, "yes", {}, { decision: "maybe" }] as const) {
      expect(() => normalizeApprovalDecision(bad as never)).toThrow(ApprovalDecisionResultError)
    }
  })

  test("an invalid scope literal THROWS (never widens beyond the vocabulary)", () => {
    expect(() =>
      normalizeApprovalDecision({ decision: "approve", scope: "forever" } as never),
    ).toThrow(ApprovalDecisionResultError)
  })

  test("isApprovedDecision: rich session-approve IS approved (the precompact bug)", () => {
    expect(isApprovedDecision({ decision: "approve", scope: "session" })).toBe(true)
    expect(isApprovedDecision("approve")).toBe(true)
    expect(isApprovedDecision("deny")).toBe(false)
    expect(isApprovedDecision({ decision: "deny", steer: "s" })).toBe(false)
  })
})

// ── GREP-GATE — the bug pattern is banned at the known consumer seams ─────────
// A bare `decision === "approve"` on a raw ApprovalDecisionResult variable is
// exactly the UUX-1-02 bug. `.decision === "approve"` (a typed field read on an
// already-normalized object) is fine — the regex requires a NON-dot char before
// `decision`. New approvalPrompt consumers must be added to SCANNED.
describe("HELLGATE WS-A — grep-gate: raw approve comparison banned at consumer seams", () => {
  const ROOT = join(import.meta.dir, "..", "..")
  const SCANNED = [
    "src/apps/cli/repl/surface-compose/core-state.ts",
    "src/runner/orchestrate/session-turn-driver.ts",
    "src/apps/cli/repl/session-loop.ts",
    "src/apps/cli/repl/session-setup.ts",
  ]
  const findRawApprovalComparisons = (source: string): readonly string[] =>
    source.match(/(^|[^.\w])decision\s*===\s*"approve"/gm) ?? []

  test("precompact owner calls the authoritative approval projection", () => {
    const src = readFileSync(join(ROOT, "src/apps/cli/repl/surface-compose/core-state.ts"), "utf8")
    expect(src).toMatch(/isApprovedDecision\s*\(decision\)/)
  })

  test("raw-comparison detector rejects an injected regression", () => {
    expect(
      findRawApprovalComparisons('if (\n  decision\n  === "approve"\n) return "approve"'),
    ).toHaveLength(1)
  })

  for (const rel of SCANNED) {
    test(`${rel} has no raw 'decision === "approve"' comparison`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8")
      const hit = findRawApprovalComparisons(src)
      expect(
        hit.length === 0 ? "" : `${rel} — use normalizeApprovalDecision/isApprovedDecision`,
      ).toBe("")
    })
  }
})
