/**
 * Hellgate (detector teeth + red-on-injection) for the god-code SE-metric ratchet
 * DETECTOR — distinct from `god-code-ratchet.test.ts` (which freezes the live
 * allowlist). This drives `detectGodModules` / `detectGodFunctions` over injected
 * `{path,text}` fixtures and pins the boundary behaviour the ratchet depends on:
 *
 *  - a module ONE line over the threshold is flagged; exactly-at is not,
 *  - a function whose BODY is over the threshold is flagged by `file::name` key;
 *    a short function is not,
 *  - the AST span (not string/comment braces) drives the function measurement.
 *
 * Red-on-injection: if the detector's `>` became `>=` (or vice-versa), or if it
 * stopped counting nested/over-long bodies, the boundary cases below flip.
 */
import { describe, expect, test } from "bun:test"
import {
  detectGodFunctions,
  detectGodModules,
  GOD_FUNCTION_MAX_LINES,
  GOD_MODULE_MAX_LINES,
} from "../../tools/god-code/detect"

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `const x${i} = ${i}`).join("\n")

describe("detectGodModules (line-count boundary)", () => {
  test("a file ONE line over the threshold is flagged", () => {
    const text = lines(GOD_MODULE_MAX_LINES + 1)
    const got = detectGodModules([{ path: "big.ts", text }])
    expect(got.map((m) => m.file)).toEqual(["big.ts"])
    expect(got[0]?.lines).toBe(GOD_MODULE_MAX_LINES + 1)
  })

  test("a file exactly AT the threshold is NOT flagged", () => {
    const got = detectGodModules([{ path: "ok.ts", text: lines(GOD_MODULE_MAX_LINES) }])
    expect(got).toEqual([])
  })
})

describe("detectGodFunctions (AST body span)", () => {
  test("a function whose BODY exceeds the threshold is flagged by file::name", () => {
    const body = Array.from({ length: GOD_FUNCTION_MAX_LINES + 1 }, (_, i) => `  const y${i} = ${i}`).join("\n")
    const text = `export function big() {\n${body}\n}\n`
    const got = detectGodFunctions([{ path: "f.ts", text }])
    expect(got.map((f) => f.key)).toEqual(["f.ts::big"])
  })

  test("a short function is NOT flagged, and braces inside strings/comments don't inflate the span", () => {
    const text = [
      "export function small() {",
      '  const s = "}}}}}}}}}}"  // not a real block',
      "  return s",
      "}",
    ].join("\n")
    expect(detectGodFunctions([{ path: "s.ts", text }])).toEqual([])
  })
})
