/**
 * HELLGATE — AFK away-summary (ADR-0465).
 *
 * Proves the happy path AND every failure / silence mode of the recap slice:
 *   - HAPPY: gate ON + real activity → ok recap (trimmed), summarizer called
 *     ONCE with the VERBATIM prompt and the transcript.
 *   - GATE-OFF byte-identity: flag unset / wrong value ("0","on","true",
 *     missing) → `gate-off` skip and the summarizer is NEVER invoked (zero
 *     LLM calls — the default-OFF deployment is byte-identical to today).
 *   - EMPTY / fresh conversation: no prior assistant content → `no-activity`
 *     skip, summarizer never called.
 *   - TOOLS-DENIED ENFORCEMENT: the slice owns no tool surface and passes
 *     ONLY {system, transcript, signal} to the injected SummarizeFn — there is
 *     no path by which a tool could be invoked from here (the adapter denies
 *     tools; the slice proves it never hands the summarizer anything else).
 *   - SUMMARIZER ERROR → typed `summarizer-error` skip carrying the detail.
 *   - EMPTY RECAP → `empty-recap` skip (blank/whitespace text).
 *   - ABORT: pre-aborted signal → `aborted` skip, summarizer never called;
 *     summarizer Err while signal aborted → `aborted` (more specific than
 *     summarizer-error).
 *
 * Pure unit test — no network, no real LLM; the SummarizeFn is a spy double.
 */
import { describe, expect, test } from "bun:test"
import {
  AWAY_SUMMARY_ENV,
  AWAY_SUMMARY_MAX_WORDS,
  AWAY_SUMMARY_SYSTEM_PROMPT,
  awaySummaryEnabled,
  describeSkip,
  type RecapTurn,
  runAwaySummary,
  type SummarizeFn,
  shouldEmit,
} from "@/agent/away-summary"
import { err, ok, type Result } from "@/shared"

const ON = { [AWAY_SUMMARY_ENV]: "1" } as const

const activeTranscript: readonly RecapTurn[] = [
  { role: "user", text: "fix the failing auth test" },
  { role: "assistant", text: "Looking at the token refresh path." },
]

/** A SummarizeFn spy: records every call's args, returns a scripted Result. */
const spySummarizer = (
  result: Result<string, unknown> | (() => Result<string, unknown>),
): {
  fn: SummarizeFn
  calls: { system: string; transcript: readonly RecapTurn[]; signal?: AbortSignal | undefined }[]
} => {
  const calls: {
    system: string
    transcript: readonly RecapTurn[]
    signal?: AbortSignal | undefined
  }[] = []
  const fn: SummarizeFn = async (args) => {
    calls.push({ system: args.system, transcript: args.transcript, signal: args.signal })
    return typeof result === "function" ? result() : result
  }
  return { fn, calls }
}

describe("away-summary HELLGATE — gate", () => {
  test('strict gate: only the exact value "1" enables', () => {
    expect(awaySummaryEnabled(ON)).toBe(true)
    expect(awaySummaryEnabled({})).toBe(false)
    expect(awaySummaryEnabled({ [AWAY_SUMMARY_ENV]: "0" })).toBe(false)
    expect(awaySummaryEnabled({ [AWAY_SUMMARY_ENV]: "on" })).toBe(false)
    expect(awaySummaryEnabled({ [AWAY_SUMMARY_ENV]: "true" })).toBe(false)
    expect(awaySummaryEnabled({ [AWAY_SUMMARY_ENV]: " 1" })).toBe(false)
    expect(awaySummaryEnabled({ [AWAY_SUMMARY_ENV]: undefined })).toBe(false)
  })

  test("env var name mirrors Claude's flag intent", () => {
    expect(AWAY_SUMMARY_ENV).toBe("QUANTA_ENABLE_AWAY_SUMMARY")
  })

  test("GATE-OFF → skip + summarizer NEVER called (byte-identical default)", async () => {
    const spy = spySummarizer(ok("should not appear"))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: {} })
    expect(out).toEqual({ kind: "skip", reason: { kind: "gate-off" } })
    expect(spy.calls.length).toBe(0)
  })
})

