/**
 * StopCategory matrix tests (ADR-0063, Spec B3).
 *
 * Covers:
 *   - {@link classifyErrorReason}: every documented bucket of the matrix
 *     (rate-limit, overloaded, network, auth, bad_request, compaction thrash,
 *     unknown provider, runtime fallback). Each row asserts both `kind` and
 *     `reasonCode` so a typo in the matrix fails a single test, not the
 *     downstream consumer.
 *   - {@link completedCategory}: the two live sub-kinds (normal / max_turns) map
 *     to the documented code (ALBB-17 claim 4 removed the test-only empty/malformed arms).
 *   - {@link budgetCategory}: cost-cap bucket (preflight / meter / ledger).
 *   - {@link interruptedCategory}: user / system cause split.
 *
 * Pure module — no clock, no IO. Tests are the contract document; adding
 * a new code MUST extend STOP_REASON_CODE and add a row here.
 */
import { describe, expect, test } from "bun:test"
import {
  budgetCategory,
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  STOP_REASON_CODE,
  type StopCategory,
} from "@/agent/stop-category"
import { DEFAULT_STOP_REASON_ROUTING } from "@/agent/stop-reason/default-policy"
import type { StopAction } from "@/agent/stop-reason/types"

describe("classifyErrorReason — matrix coverage", () => {
  test.each<[string, StopCategory["kind"], string]>([
    [
      "LLM stream failed after retries: status 429 rate_limit",
      "failed",
      STOP_REASON_CODE.PROVIDER_RATE_LIMIT,
    ],
    [
      "anthropic request failed: status 529 overloaded_error",
      "failed",
      STOP_REASON_CODE.PROVIDER_OVERLOADED,
    ],
    ["openai request failed: ECONNRESET", "failed", STOP_REASON_CODE.PROVIDER_NETWORK],
    ["anthropic request failed: status 401 unauthorized", "failed", STOP_REASON_CODE.PROVIDER_AUTH],
    [
      "openai request failed: status 400 bad_request",
      "failed",
      STOP_REASON_CODE.PROVIDER_BAD_REQUEST,
    ],
    [
      "compaction breaker tripped: no progress after 3 attempts",
      "failed",
      STOP_REASON_CODE.COMPACTION_THRASH,
    ],
    ["LLM request failed", "failed", STOP_REASON_CODE.PROVIDER_UNKNOWN],
    [
      "[empty-turn] model returned only empty responses after the budget",
      "failed",
      STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED,
    ],
    ["something totally unexpected exploded", "failed", STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR],
  ])("%s → kind=%s reasonCode=%s", (reason, kind, code) => {
    const cat = classifyErrorReason(reason)
    expect(cat.kind).toBe(kind)
    expect(cat.reasonCode).toBe(code)
  })

  test("returns hint for documented buckets, omits for unknown", () => {
    const rl = classifyErrorReason("status 429 rate limit")
    expect(rl.hint).toBeDefined()
    const fallback = classifyErrorReason("xxx")
    expect(fallback.hint).toBeUndefined()
  })
})

describe("completedCategory — live sub-kinds only (claim 4: empty/malformed arms removed)", () => {
  test("normal", () => {
    expect(completedCategory("normal")).toEqual({
      kind: "completed",
      reasonCode: STOP_REASON_CODE.COMPLETED_NORMAL,
    })
  })
  test("max_turns", () => {
    expect(completedCategory("max_turns")).toEqual({
      kind: "max_turns",
      reasonCode: STOP_REASON_CODE.COMPLETED_MAX_TURNS,
      hint: "Reached the configured maxTurns limit.",
    })
  })
  test("default arg is 'normal'", () => {
    expect(completedCategory()).toEqual(completedCategory("normal"))
  })
  // ALBB-17 claim 4 — the never-called `empty_exhausted` / `malformed_exhausted`
  // arms are removed. Live production emits the `model.*` codes via
  // classifyErrorReason instead. A grep-guard: the only accepted args are
  // "normal" | "max_turns" (a reintroduced arm without a production caller fails
  // typecheck at the call site + this assertion below).
  test("empty/malformed arms are gone (only normal|max_turns produce codes)", () => {
    const codes = new Set(
      (["normal", "max_turns"] as const).map((v) => completedCategory(v).reasonCode),
    )
    expect(codes.has(STOP_REASON_CODE.COMPLETED_NORMAL)).toBe(true)
    expect(codes.has(STOP_REASON_CODE.COMPLETED_MAX_TURNS)).toBe(true)
    // the retired codes are no longer part of the enum
    expect(
      Object.values(STOP_REASON_CODE as Record<string, string>).includes(
        "completed.empty_exhausted",
      ),
    ).toBe(false)
    expect(
      Object.values(STOP_REASON_CODE as Record<string, string>).includes(
        "completed.malformed_exhausted",
      ),
    ).toBe(false)
  })
})

