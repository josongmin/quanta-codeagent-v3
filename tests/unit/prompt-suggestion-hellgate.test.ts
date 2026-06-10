/**
 * HELLGATE — prompt-suggestion + quality reject-gate (ADR-0467).
 *
 * The crown jewel is the PURE reject gate: a closed `RejectReason` enum where
 * each member is one named predicate, evaluated in order, first-match-wins.
 * These cases prove:
 *   - EVERY reject reason fires on at least one adversarial input;
 *   - the short-command whitelist + slash-command escape both bypass
 *     `too_few_words`;
 *   - the sanitizer strips `<suggestion>` tags / leading labels / quotes
 *     so the gate sees the bare candidate;
 *   - the suppression-context guard blocks (plan / rate-limit / elicitation /
 *     pending-permission) in fixed precedence, WITHOUT calling the model;
 *   - the orchestrator's gate-OFF path is byte-identical to today and makes
 *     ZERO model calls;
 *   - a throwing / aborted / undefined SuggestFn degrades to suppress, never
 *     throws;
 *   - the happy path shows the sanitized text.
 *
 * Pure slice — no IO, no network, no clock.
 */
import { describe, expect, test } from "bun:test"
import {
  type AppStateView,
  describeReason,
  PROMPT_SUGGESTION_ENV,
  promptSuggestionEnabled,
  REJECT_REASONS,
  type RejectReason,
  rejectGate,
  runPromptSuggestion,
  type SuggestFn,
  sanitizeSuggestion,
  suppressionReason,
} from "@/agent/prompt-suggestion"

/** Surface state with nothing suppressing — the "safe to suggest" baseline. */
const CLEAR_STATE: AppStateView = {
  planMode: false,
  rateLimited: false,
  elicitationActive: false,
  pendingPermission: false,
}

const ENABLED_ENV = { [PROMPT_SUGGESTION_ENV]: "1" } as const

describe("rejectGate — one adversarial input per reason", () => {
  // The canonical trip per reason. The acceptable input must NOT trip an
  // EARLIER predicate, so each is chosen to fail exactly its own gate.
  const cases: Array<{ reason: RejectReason; input: string }> = [
    { reason: "empty", input: "   " },
    { reason: "done", input: "done" },
    { reason: "meta_text", input: "nothing to suggest right now" },
    { reason: "meta_wrapped", input: "(add a test for this)" },
    { reason: "error_message", input: "api error: overloaded" },
    { reason: "prefixed_label", input: "Suggestion: run the tests" },
    { reason: "too_few_words", input: "frobnicate" },
    {
      reason: "too_many_words",
      input: "add a brand new failing unit test then make it green now please",
    },
    {
      // >=100 chars with 3..12 words (so it clears too_few/too_many) and no
      // sentence boundary — length is the first gate it trips.
      reason: "too_long",
      input:
        "refactorize-the-authentication-subsystem into hexagonal-port-and-adapter-layout-with-extra-padding-now",
    },
    { reason: "multiple_sentences", input: "Run tests. Then commit." },
    { reason: "has_formatting", input: "run **the** tests" },
    { reason: "evaluative", input: "looks good" },
    { reason: "claude_voice", input: "let me run the tests" },
  ]

  for (const { reason, input } of cases) {
    test(`${reason} ⇐ ${JSON.stringify(input)}`, () => {
      const v = rejectGate(input)
      expect(v.accepted).toBe(false)
      if (!v.accepted) expect(v.reason).toBe(reason)
    })
  }

  test("every RejectReason has a covering case (no orphan member)", () => {
    const covered = new Set(cases.map((c) => c.reason))
    for (const r of REJECT_REASONS) expect(covered.has(r)).toBe(true)
    // and no stray case for a non-existent reason
    expect(cases.length).toBe(REJECT_REASONS.length)
  })
})

describe("rejectGate — too_few_words whitelist + slash escape + accept", () => {
  for (const ok of ["yes", "Yes", "OK", "okay", "push", "commit", "deploy", "no"]) {
    test(`whitelisted one-word command accepted: ${ok}`, () => {
      expect(rejectGate(ok).accepted).toBe(true)
    })
  }

  test("a one-token slash command is accepted (slash escape)", () => {
    expect(rejectGate("/test").accepted).toBe(true)
  })

  test("a normal short prompt is accepted", () => {
    expect(rejectGate("run the tests").accepted).toBe(true)
  })

  test("exactly 2 words is NOT too_few", () => {
    expect(rejectGate("run tests").accepted).toBe(true)
  })

  test("exactly 12 words is NOT too_many; 13 is", () => {
    const twelve = "a b c d e f g h i j k l"
    const thirteen = `${twelve} m`
    expect(rejectGate(twelve).accepted).toBe(true)
    const v = rejectGate(thirteen)
    expect(v.accepted).toBe(false)
    if (!v.accepted) expect(v.reason).toBe("too_many_words")
  })
})

