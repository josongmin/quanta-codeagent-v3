import { describe, expect, it } from "bun:test"
import { diffTouchedSymbols } from "@/runner/batch/eval/diff-touched-symbols"

/**
 * REAL unified-diff strings. The hellgate's whole point: a BODY edit whose hunk
 * header carries the enclosing signature (`@@ … @@ def foo(...)`) but no
 * `+def foo` declaration line must STILL surface `foo`.
 */

/** Body-only edit of `def foo` — header context names it, no `+def foo` line. */
const bodyEditFoo = (file = "pkg/mod.py"): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -10,3 +10,3 @@ def foo(self, x):\n" +
  "     y = x + 1\n" +
  "-    return y\n" +
  "+    return y * 2\n"

/** Adds a brand-new `def bar` (declaration on a `+` line). */
const addsBar = (file = "pkg/mod.py"): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,2 +1,5 @@\n" +
  " x = 1\n" +
  "+def bar():\n" +
  "+    return 7\n"

/** Adds a `class Baz`. */
const addsClassBaz = (file = "pkg/mod.py"): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,1 +1,3 @@\n" +
  " import os\n" +
  "+class Baz:\n" +
  "+    pass\n"

/** Pure data / comment change inside no recognizable enclosing symbol. */
const pureDataChange = (file = "pkg/data.py"): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,3 +1,3 @@\n" +
  " VALUES = [\n" +
  "-    1, 2, 3,\n" +
  "+    1, 2, 4,  # tweaked\n" +
  " ]\n"

describe("diffTouchedSymbols", () => {
  it("HELLGATE: body edit of `def foo` (header context only, no +def line) STILL yields foo", () => {
    const patch = bodyEditFoo()
    // teeth: prove there is genuinely NO `+def foo` declaration line — the only
    // source of `foo` is the enclosing-signature hunk-header context.
    expect(patch.includes("+def foo")).toBe(false)
    expect(patch.includes("@@ -10,3 +10,3 @@ def foo")).toBe(true)
    expect(diffTouchedSymbols(patch)).toEqual(["foo"])
  })

  it("a patch that ADDS `def bar` yields bar", () => {
    const patch = addsBar()
    // teeth: bar comes ONLY from the `+def bar` line, not a header context.
    expect(patch.includes("@@ -1,2 +1,5 @@\n")).toBe(true)
    expect(diffTouchedSymbols(patch)).toEqual(["bar"])
  })

  it("a patch touching `class Baz` yields Baz", () => {
    expect(diffTouchedSymbols(addsClassBaz())).toEqual(["Baz"])
  })

  it("empty patch => []", () => {
    expect(diffTouchedSymbols("")).toEqual([])
  })

  it("a pure data/comment change yields [] (does not hallucinate symbols)", () => {
    const patch = pureDataChange()
    // teeth: the patch really does mutate lines (non-trivial), yet no symbol.
    expect(patch.includes("+    1, 2, 4,")).toBe(true)
    expect(diffTouchedSymbols(patch)).toEqual([])
  })

  it("dedups + is stably sorted, and identical across two calls (deterministic)", () => {
    // class Baz before def foo before def bar across multiple file sections;
    // foo appears via BOTH a header context AND a `-def foo` line (dedup proof).
    const patch =
      bodyEditFoo("pkg/a.py") +
      addsBar("pkg/b.py") +
      addsClassBaz("pkg/c.py") +
      // a section where `def foo` is also a removed declaration line:
      "diff --git a/pkg/d.py b/pkg/d.py\n" +
      "--- a/pkg/d.py\n" +
      "+++ b/pkg/d.py\n" +
      "@@ -5,2 +5,1 @@ class Outer:\n" +
      "-def foo():\n" +
      "-    return 1\n"

    const first = diffTouchedSymbols(patch)
    const second = diffTouchedSymbols(patch)
    // sorted, deduped (foo seen 3x → once), Outer captured from header context.
    expect(first).toEqual(["Baz", "Outer", "bar", "foo"])
    // stable + deterministic across calls.
    expect(second).toEqual(first)
  })

  it("captures the enclosing class from a method body edit (qualified context)", () => {
    // git can emit a method-qualified enclosing context; we surface a name.
    const patch =
      "diff --git a/pkg/m.py b/pkg/m.py\n" +
      "--- a/pkg/m.py\n" +
      "+++ b/pkg/m.py\n" +
      "@@ -20,3 +20,3 @@ class Widget:\n" +
      "     def render(self):\n" +
      "-        return None\n" +
      "+        return self.html\n"
    expect(diffTouchedSymbols(patch)).toEqual(["Widget"])
  })
})
