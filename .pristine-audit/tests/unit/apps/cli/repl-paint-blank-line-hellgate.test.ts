/**
 * `paintBlankLine` hellgate.
 *
 * Pins: writes exactly `"\n"` to stderr, no more, no less. The 7 sites in
 * `runRepl` previously wrote this verbatim and commented "matches the prior
 * byte-identically" — this test pins that contract in ONE place.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { paintBlankLine } from "../../../../src/apps/cli/repl-paint"

let captured: string[]
let originalWrite: typeof process.stderr.write

beforeEach(() => {
  captured = []
  originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown): boolean => {
    captured.push(String(chunk))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stderr.write = originalWrite
})

describe("paintBlankLine", () => {
  test("writes exactly '\\n' to stderr", () => {
    paintBlankLine()
    expect(captured).toEqual(["\n"])
  })

  test("payload byte count is 1 (single newline char)", () => {
    paintBlankLine()
    expect(captured).toHaveLength(1)
    expect(captured[0]?.length).toBe(1)
    expect(captured[0]?.charCodeAt(0)).toBe(0x0a) // ASCII LF
  })

  test("no ANSI escapes leak (byte-identical to bare write)", () => {
    paintBlankLine()
    expect(captured[0]).not.toContain("\x1b")
  })

  test("multiple calls produce N writes of N newlines", () => {
    paintBlankLine()
    paintBlankLine()
    paintBlankLine()
    expect(captured).toEqual(["\n", "\n", "\n"])
  })

  test("write goes to stderr, not stdout (the contract this preserves)", () => {
    // The setup above only intercepted stderr — if a future change routes
    // the painter to stdout instead, our `captured` array would stay empty.
    paintBlankLine()
    expect(captured).toHaveLength(1)
  })
})