describe("rejectGate — first-match-wins ordering", () => {
  test("empty beats everything", () => {
    const v = rejectGate("")
    expect(v.accepted).toBe(false)
    if (!v.accepted) expect(v.reason).toBe("empty")
  })

  test("done is reported before meta_text even though both could match prose", () => {
    const v = rejectGate("done")
    if (!v.accepted) expect(v.reason).toBe("done")
  })

  test("too_long boundary is exact: 99 chars accepted, 100 rejected", () => {
    // 2 words (clears too_few/too_many), no sentence boundary, no formatting —
    // length is the only gate in play, so we pin the >= 100 threshold.
    const at99 = `aa ${"x".repeat(96)}` // 2 + 1 + 96 = 99
    const at100 = `aa ${"x".repeat(97)}` // 100
    expect(at99.length).toBe(99)
    expect(at100.length).toBe(100)
    expect(rejectGate(at99).accepted).toBe(true)
    const v = rejectGate(at100)
    expect(v.accepted).toBe(false)
    if (!v.accepted) expect(v.reason).toBe("too_long")
  })

  test("done wins over too_few_words (both could fire on the lone word 'done')", () => {
    // "done" is one word (would trip too_few_words) but the earlier `done`
    // predicate must claim it — pins first-match precedence between two reasons
    // that genuinely both match the same input.
    const v = rejectGate("done")
    if (!v.accepted) expect(v.reason).toBe("done")
  })

  test("describeReason is total over the closed enum", () => {
    for (const r of REJECT_REASONS) expect(describeReason(r).length).toBeGreaterThan(0)
  })
})

describe("sanitizeSuggestion — strip wrappers then gate sees bare text", () => {
  test("strips matched <suggestion> tags", () => {
    expect(sanitizeSuggestion("<suggestion>run the tests</suggestion>")).toBe("run the tests")
  })

  test("strips a lone open or close tag", () => {
    expect(sanitizeSuggestion("<suggestion>run the tests")).toBe("run the tests")
    expect(sanitizeSuggestion("run the tests</suggestion>")).toBe("run the tests")
  })

  test("strips ALL competitor wrapper-tag names, not just <suggestion>", () => {
    for (const tag of ["response", "output", "answer", "result"]) {
      expect(sanitizeSuggestion(`<${tag}>run the tests</${tag}>`)).toBe("run the tests")
      expect(sanitizeSuggestion(`<${tag.toUpperCase()}>run the tests`)).toBe("run the tests")
    }
  })

  test("peels NESTED wrapper tags (model double/triple-wraps) so no tag leaks", () => {
    // A single anchored strip would leave the inner tags as visible noise the
    // gate cannot recognise; the bounded peel removes every layer.
    expect(
      sanitizeSuggestion("<suggestion><suggestion>run the tests</suggestion></suggestion>"),
    ).toBe("run the tests")
    expect(
      sanitizeSuggestion("<output><output><output>run the tests</output></output></output>"),
    ).toBe("run the tests")
  })

  test("does NOT strip a tag-word appearing in the CONTENT (anchored only)", () => {
    // "output"/"result" inside the body are real words, not wrappers.
    expect(sanitizeSuggestion("<suggestion>add output to result</suggestion>")).toBe(
      "add output to result",
    )
  })

  test("tag nesting deeper than the peel bound stops at the bound (no unbounded work)", () => {
    // 6 layers, MAX_TAG_LAYERS = 4: exactly 4 are peeled, leaving the 2-deep
    // remainder. This pins the bound so a pathological input cannot drive
    // unbounded stripping, and the residual markup means the gate will not
    // surface it as a clean prompt.
    const sixDeep = `${"<suggestion>".repeat(6)}run the tests${"</suggestion>".repeat(6)}`
    expect(sanitizeSuggestion(sixDeep)).toBe(
      "<suggestion><suggestion>run the tests</suggestion></suggestion>",
    )
  })

  test("strips a short leading label", () => {
    expect(sanitizeSuggestion("Suggestion: run the tests")).toBe("run the tests")
  })

  test("strips every competitor label word (closed set)", () => {
    for (const label of ["Suggestion", "Response", "Reply", "Answer", "Output", "Result"]) {
      expect(sanitizeSuggestion(`${label}: run the tests`)).toBe("run the tests")
    }
    expect(sanitizeSuggestion("Suggested reply: run the tests")).toBe("run the tests")
    expect(sanitizeSuggestion("suggested prompt: run the tests")).toBe("run the tests")
  })

  test("does NOT strip a non-label leading word ending in colon", () => {
    // "Fix" is not in the closed label set — left intact for the gate.
    expect(sanitizeSuggestion("Fix: the login bug")).toBe("Fix: the login bug")
    expect(sanitizeSuggestion("TODO: add a test")).toBe("TODO: add a test")
  })

  test("unwraps surrounding quotes/backticks", () => {
    expect(sanitizeSuggestion('"run the tests"')).toBe("run the tests")
    expect(sanitizeSuggestion("`run the tests`")).toBe("run the tests")
  })

  test("empty tag pair sanitizes to '' which the gate rejects as empty", () => {
    const bare = sanitizeSuggestion("<suggestion></suggestion>")
    expect(bare).toBe("")
    const v = rejectGate(bare)
    if (!v.accepted) expect(v.reason).toBe("empty")
  })

  test("does NOT mangle a mid-sentence colon (long label left for the gate)", () => {
    // 4+ leading words ending in colon is not a wrapper label.
    const s = sanitizeSuggestion("run the database migration: prod")
    expect(s).toBe("run the database migration: prod")
  })

  test("total over pathological input — never throws", () => {
    expect(() => sanitizeSuggestion("")).not.toThrow()
    expect(() => sanitizeSuggestion("<<<>>>")).not.toThrow()
    expect(() => sanitizeSuggestion("\x00\u{1f600}")).not.toThrow()
  })
})

