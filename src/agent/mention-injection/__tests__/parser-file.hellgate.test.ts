/**
 * ADR-0413 — `@file` mention parser hellgate (additive to ADR-0325).
 *
 *   A. @file:<path> explicit prefix              (3)
 *   B. bare @<path> with `/` or `.`              (4)
 *   C. disambiguation vs @skill (no regression)  (4)
 *   D. left-boundary / false positives           (3)
 *   E. mixed file + skill/plugin/app order       (2)
 *   F. dedup + span correctness                  (2)
 *
 * Total = 18 cases (>= the required 15). Existing parser.hellgate.test.ts
 * proves the 3-kind path is byte-identical (no edit there).
 */

import { describe, expect, test } from "bun:test"
import { parseMentions } from "../parser"

describe("parseMentions @file — ADR-0413 hellgate", () => {
  // -------- A. explicit @file: prefix --------------------------------

  test("A1 — @file:src/x.ts ⇒ kind=file, target is the raw path", () => {
    const out = parseMentions("look at @file:src/x.ts please")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("src/x.ts")
    expect(out[0]?.raw).toBe("@file:src/x.ts")
  })

  test("A2 — @file: prefix wins even when path has no slash/dot", () => {
    const out = parseMentions("@file:Makefile")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("Makefile")
  })

  test("A3 — @file: with empty path is NOT a mention", () => {
    expect(parseMentions("@file: here")).toEqual([])
  })

  // -------- B. bare @<path> with `/` or `.` --------------------------

  test("B1 — @src/agent/loop.ts ⇒ file kind, full path target", () => {
    const out = parseMentions("read @src/agent/loop.ts now")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("src/agent/loop.ts")
    expect(out[0]?.raw).toBe("@src/agent/loop.ts")
  })

  test("B2 — @README.md (dot, no slash) ⇒ file kind", () => {
    const out = parseMentions("see @README.md")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("README.md")
  })

  test("B3 — @dir/ (trailing slash) ⇒ file kind, path target", () => {
    const out = parseMentions("@docs/decisions/")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("docs/decisions/")
  })

  test("B4 — mixed-case path component is a file, not rejected as non-kebab", () => {
    const out = parseMentions("@src/MyComponent.tsx")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("src/MyComponent.tsx")
  })

  // -------- C. disambiguation vs @skill (no regression) --------------

  test("C1 — @code-review (no / or .) stays a SKILL, not a file", () => {
    const out = parseMentions("run @code-review")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("skill")
    expect(out[0]?.target).toBe("code-review")
  })

  test("C2 — plugin://github stays plugin even though it has dots-free name", () => {
    const out = parseMentions("use plugin://github")
    expect(out[0]?.kind).toBe("plugin")
  })

  test("C3 — @@chrome stays app (double-@ not file)", () => {
    const out = parseMentions("open @@chrome")
    expect(out[0]?.kind).toBe("app")
  })

  test("C4 — @a/b adjacent to a bare @skill in same input keep distinct kinds", () => {
    const out = parseMentions("@lib/util.ts then @code-review")
    expect(out).toHaveLength(2)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("lib/util.ts")
    expect(out[1]?.kind).toBe("skill")
    expect(out[1]?.target).toBe("code-review")
  })

  // -------- D. left-boundary / false positives -----------------------

  test("D1 — email foo@bar.com is NOT a file mention (word-char left boundary)", () => {
    expect(parseMentions("mail foo@bar.com please")).toEqual([])
  })

  test("D2 — word-internal x@src/y.ts is NOT a mention", () => {
    expect(parseMentions("xx@src/y.ts")).toEqual([])
  })

  test("D3 — bare @ alone is not a file mention", () => {
    expect(parseMentions("@ /not/a/path")).toEqual([])
  })

  // -------- E. mixed file + others order -----------------------------

  test("E1 — file, skill, plugin, app preserve textual order", () => {
    const out = parseMentions("@src/a.ts @review plugin://gh @@browser")
    expect(out.map((m) => m.kind)).toEqual(["file", "skill", "plugin", "app"])
  })

  test("E2 — two distinct file mentions both parsed in order", () => {
    const out = parseMentions("@a/x.ts and @file:b/y.ts")
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.kind)).toEqual(["file", "file"])
    expect(out.map((m) => m.target)).toEqual(["a/x.ts", "b/y.ts"])
  })

  // -------- F. dedup + span correctness ------------------------------

  test("F1 — same file mentioned twice dedups (FIRST span kept)", () => {
    const text = "@src/x.ts and again @src/x.ts"
    const out = parseMentions(text)
    expect(out).toHaveLength(1)
    expect(out[0]?.span.start).toBe(0)
    expect(text.slice(out[0]?.span.start ?? 0, out[0]?.span.end ?? 0)).toBe("@src/x.ts")
  })

  test("F2 — span.end - span.start === raw.length for file mention", () => {
    const out = parseMentions("hi @file:deep/path/to/file.ts there")
    expect(out).toHaveLength(1)
    const m = out[0]
    expect(m).toBeDefined()
    if (m) expect(m.span.end - m.span.start).toBe(m.raw.length)
  })
})