describe("budgetCategory — ALBB-17 claim 1 (Cursor budget bucket)", () => {
  test("meter ⇒ budget / budget.cost_cap with cost hint (NOT maxTurns)", () => {
    const cat = budgetCategory("meter")
    expect(cat.kind).toBe("budget")
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.BUDGET_COST_CAP)
    expect(cat.reasonCode).toBe("budget.cost_cap")
    expect(cat.hint).not.toBe("Reached the configured maxTurns limit.")
    expect(cat.hint).toBeDefined()
  })
  test("preflight ⇒ budget / budget.cost_cap (pre-model meter admission)", () => {
    const cat = budgetCategory("preflight")
    expect(cat.kind).toBe("budget")
    expect(cat.reasonCode).toBe("budget.cost_cap")
  })
  test("ledger ⇒ budget / budget.ledger_breach (cross-run cap, distinct code)", () => {
    const cat = budgetCategory("ledger")
    expect(cat.kind).toBe("budget")
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.BUDGET_LEDGER_BREACH)
    expect(cat.reasonCode).toBe("budget.ledger_breach")
  })
  test("all sources start `budget.` and never `completed.max_turns`", () => {
    for (const src of ["meter", "preflight", "ledger"] as const) {
      const cat = budgetCategory(src)
      expect(cat.reasonCode.startsWith("budget.")).toBe(true)
      expect(cat.reasonCode).not.toBe(STOP_REASON_CODE.COMPLETED_MAX_TURNS)
      expect(cat.kind).not.toBe("max_turns")
    }
  })
})

describe("classifyErrorReason — stop-policy tag arms (ALBB-17 claim 3)", () => {
  test("[stop-abort] ⇒ interrupted / system.abort (NOT runtime.unknown_error)", () => {
    const cat = classifyErrorReason("[stop-abort] provider stop_reason=content_filtered")
    expect(cat.kind).toBe("interrupted")
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.SYSTEM_ABORT)
    expect(cat.reasonCode).not.toBe(STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR)
  })
  test("[stop-hitl] ⇒ needs_user_approval / shell.needs_approval (NOT runtime.unknown_error)", () => {
    const cat = classifyErrorReason("[stop-hitl] provider stop_reason=guardrail_intervened")
    expect(cat.kind).toBe("needs_user_approval")
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.SHELL_NEEDS_APPROVAL)
    expect(cat.reasonCode).not.toBe(STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR)
  })
})

// ALBB-17 claim 4 — fail-closed EXHAUSTIVE cross-check. Every terminal StopAction
// the default policy can route (abort / hitl) is tagged by decideFromStopPolicy
// with a fixed `[stop-abort]` / `[stop-hitl]` prefix. classifyErrorReason MUST
// have a NON-`runtime.unknown_error` arm for each tag. A newly-added tagged
// StopAction whose prefix lacks a mapping ⇒ RED here (not a silent mislabel).
describe("StopAction ↔ classifyErrorReason exhaustive cross-check (fail-closed)", () => {
  // The tag prefix decideFromStopPolicy stamps per terminal-with-tag StopAction
  // kind (mirrors recovery.ts:360-363). `surface` is untagged (legacy-shaped, no
  // prefix) and `continue` falls through — neither reaches classifyErrorReason.
  const TAG_PREFIX: Partial<Record<StopAction["kind"], string>> = {
    abort: "[stop-abort]",
    hitl: "[stop-hitl]",
  }
  const routedActionKinds = new Set(
    Object.values(DEFAULT_STOP_REASON_ROUTING).map((a) => a.kind),
  )
  for (const kind of routedActionKinds) {
    const prefix = TAG_PREFIX[kind]
    if (prefix === undefined) continue // surface/continue: no tag, not classified here
    test(`routed StopAction "${kind}" tag ${prefix} classifies to a specific (non-unknown) code`, () => {
      const cat = classifyErrorReason(`${prefix} some reason text`)
      expect(cat.reasonCode).not.toBe(STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR)
    })
  }
  // Guard the guard: at least the two default-policy terminal tags must be exercised
  // (so an empty routing map can't make this vacuously pass).
  test("covers both default-policy terminal tags (abort + hitl)", () => {
    expect(routedActionKinds.has("abort")).toBe(true)
    expect(routedActionKinds.has("hitl")).toBe(true)
  })
})

describe("interruptedCategory — user / system split", () => {
  test("user (default)", () => {
    expect(interruptedCategory()).toEqual({
      kind: "interrupted",
      reasonCode: STOP_REASON_CODE.USER_INTERRUPT,
      hint: "User interrupt.",
    })
  })
  test("system", () => {
    expect(interruptedCategory("system")).toEqual({
      kind: "interrupted",
      reasonCode: STOP_REASON_CODE.SYSTEM_ABORT,
      hint: "Run aborted by host.",
    })
  })
})

describe("STOP_REASON_CODE table is closed and namespaced", () => {
  test("every value has a dotted prefix", () => {
    for (const [k, v] of Object.entries(STOP_REASON_CODE)) {
      expect(v.includes(".")).toBe(true)
      expect(typeof k).toBe("string")
    }
  })
  test("every value is unique (no duplicates)", () => {
    const values = Object.values(STOP_REASON_CODE)
    expect(new Set(values).size).toBe(values.length)
  })
})