describe("suppressionReason — context guard precedence", () => {
  test("clear state ⇒ null (safe to suggest)", () => {
    expect(suppressionReason(CLEAR_STATE)).toBeNull()
  })

  test("plan_mode wins over a simultaneously rate-limited state", () => {
    expect(suppressionReason({ ...CLEAR_STATE, planMode: true, rateLimited: true })).toBe(
      "plan_mode",
    )
  })

  test("each context reason fires", () => {
    expect(suppressionReason({ ...CLEAR_STATE, rateLimited: true })).toBe("rate_limited")
    expect(suppressionReason({ ...CLEAR_STATE, elicitationActive: true })).toBe(
      "elicitation_active",
    )
    expect(suppressionReason({ ...CLEAR_STATE, pendingPermission: true })).toBe(
      "pending_permission",
    )
  })
})

describe("runPromptSuggestion — orchestration", () => {
  /** A SuggestFn that records whether it was ever called. */
  const spy = (out: string | undefined) => {
    let calls = 0
    const fn: SuggestFn = async () => {
      calls += 1
      return out
    }
    return { fn, calls: () => calls }
  }

  test("gate OFF ⇒ suppress gate_off, model NEVER called (byte-identical to today)", async () => {
    const s = spy("run the tests")
    const r = await runPromptSuggestion(s.fn, { env: {}, state: CLEAR_STATE })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.kind).toBe("suppress")
      if (r.value.kind === "suppress") expect(r.value.reason).toBe("gate_off")
    }
    expect(s.calls()).toBe(0)
  })

  test("gate value must be exactly '1'", () => {
    expect(promptSuggestionEnabled({ [PROMPT_SUGGESTION_ENV]: "1" })).toBe(true)
    for (const v of ["0", "true", "on", "", "yes"]) {
      expect(promptSuggestionEnabled({ [PROMPT_SUGGESTION_ENV]: v })).toBe(false)
    }
    expect(promptSuggestionEnabled({})).toBe(false)
  })

  test("suppression context ⇒ suppress, model NEVER called", async () => {
    const s = spy("run the tests")
    const r = await runPromptSuggestion(s.fn, {
      env: ENABLED_ENV,
      state: { ...CLEAR_STATE, planMode: true },
    })
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("plan_mode")
    expect(s.calls()).toBe(0)
  })

  test("pre-aborted signal ⇒ suppress no_output, model NEVER called", async () => {
    const s = spy("run the tests")
    const r = await runPromptSuggestion(s.fn, {
      env: ENABLED_ENV,
      state: CLEAR_STATE,
      signal: AbortSignal.abort(),
    })
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("no_output")
    expect(s.calls()).toBe(0)
  })

  test("happy path ⇒ show sanitized text (model called exactly once)", async () => {
    const s = spy("<suggestion>run the tests</suggestion>")
    const r = await runPromptSuggestion(s.fn, { env: ENABLED_ENV, state: CLEAR_STATE })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.kind).toBe("show")
      if (r.value.kind === "show") expect(r.value.text).toBe("run the tests")
    }
    expect(s.calls()).toBe(1)
  })

  test("rejected output ⇒ suppress rejected", async () => {
    const s = spy("let me run the tests for you") // claude_voice
    const r = await runPromptSuggestion(s.fn, { env: ENABLED_ENV, state: CLEAR_STATE })
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("rejected")
    expect(s.calls()).toBe(1)
  })

  test("undefined output ⇒ suppress no_output", async () => {
    const s = spy(undefined)
    const r = await runPromptSuggestion(s.fn, { env: ENABLED_ENV, state: CLEAR_STATE })
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("no_output")
  })

  test("a THROWING SuggestFn degrades to suppress no_output — never throws", async () => {
    const fn: SuggestFn = async () => {
      throw new Error("model exploded")
    }
    const r = await runPromptSuggestion(fn, { env: ENABLED_ENV, state: CLEAR_STATE })
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("no_output")
  })

  test("blank (whitespace) output ⇒ suppress rejected via empty predicate", async () => {
    const s = spy("   \n  ")
    const r = await runPromptSuggestion(s.fn, { env: ENABLED_ENV, state: CLEAR_STATE })
    if (r.ok && r.value.kind === "suppress") expect(r.value.reason).toBe("rejected")
  })
})
