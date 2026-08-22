/**
 * Skill `$ARGUMENTS`/`$N` interpolation (§22.2) hellgate.
 *
 * Pins the template substitution added to the Skill tool:
 *  - absent `args` ⇒ body verbatim (byte-identical, incl. bodies that contain
 *    a literal `$ARGUMENTS`)
 *  - `$ARGUMENTS` → whole string; `$1`/`$2` → positionals; out-of-range → ""
 *  - substitution is inert (result is prompt text, never executed) and an arg
 *    of `"$1"` cannot trigger a second substitution pass
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

describe("HELL-ARGS-1 — pure interpolation", () => {
  test("$ARGUMENTS → whole trimmed string", () => {
    expect(interpolateSkillArgs("run: $ARGUMENTS", "  a b c ")).toBe("run: a b c")
  })

  test("$1/$2 → positionals; out-of-range → empty", () => {
    expect(interpolateSkillArgs("$1 then $2 then $3", "x y")).toBe("x then y then ")
  })

  test("$10 is positional 10, not $1 followed by 0", () => {
    const args = Array.from({ length: 10 }, (_, i) => `w${i + 1}`).join(" ")
    expect(interpolateSkillArgs("$10", args)).toBe("w10")
  })

  test("$0 → empty (1-indexed), $01 → positional 1 (pinned current behavior)", () => {
    expect(interpolateSkillArgs("[$0]", "a b")).toBe("[]")
    expect(interpolateSkillArgs("$01", "a b")).toBe("a")
  })

  test("both placeholders in one body", () => {
    expect(interpolateSkillArgs("all=[$ARGUMENTS] first=$1", "p q")).toBe("all=[p q] first=p")
  })
})

describe("HELL-ARGS-2 — byte-identical opt-out", () => {
  test("absent args ⇒ body verbatim even when body contains $ARGUMENTS", async () => {
    const body = "Literal $ARGUMENTS and $1 stay untouched"
    const out = await run(body, { name: "demo" })
    expect(out).toContain(body)
  })

  test("createSkillTool with args present DOES interpolate", async () => {
    const out = await run("target: $1", { name: "demo", args: "foo.ts" })
    expect(out).toContain("target: foo.ts")
  })
})

describe("HELL-ARGS-3 — injection inertness", () => {
  test("shell metacharacters in args are inert text", () => {
    const out = interpolateSkillArgs("cmd $ARGUMENTS", "; rm -rf / && echo $(whoami)")
    expect(out).toBe("cmd ; rm -rf / && echo $(whoami)")
  })

  test("an arg of '$1' does not get re-substituted on a second pass", () => {
    // positional 1 = "$2", positional 2 = "X". $1 expands to the LITERAL "$2";
    // replace must NOT then expand that inserted "$2" into "X".
    expect(interpolateSkillArgs("[$1]", "$2 X")).toBe("[$2]")
  })

  test("$ARGUMENTS expansion is NOT re-scanned for $N (single-pass, F1 regression)", () => {
    // The whole args string is "$2 X". `$ARGUMENTS` must expand to the LITERAL
    // "$2 X" — a chained two-pass replace would re-expand the inserted "$2"
    // into positional 2 ("X"), yielding the wrong "X X".
    expect(interpolateSkillArgs("$ARGUMENTS", "$2 X")).toBe("$2 X")
    expect(interpolateSkillArgs("all=$ARGUMENTS first=$1", "$3 a b")).toBe("all=$3 a b first=$3")
  })

  test("$ARGUMENTSX (no word boundary) is left untouched", () => {
    expect(interpolateSkillArgs("$ARGUMENTSX and $ARGUMENTS_", "y")).toBe(
      "$ARGUMENTSX and $ARGUMENTS_",
    )
  })

  test("empty args string ⇒ $ARGUMENTS becomes empty, no throw", () => {
    expect(interpolateSkillArgs("x=$ARGUMENTS", "")).toBe("x=")
  })
})
