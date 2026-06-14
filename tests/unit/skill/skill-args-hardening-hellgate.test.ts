/**
 * SOTA++ HARDENING hellgate for `jun7-skill-args-template`
 * (Skill `$ARGUMENTS`/`$N` interpolation, src/skill/skill-tool.ts).
 *
 * Complements skill-args-hellgate.test.ts with teeth aimed at the SPECIFIC
 * implementation choices in `interpolateSkillArgs`:
 *   - a FUNCTION replacer (not a replacement string), so `$&`/`$$`/`` $` ``/`$'`
 *     in args are NOT re-expanded by String.replace's special-pattern handling.
 *   - a SINGLE regex pass, so inserted text is never re-scanned.
 *   - the `input.args !== undefined` gate (NOT a truthy gate), so `args:""`
 *     still interpolates.
 *   - `$ARGUMENTS` = whole TRIMMED string (internal whitespace preserved).
 *   - no literal-dollar `$$` escape (pinned current contract).
 */

import { describe, expect, test } from "bun:test"
import { createSkillTool, interpolateSkillArgs } from "@/../src/skill/skill-tool"
import type { Skill } from "@/../src/skill/types"
import type { ToolContext, ToolEvent } from "@/tool"

const skill = (body: string): Skill =>
  ({ name: "demo", description: "d", body }) as unknown as Skill

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as ToolContext

const run = async (body: string, input: unknown): Promise<string> => {
  const tool = createSkillTool([skill(body)])
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx())) last = ev
  if (last?.type !== "result") throw new Error("no result")
  return last.result.output
}

describe("HARD-ARGS-1 — function-replacer guard (String.replace special patterns)", () => {
  test("$&, $`, $$, $' in args are inserted VERBATIM, never re-expanded", () => {
    // INVARIANT: the impl passes a FUNCTION as the 2nd arg to .replace(), whose
    // return value is inserted LITERALLY — String.replace special replacement
    // patterns ($&, $`, $$, $') apply ONLY to a replacement *string*.
    // MUTATION: refactor to `body.replace(re, all)` (string replacement) would
    // re-expand `$&`→whole match, `$$`→`$`, etc. — this would NOT be verbatim.
    expect(interpolateSkillArgs("$ARGUMENTS", "$& $` $$ $'")).toBe("$& $` $$ $'")
  })

  test("$N with args containing $& is inserted literally, not the matched text", () => {
    // args = "$& X" → positional 1 = "$&". `[$1]` must become `[$&]`, NOT `[$1]`
    // (which is what a string-replacement `$&`-expansion of positional 1 yields).
    // INVARIANT: function replacer; MUTATION: string-replacement refactor → `[$1]`.
    expect(interpolateSkillArgs("[$1]", "$& X")).toBe("[$&]")
  })
})

describe("HARD-ARGS-2 — single-pass (inserted text never re-scanned)", () => {
  test("inserted $ARGUMENTS literal from a positional is NOT re-expanded", () => {
    // args = "$ARGUMENTS Y" → positional 1 = "$ARGUMENTS". `[$1]` → `[$ARGUMENTS]`.
    // INVARIANT: one .replace() pass; the inserted `$ARGUMENTS` token is part of
    // the OUTPUT and is not re-scanned. MUTATION: a chained second .replace()
    // for $ARGUMENTS would turn this into `[$ARGUMENTS Y]` (the whole args).
    expect(interpolateSkillArgs("[$1]", "$ARGUMENTS Y")).toBe("[$ARGUMENTS]")
  })

  test("mixed body: $ARGUMENTS expansion is not re-scanned for $N", () => {
    // args = "$2 $1": positional 1 = "$2", positional 2 = "$1".
    // $ARGUMENTS → whole literal "$2 $1"; $1 → positional 1 = "$2".
    // INVARIANT: single pass. MUTATION: two-pass replace would re-expand the
    // "$2"/"$1" the first pass inserted, scrambling the result.
    expect(interpolateSkillArgs("a=$ARGUMENTS b=$1", "$2 $1")).toBe("a=$2 $1 b=$2")
  })
})

describe("HARD-ARGS-3 — empty-string args runs interpolation (defined-gate, not truthy)", () => {
  test("createSkillTool with args:'' interpolates (does NOT fall back to verbatim)", async () => {
    // INVARIANT: createSkillTool gates on `input.args !== undefined`, so an
    // EMPTY string still routes through interpolateSkillArgs: $ARGUMENTS → ""
    // and out-of-range $1 → "".  MUTATION: a truthy gate (`if (input.args)`)
    // would treat "" as absent and emit the body VERBATIM → "x=$ARGUMENTS [$1]".
    const out = await run("x=$ARGUMENTS [$1]", { name: "demo", args: "" })
    expect(out).toContain("x= []")
    // Negative tooth: the un-interpolated literals must be GONE.
    expect(out).not.toContain("$ARGUMENTS")
    expect(out).not.toContain("[$1]")
  })

  test("absent args (no key) DOES fall back to verbatim body", async () => {
    // Paired control for the gate: undefined ⇒ verbatim, distinguishing the
    // `!== undefined` gate from a hypothetical always-interpolate mutation.
    const out = await run("x=$ARGUMENTS [$1]", { name: "demo" })
    expect(out).toContain("x=$ARGUMENTS [$1]")
  })
})