describe("away-summary HELLGATE — shouldEmit activity guard", () => {
  test("at least one non-blank assistant turn ⇒ emit", () => {
    expect(shouldEmit(activeTranscript)).toBe(true)
  })

  test("empty transcript ⇒ no emit", () => {
    expect(shouldEmit([])).toBe(false)
  })

  test("only user turns ⇒ no emit (stepped away before any response)", () => {
    expect(shouldEmit([{ role: "user", text: "hello" }])).toBe(false)
  })

  test("only blank assistant turns ⇒ no emit (tool-only turn flattened to '')", () => {
    expect(
      shouldEmit([
        { role: "user", text: "do it" },
        { role: "assistant", text: "   " },
        { role: "assistant", text: "" },
      ]),
    ).toBe(false)
  })
})

describe("away-summary HELLGATE — runner outcomes", () => {
  test("HAPPY: gate ON + activity → ok recap; summarizer called ONCE with VERBATIM prompt", async () => {
    const spy = spySummarizer(ok("  Fixing the auth test; next, patch token refresh.  "))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({ kind: "ok", text: "Fixing the auth test; next, patch token refresh." })
    expect(spy.calls.length).toBe(1)
    // VERBATIM prompt fidelity — load-bearing.
    expect(spy.calls[0]?.system).toBe(AWAY_SUMMARY_SYSTEM_PROMPT)
    expect(AWAY_SUMMARY_SYSTEM_PROMPT).toContain("under 40 words")
    expect(AWAY_SUMMARY_SYSTEM_PROMPT).toContain("no markdown")
    expect(AWAY_SUMMARY_SYSTEM_PROMPT).toContain("the one next action")
    // transcript handed through unchanged.
    expect(spy.calls[0]?.transcript).toBe(activeTranscript)
  })

  test("TOOLS-DENIED: slice hands summarizer ONLY {system,transcript,signal} — no tool surface", async () => {
    const captured: Record<string, unknown> = {}
    const fn: SummarizeFn = async (args) => {
      for (const k of Object.keys(args)) captured[k] = (args as Record<string, unknown>)[k]
      return ok("recap")
    }
    await runAwaySummary(fn, { transcript: activeTranscript, env: ON })
    expect(Object.keys(captured).sort()).toEqual(["signal", "system", "transcript"])
    // No `tools`, no `toolChoice`, no executable surface leaks from the slice.
    expect("tools" in captured).toBe(false)
    expect("toolChoice" in captured).toBe(false)
  })

  test("NO-ACTIVITY: gate ON but empty conversation → skip, summarizer never called", async () => {
    const spy = spySummarizer(ok("nope"))
    const out = await runAwaySummary(spy.fn, { transcript: [], env: ON })
    expect(out).toEqual({ kind: "skip", reason: { kind: "no-activity" } })
    expect(spy.calls.length).toBe(0)
  })

  test("SUMMARIZER ERROR → typed summarizer-error skip with detail", async () => {
    const spy = spySummarizer(err(new Error("model overloaded")))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({
      kind: "skip",
      reason: { kind: "summarizer-error", detail: "model overloaded" },
    })
    expect(spy.calls.length).toBe(1)
  })

  test("SUMMARIZER ERROR (non-Error value) → detail still coerced, no throw", async () => {
    const spy = spySummarizer(err("string failure"))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({
      kind: "skip",
      reason: { kind: "summarizer-error", detail: "string failure" },
    })
  })

  test("SUMMARIZER ERROR (un-stringifiable value) → detail degrades, NEVER throws", async () => {
    // A circular object makes JSON.stringify throw; the no-throw errorDetail
    // MUST catch it and degrade to a fixed string rather than blow the boundary.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const spy = spySummarizer(err(circular))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out.kind).toBe("skip")
    if (out.kind === "skip") {
      expect(out.reason.kind).toBe("summarizer-error")
      if (out.reason.kind === "summarizer-error") {
        expect(out.reason.detail).toBe("unknown summarizer error")
      }
    }
  })

  test("EMPTY RECAP: summarizer returns whitespace → empty-recap skip", async () => {
    const spy = spySummarizer(ok("   \n  "))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({ kind: "skip", reason: { kind: "empty-recap" } })
  })

  test("OVER-BUDGET: recap longer than AWAY_SUMMARY_MAX_WORDS → over-budget skip (never rendered)", async () => {
    const tooLong = Array.from({ length: AWAY_SUMMARY_MAX_WORDS + 5 }, (_, i) => `w${i}`).join(" ")
    const spy = spySummarizer(ok(tooLong))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({
      kind: "skip",
      reason: {
        kind: "over-budget",
        words: AWAY_SUMMARY_MAX_WORDS + 5,
        limit: AWAY_SUMMARY_MAX_WORDS,
      },
    })
  })

  test("AT-BUDGET boundary: exactly AWAY_SUMMARY_MAX_WORDS words → ok (not rejected)", async () => {
    const exact = Array.from({ length: AWAY_SUMMARY_MAX_WORDS }, (_, i) => `w${i}`).join(" ")
    const spy = spySummarizer(ok(exact))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    expect(out).toEqual({ kind: "ok", text: exact })
  })

  test("OVER-BUDGET counts words on the TRIMMED text (surrounding whitespace doesn't inflate)", async () => {
    const padded = `   ${Array.from({ length: AWAY_SUMMARY_MAX_WORDS }, (_, i) => `w${i}`).join("  ")}   `
    const spy = spySummarizer(ok(padded))
    const out = await runAwaySummary(spy.fn, { transcript: activeTranscript, env: ON })
    // collapses to exactly the budget after trim + multi-space split ⇒ ok.
    expect(out.kind).toBe("ok")
  })
})

