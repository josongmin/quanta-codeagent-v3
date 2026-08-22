import { describe, expect, test } from "bun:test"
import {
  buildChooserPrompt,
  buildReviewerPrompt,
  chooseBestCandidate,
  type LlmSelectCandidate,
  parseChooserIndex,
  parseReviewerScore,
  reviewBestCandidate,
} from "./llm-candidate-select"

const cand = (id: number, extra: Partial<LlmSelectCandidate> = {}): LlmSelectCandidate => ({
  id,
  patch: `diff --git a/f${id}.py b/f${id}.py\n+x`,
  touchedFiles: [`f${id}.py`],
  reproPass: false,
  regressionFailures: 0,
  ...extra,
})

describe("parseChooserIndex — tolerant, fail-open", () => {
  const valid = new Set([0, 1, 2])
  test("`BEST: <id>` ⇒ that id", () => {
    expect(parseChooserIndex("reasoning...\nBEST: 2", valid)).toBe(2)
    expect(parseChooserIndex("BEST:0", valid)).toBe(0)
  })
  test("invalid/absent `BEST:` id ⇒ null (NO free-integer fallback)", () => {
    // B3: the free-integer fallback laundered any stray digit in prose into a
    // "selection". Dropped — only an explicit, VALID `BEST: <id>` selects; anything
    // else fails open to null so the caller keeps the deterministic winner.
    expect(parseChooserIndex("I pick candidate 1 finally", valid)).toBeNull() // no BEST: line ⇒ null
    expect(parseChooserIndex("BEST: 9 — actually candidate 2", valid)).toBeNull() // 9 invalid, no fallback ⇒ null
    expect(parseChooserIndex("BEST: 9", valid)).toBeNull() // only invalid id present ⇒ null
    expect(parseChooserIndex("no number here", valid)).toBeNull()
    expect(parseChooserIndex("BEST: 7", new Set([0]))).toBeNull()
  })
})

describe("parseReviewerScore — clamp [0,1], fail-open", () => {
  test("parses + clamps", () => {
    expect(parseReviewerScore("SCORE: 0.8")).toBeCloseTo(0.8)
    expect(parseReviewerScore("SCORE: 1")).toBe(1)
    expect(parseReviewerScore("SCORE: .3")).toBeCloseTo(0.3)
  })
  test("no score ⇒ null", () => {
    expect(parseReviewerScore("the patch looks good")).toBeNull()
  })
  // B4: the old regex `[01](?:\.\d+)?|0?\.\d+` matched a PREFIX of an
  // out-of-range value — `SCORE: 0.85` matched `0.85` fine, but `SCORE: 85`
  // matched only the leading `8`? no: it matched nothing (8 not in [01]) →
  // NULL, silently DROPPING a valid-but-out-of-range score, and a model that
  // answers on a 0..100 or percent scale was discarded entirely. General
  // numeric parse + clamp + %-handling recovers those.
  test("general numeric clamp — out-of-range values clamp, not drop", () => {
    expect(parseReviewerScore("SCORE: 2")).toBe(1) // >1 ⇒ clamp to 1 (was: null)
    expect(parseReviewerScore("SCORE: 42")).toBe(1) // 0..100 scale ⇒ clamp to 1 (was: null)
    expect(parseReviewerScore("SCORE: -0.5")).toBe(0) // <0 ⇒ clamp to 0
    expect(parseReviewerScore("SCORE: 1.7")).toBe(1) // >1 ⇒ clamp to 1 (was: null)
  })
  test("percent handling — `<n>%` normalizes to [0,1]", () => {
    expect(parseReviewerScore("SCORE: 85%")).toBeCloseTo(0.85) // percent ⇒ /100
    expect(parseReviewerScore("SCORE: 100%")).toBe(1)
    expect(parseReviewerScore("SCORE: 0%")).toBe(0)
    expect(parseReviewerScore("SCORE: 150%")).toBe(1) // >100% ⇒ clamp
  })
  test("non-numeric SCORE ⇒ null (fail-open preserved)", () => {
    expect(parseReviewerScore("SCORE: high")).toBeNull()
    expect(parseReviewerScore("SCORE:")).toBeNull()
  })
})

