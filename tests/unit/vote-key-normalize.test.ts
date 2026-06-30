/**
 * Strategy hardening #3 — stronger patch-vote key (Agentless dedup parity). Hard
 * scenarios:
 *  - two patches differing ONLY by a comment / blank line / trailing ws ⇒ SAME key
 *    (they vote together — the capability gap raw-trim missed)
 *  - a real code difference ⇒ DIFFERENT key (never over-merges distinct fixes)
 *  - same edit on DIFFERENT files ⇒ DIFFERENT key (file headers kept)
 *  - whole-line comments stripped, but inline `code # trailing` is NOT split
 *    (conservative — a `#` may be inside a string)
 */

import { describe, expect, test } from "bun:test"
import { strongVoteKey } from "../../src/runner/batch/eval/vote-key-normalize"

const patch = (file: string, body: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}`

describe("strongVoteKey — comment/blank-insensitive dedup (votes reinforce)", () => {
  test("comment-only difference ⇒ SAME key", () => {
    const a = patch("m.py", "+    x = compute()\n+    # explain it\n-    x = old()")
    const b = patch("m.py", "+    x = compute()\n+    # a DIFFERENT comment\n-    x = old()")
    expect(strongVoteKey(a)).toBe(strongVoteKey(b))
  })

  test("blank-line + trailing-whitespace difference ⇒ SAME key", () => {
    const a = patch("m.py", "+    x = compute()   \n+\n-    x = old()")
    const b = patch("m.py", "+    x = compute()\n-    x = old()")
    expect(strongVoteKey(a)).toBe(strongVoteKey(b))
  })

  test("hunk-offset (@@) difference ⇒ SAME key (offsets dropped)", () => {
    const a = `--- a/m.py\n+++ b/m.py\n@@ -1,3 +1,3 @@\n+    fixed()\n-    broken()`
    const b = `--- a/m.py\n+++ b/m.py\n@@ -40,3 +40,3 @@\n+    fixed()\n-    broken()`
    expect(strongVoteKey(a)).toBe(strongVoteKey(b))
  })
})

describe("strongVoteKey — never over-merges (preserves real distinctions)", () => {
  test("a genuine code difference ⇒ DIFFERENT key", () => {
    const a = patch("m.py", "+    x = compute_A()\n-    x = old()")
    const b = patch("m.py", "+    x = compute_B()\n-    x = old()")
    expect(strongVoteKey(a)).not.toBe(strongVoteKey(b))
  })

  test("SAME edit on DIFFERENT files ⇒ DIFFERENT key (file header kept)", () => {
    const a = patch("pkg/one.py", "+    fixed()\n-    broken()")
    const b = patch("pkg/two.py", "+    fixed()\n-    broken()")
    expect(strongVoteKey(a)).not.toBe(strongVoteKey(b))
  })

  test("inline trailing comment is NOT split off (conservative — # may be in a string)", () => {
    const a = patch("m.py", "+    x = compute()  # inline")
    const b = patch("m.py", "+    x = compute()")
    // The inline-comment line is real content (not a whole-line comment), so the two
    // are DISTINCT — we never risk splitting `s = '#'` style code.
    expect(strongVoteKey(a)).not.toBe(strongVoteKey(b))
  })
})