describe("away-summary HELLGATE — abort", () => {
  test("pre-aborted signal → aborted skip, summarizer NEVER called", async () => {
    const spy = spySummarizer(ok("late"))
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await runAwaySummary(spy.fn, {
      transcript: activeTranscript,
      env: ON,
      signal: ctrl.signal,
    })
    expect(out).toEqual({ kind: "skip", reason: { kind: "aborted" } })
    expect(spy.calls.length).toBe(0)
  })

  test("summarizer OK WHILE signal aborted late → aborted skip (stale recap discarded, not rendered)", async () => {
    const ctrl = new AbortController()
    // Summarizer resolves SUCCESSFULLY but the user already returned (signal
    // aborted mid-flight). A recap that lands after return is stale → discard.
    const fn: SummarizeFn = async (args) => {
      ctrl.abort()
      void args
      return ok("Fixing the auth test; next, patch token refresh.")
    }
    const out = await runAwaySummary(fn, {
      transcript: activeTranscript,
      env: ON,
      signal: ctrl.signal,
    })
    expect(out).toEqual({ kind: "skip", reason: { kind: "aborted" } })
  })

  test("summarizer Err WHILE signal aborted → aborted (more specific than summarizer-error)", async () => {
    const ctrl = new AbortController()
    // Summarizer aborts mid-flight and reports Err; signal is aborted by then.
    const fn: SummarizeFn = async (args) => {
      ctrl.abort()
      void args
      return err(new Error("aborted by signal"))
    }
    const out = await runAwaySummary(fn, {
      transcript: activeTranscript,
      env: ON,
      signal: ctrl.signal,
    })
    expect(out).toEqual({ kind: "skip", reason: { kind: "aborted" } })
  })
})

describe("away-summary HELLGATE — describeSkip narrator", () => {
  test("each outcome maps to a stable human string", () => {
    expect(describeSkip({ kind: "ok", text: "x" })).toBe("recap produced")
    expect(describeSkip({ kind: "skip", reason: { kind: "gate-off" } })).toContain(AWAY_SUMMARY_ENV)
    expect(describeSkip({ kind: "skip", reason: { kind: "no-activity" } })).toContain("no prior")
    expect(
      describeSkip({ kind: "skip", reason: { kind: "summarizer-error", detail: "boom" } }),
    ).toContain("boom")
    expect(describeSkip({ kind: "skip", reason: { kind: "aborted" } })).toContain("aborted")
    expect(describeSkip({ kind: "skip", reason: { kind: "empty-recap" } })).toContain("blank")
    expect(
      describeSkip({ kind: "skip", reason: { kind: "over-budget", words: 99, limit: 40 } }),
    ).toContain("99 > 40")
  })
})