describe("HARD-ARGS-4 — $ARGUMENTS preserves internal whitespace, trims ends only", () => {
  test("internal tab/newline kept; leading+trailing stripped", () => {
    // INVARIANT: `all = args.trim()` only strips the ENDS; interior bytes are
    // verbatim. MUTATION: a `.replace(/\s+/g," ")` normalization, or trimming
    // each positional join, would collapse the tab/newline.
    expect(interpolateSkillArgs("[$ARGUMENTS]", "  a\tb\n c  ")).toBe("[a\tb\n c]")
  })
})

describe("HARD-ARGS-5 — $N boundary semantics (1-based, multi-digit, leading-zero)", () => {
  const args5 = "w1 w2 w3 w4 w5" // positionals 1..5

  test("1-based: $1 is first, in-range works", () => {
    // INVARIANT: idx>=1 && idx<=len. MUTATION: 0-based off-by-one → wrong token.
    expect(interpolateSkillArgs("$1|$5", args5)).toBe("w1|w5")
  })

  test("$0 → '' (1-indexed lower bound)", () => {
    // INVARIANT: idx>=1 guard. MUTATION: `idx>=0` would let $0 read positionals[-1].
    expect(interpolateSkillArgs("[$0]", args5)).toBe("[]")
  })

  test("out-of-range $N → ''", () => {
    // INVARIANT: idx<=len guard. MUTATION: dropping the upper bound → "undefined".
    expect(interpolateSkillArgs("[$6]", args5)).toBe("[]")
  })

  test("$10 is positional 10 (multi-digit \\d+), not $1 then literal 0", () => {
    const args10 = Array.from({ length: 10 }, (_, i) => `t${i + 1}`).join(" ")
    // INVARIANT: regex captures `\d+`. MUTATION: a single-digit `\d` would parse
    // `$10` as `$1` + literal "0" → "t10" with the "0" stripped, i.e. "t1" + "0".
    expect(interpolateSkillArgs("$10", args10)).toBe("t10")
  })

  test("leading-zero $01 → positional 1 (Number('01')===1)", () => {
    // INVARIANT: Number(d) coerces "01"→1. MUTATION: a strict /^[1-9]\d*$/ index
    // regex would leave "$01" as a non-match → literal "$01".
    expect(interpolateSkillArgs("$01", args5)).toBe("w1")
  })
})

describe("HARD-ARGS-6 — large positional count (no silent cap)", () => {
  const big = Array.from({ length: 1000 }, (_, i) => `p${i + 1}`).join(" ")

  test("$1000 resolves the 1000th positional; $1001 → ''", () => {
    // INVARIANT: split has no length ceiling; bound check uses real length.
    // MUTATION: any hard cap (e.g. slice(0,256)) would make $1000 empty.
    expect(interpolateSkillArgs("[$1000]", big)).toBe("[p1000]")
    expect(interpolateSkillArgs("[$1001]", big)).toBe("[]")
  })
})

describe("HARD-ARGS-7 — unicode positionals & whole-args", () => {
  test("multibyte/emoji positionals and $ARGUMENTS survive intact", () => {
    // INVARIANT: split(/\s+/) is codepoint-safe; JS strings carry the bytes
    // through .replace unchanged. MUTATION: an ASCII-only split or byte-index
    // slice would corrupt "café"/"日本語🎉".
    expect(interpolateSkillArgs("$1|$2|$ARGUMENTS", "café 日本語🎉")).toBe(
      "café|日本語🎉|café 日本語🎉",
    )
  })
})

describe("HARD-ARGS-8 — $$ has NO literal-dollar escape (pinned contract)", () => {
  test("$$ARGUMENTS → '$'+expansion; $$1 → '$'+expansion", () => {
    // INVARIANT (DOCUMENTING current behavior): the regex matches `$ARGUMENTS`
    // / `$\d+`; a leading extra `$` is just a literal char before the match.
    // So `$$ARGUMENTS` = "$" + ($ARGUMENTS→"a b") = "$a b"; `$$1` = "$" + ("a").
    // This test FLIPS INTENTIONALLY if `$$`→`$` escaping is ever added — at
    // which point update the contract here and in skill-tool.ts together.
    expect(interpolateSkillArgs("$$ARGUMENTS", "a b")).toBe("$a b")
    expect(interpolateSkillArgs("$$1", "a b")).toBe("$a")
  })
})