describe("buildChooserPrompt", () => {
  test("includes every candidate id + the issue + the BEST: instruction", () => {
    const p = buildChooserPrompt([cand(0), cand(1)], "the bug is X")
    expect(p).toContain("candidate 0")
    expect(p).toContain("candidate 1")
    expect(p).toContain("the bug is X")
    expect(p).toContain("BEST:")
  })
})

describe("renderCandidate evidence — conditional, byte-identical when absent", () => {
  test("no evidence ⇒ prompt has no evidence sections", () => {
    const p = buildChooserPrompt([cand(0), cand(1)], "bug")
    expect(p).not.toContain("verify_command")
    expect(p).not.toContain("failure_output")
    expect(p).not.toContain("agent_actions")
  })
  test("actionSummary present ⇒ agent-actions section appears (reviewer trajectory parity)", () => {
    const p = buildReviewerPrompt(
      cand(0, { actionSummary: "read core.py\nedit core.py\nbash pytest" }),
      "bug",
    )
    expect(p).toContain("agent_actions (redacted, recent):")
    expect(p).toContain("edit core.py")
    expect(p).toContain("bash pytest")
  })
  test("verifyCmd present ⇒ command section appears", () => {
    const p = buildReviewerPrompt(cand(0, { verifyCmd: "pytest tests/test_x.py -k foo" }), "bug")
    expect(p).toContain("verify_command: pytest tests/test_x.py -k foo")
    expect(p).not.toContain("failure_output")
  })
  test("failureOutput present ⇒ failure section appears verbatim", () => {
    const p = buildReviewerPrompt(cand(0, { failureOutput: "E   assert 3 == 4\n1 failed" }), "bug")
    expect(p).toContain("failure_output (redacted, tail):")
    expect(p).toContain("E   assert 3 == 4")
    expect(p).toContain("1 failed")
  })
  test("both present ⇒ both sections; empty/whitespace evidence is omitted", () => {
    const p = buildReviewerPrompt(cand(0, { verifyCmd: "tox -e py39", failureOutput: "  " }), "bug")
    expect(p).toContain("verify_command: tox -e py39")
    expect(p).not.toContain("failure_output") // whitespace-only ⇒ omitted
  })
  test("chooser prompt carries per-candidate evidence", () => {
    const p = buildChooserPrompt(
      [cand(0, { verifyCmd: "pytest a" }), cand(1, { failureOutput: "boom" })],
      "bug",
    )
    expect(p).toContain("verify_command: pytest a")
    expect(p).toContain("boom")
  })
})

describe("chooseBestCandidate — fail-open never-veto", () => {
  test("picks the model-chosen admissible id", async () => {
    const id = await chooseBestCandidate([cand(0), cand(1), cand(2)], "bug", async () => "BEST: 2")
    expect(id).toBe(2)
  })
  test("<2 candidates ⇒ null (keep deterministic winner)", async () => {
    expect(await chooseBestCandidate([cand(0)], "bug", async () => "BEST: 0")).toBeNull()
  })
  test("ask throws ⇒ null (fail-open)", async () => {
    expect(
      await chooseBestCandidate([cand(0), cand(1)], "bug", async () => {
        throw new Error("llm down")
      }),
    ).toBeNull()
  })
  test("unparseable response ⇒ null (fail-open to deterministic)", async () => {
    expect(await chooseBestCandidate([cand(0), cand(1)], "bug", async () => "dunno")).toBeNull()
  })
})

describe("reviewBestCandidate — highest score, ties→lowest id, per-candidate fail-open", () => {
  test("highest score wins", async () => {
    const ask = async (p: string): Promise<string> =>
      p.includes("candidate 1") ? "SCORE: 0.9" : "SCORE: 0.2"
    expect(await reviewBestCandidate([cand(0), cand(1)], "bug", ask)).toBe(1)
  })
  test("a candidate whose score fails to parse is skipped, not fatal", async () => {
    const ask = async (p: string): Promise<string> =>
      p.includes("candidate 0") ? "garbage" : "SCORE: 0.5"
    expect(await reviewBestCandidate([cand(0), cand(1)], "bug", ask)).toBe(1)
  })
  test("all unscored ⇒ null", async () => {
    expect(await reviewBestCandidate([cand(0), cand(1)], "bug", async () => "nope")).toBeNull()
  })
})
