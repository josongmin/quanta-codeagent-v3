/**
 * ADR-0418 — `@file` / `@symbol` parser cascade hellgate.
 *
 * Supersedes ADR-0413's `parser-file.hellgate.test.ts` (the `@file:`
 * explicit-prefix syntax is dropped; classification is now purely the
 * deterministic §4 cascade: slash→file, uppercase→symbol,
 * lowercase+dot→file, lowercase-kebab→skill).
 *
 *   A. slash → file (priority 2)                       (5)
 *   B. uppercase → symbol (priority 3)                 (6)
 *   C. lowercase + dot → file (priority 4)             (4)
 *   D. priority tie-break / verbatim ADR examples      (4)
 *   E. left-boundary / false positives                 (4)
 *   F. dedup + span + mixed-kind order                 (4)
 *
 * Total = 27 cases (>= the required 25). The 3-kind subset
 * (skill/plugin/app) is proven byte-identical in parser.hellgate.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { parseMentions } from "../parser"

describe("parseMentions @file/@symbol cascade — ADR-0418 hellgate", () => {
  // -------- A. slash → file (priority 2) -----------------------------

  test("A1 — @src/agent/loop.ts ⇒ file, full path", () => {
    const out = parseMentions("read @src/agent/loop.ts now")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("src/agent/loop.ts")
    expect(out[0]?.raw).toBe("@src/agent/loop.ts")
  })

  test("A2 — @./Foo ⇒ file (slash wins over uppercase-symbol)", () => {
    const out = parseMentions("see @./Foo")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("./Foo")
  })

  test("A3 — @docs/decisions/ trailing slash ⇒ file", () => {
    const out = parseMentions("@docs/decisions/")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("docs/decisions/")
  })

  test("A4 — mixed-case path component is a file, not rejected as non-kebab", () => {
    const out = parseMentions("@src/MyComponent.tsx")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("src/MyComponent.tsx")
  })

  test("A5 — @../sibling/x.ts (parent traversal) parses as file (jail is resolver's job)", () => {
    const out = parseMentions("@../sibling/x.ts")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("../sibling/x.ts")
  })

  // -------- B. uppercase → symbol (priority 3) -----------------------

  test("B1 — @FooBar ⇒ symbol", () => {
    const out = parseMentions("look at @FooBar")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("FooBar")
    expect(out[0]?.raw).toBe("@FooBar")
  })

  test("B2 — @MyClass.method ⇒ symbol with one .member suffix", () => {
    const out = parseMentions("@MyClass.method")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("MyClass.method")
  })

  test("B3 — @Foo.bar ⇒ symbol (ADR §4 verbatim: uppercase + .member)", () => {
    const out = parseMentions("@Foo.bar")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("Foo.bar")
  })

  test("B4 — @Code-Review ⇒ symbol `Code` (`-` not in symbol alphabet, stops)", () => {
    const out = parseMentions("@Code-Review")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("Code")
  })

  test("B5 — @Foo.bar.baz ⇒ symbol stops after ONE member (`Foo.bar`)", () => {
    const out = parseMentions("@Foo.bar.baz")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("Foo.bar")
  })

  test("B6 — @README.md ⇒ symbol `README.md` (uppercase wins over dot-file rule)", () => {
    const out = parseMentions("see @README.md")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.target).toBe("README.md")
  })

  // -------- C. lowercase + dot → file (priority 4) -------------------

  test("C1 — @a.b ⇒ file (ADR §4 verbatim: lowercase start + contains dot)", () => {
    const out = parseMentions("@a.b")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("a.b")
  })

  test("C2 — @foo.ts ⇒ file (lowercase dotted token)", () => {
    const out = parseMentions("@foo.ts")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("foo.ts")
  })

  test("C3 — @config.test.json ⇒ file (multiple dots, no slash)", () => {
    const out = parseMentions("@config.test.json")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("config.test.json")
  })

  test("C4 — @./.gitignore (leading dot reached via slash) ⇒ file", () => {
    // A bare leading-dot token (`@.gitignore`) is NOT classified — the
    // priority-4 rule requires a LOWERCASE-letter start (ADR §4: "dot +
    // lowercase-start → file"), and priority-2 needs a slash. The natural
    // workspace form `@./.gitignore` carries a slash ⇒ file (priority 2).
    expect(parseMentions("@.gitignore")).toEqual([])
    const out = parseMentions("@./.gitignore")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("./.gitignore")
  })

  // -------- D. priority tie-break / verbatim ADR examples ------------

  test("D1 — @code-review (no / no .) stays SKILL (priority 5)", () => {
    const out = parseMentions("run @code-review")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("skill")
    expect(out[0]?.target).toBe("code-review")
  })

  test("D2 — slash beats dot+lowercase: @a/b.c ⇒ file (slash priority 2 first)", () => {
    const out = parseMentions("@a/b.c")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("a/b.c")
  })

  test("D3 — plugin://github stays plugin (independent of @-cascade)", () => {
    const out = parseMentions("use plugin://github")
    expect(out[0]?.kind).toBe("plugin")
  })

  test("D4 — @@chrome stays app (double-@ matched first, not file/symbol)", () => {
    const out = parseMentions("open @@chrome")
    expect(out[0]?.kind).toBe("app")
  })

  // -------- E. left-boundary / false positives -----------------------

  test("E1 — email foo@bar.com is NOT a mention (word-char left boundary)", () => {
    expect(parseMentions("mail foo@bar.com please")).toEqual([])
  })

  test("E2 — word-internal xx@src/y.ts is NOT a mention", () => {
    expect(parseMentions("xx@src/y.ts")).toEqual([])
  })

  test("E3 — bare @ followed by space is not a file/symbol mention", () => {
    expect(parseMentions("@ /not/a/path")).toEqual([])
  })

  test("E4 — @123/x (number-leading) is NOT a mention (alphabet starts letter/_/./~)", () => {
    expect(parseMentions("@123/x")).toEqual([])
  })

  // -------- F. dedup + span + mixed-kind order -----------------------

  test("F1 — same file mentioned twice dedups (FIRST span kept)", () => {
    const text = "@src/x.ts and again @src/x.ts"
    const out = parseMentions(text)
    expect(out).toHaveLength(1)
    expect(out[0]?.span.start).toBe(0)
    expect(text.slice(out[0]?.span.start ?? 0, out[0]?.span.end ?? 0)).toBe("@src/x.ts")
  })

  test("F2 — span.end - span.start === raw.length for file & symbol", () => {
    const out = parseMentions("hi @src/deep/file.ts and @MyClass.run there")
    expect(out).toHaveLength(2)
    for (const m of out) {
      expect(m.span.end - m.span.start).toBe(m.raw.length)
    }
  })

  test("F3 — file, symbol, skill, plugin, app preserve textual order", () => {
    const out = parseMentions("@src/a.ts @Foo @review plugin://gh @@browser")
    expect(out.map((m) => m.kind)).toEqual(["file", "symbol", "skill", "plugin", "app"])
  })

  test("F4 — distinct file + symbol with same lexical target stay distinct kinds", () => {
    // `@Foo` (symbol) vs `@foo.ts` (file) — different kinds AND different
    // targets, both survive dedup.
    const out = parseMentions("@Foo then @foo.ts")
    expect(out).toHaveLength(2)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[1]?.kind).toBe("file")
  })
})
