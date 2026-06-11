/**
 * jun-11 (R3 worklist #12) — pure word/line editing ops for the raw-line reader.
 *
 * The reader's ctrl+w / ctrl+u / ctrl+k / alt+b / alt+f chords need readline-
 * style word/line editing that did not exist (only single-char backspace/delete
 * + Home/End were wired). Extracting the boundary logic into PURE functions
 * makes it unit-testable without driving the raw-mode keypress machine — the
 * reader's onKey branch just calls these. A "word" is a maximal run of
 * non-whitespace; the kill/move ops skip intervening whitespace FIRST (readline
 * / Codex TuiEditorKeymap semantics).
 *
 * RED before line-edit-ops.ts exists; GREEN after.
 */
import { describe, expect, test } from "bun:test"
import {
  deleteWordBefore,
  killToLineEnd,
  killToLineStart,
  wordLeft,
  wordRight,
} from "../../../src/apps/cli/line-edit-ops"

describe("deleteWordBefore (ctrl+w)", () => {
  test("deletes the word immediately before the cursor", () => {
    expect(deleteWordBefore({ buf: "foo bar baz", cursor: 11 })).toEqual({ buf: "foo bar ", cursor: 8 })
  })
  test("skips trailing whitespace then deletes the word", () => {
    expect(deleteWordBefore({ buf: "foo bar   ", cursor: 10 })).toEqual({ buf: "foo ", cursor: 4 })
  })
  test("deletes only up to the cursor, preserving the suffix", () => {
    expect(deleteWordBefore({ buf: "foo bar baz", cursor: 7 })).toEqual({ buf: "foo  baz", cursor: 4 })
  })
  test("at column 0 is a no-op (returns the same state)", () => {
    const s = { buf: "abc", cursor: 0 }
    expect(deleteWordBefore(s)).toBe(s)
  })
  test("all-whitespace before cursor collapses to empty", () => {
    expect(deleteWordBefore({ buf: "   ", cursor: 3 })).toEqual({ buf: "", cursor: 0 })
  })
})

describe("killToLineStart (ctrl+u)", () => {
  test("removes everything before the cursor", () => {
    expect(killToLineStart({ buf: "foo bar", cursor: 4 })).toEqual({ buf: "bar", cursor: 0 })
  })
  test("at column 0 is a no-op", () => {
    const s = { buf: "abc", cursor: 0 }
    expect(killToLineStart(s)).toBe(s)
  })
})

describe("killToLineEnd (ctrl+k)", () => {
  test("removes everything from the cursor to the end", () => {
    expect(killToLineEnd({ buf: "foo bar", cursor: 3 })).toEqual({ buf: "foo", cursor: 3 })
  })
  test("at end of line is a no-op", () => {
    const s = { buf: "abc", cursor: 3 }
    expect(killToLineEnd(s)).toBe(s)
  })
})

describe("wordLeft (alt+b)", () => {
  test("moves to the start of the previous word", () => {
    expect(wordLeft({ buf: "foo bar baz", cursor: 11 })).toBe(8)
    expect(wordLeft({ buf: "foo bar baz", cursor: 8 })).toBe(4)
  })
  test("skips whitespace between words", () => {
    expect(wordLeft({ buf: "foo    bar", cursor: 10 })).toBe(7)
  })
  test("at column 0 stays at 0", () => {
    expect(wordLeft({ buf: "abc", cursor: 0 })).toBe(0)
  })
})

describe("wordRight (alt+f)", () => {
  test("moves to the end of the next word", () => {
    expect(wordRight({ buf: "foo bar baz", cursor: 0 })).toBe(3)
    expect(wordRight({ buf: "foo bar baz", cursor: 3 })).toBe(7)
  })
  test("skips leading whitespace", () => {
    expect(wordRight({ buf: "foo    bar", cursor: 3 })).toBe(10)
  })
  test("at end of line stays at end", () => {
    expect(wordRight({ buf: "abc", cursor: 3 })).toBe(3)
  })
})
