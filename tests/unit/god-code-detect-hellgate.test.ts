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

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `const x${i} = ${i}`).join("\n")

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

// A function whose BODY block spans exactly `span` source lines. Layout:
//   line 1            `export function fn() {`   ← body block opens here
//   lines 2..span-1   body statements
//   line `span`       `}`                        ← body block closes here
// so the AST body span (`endLine - startLine + 1`) == `span`.
const fnWithBodySpan = (span: number): string => {
  const stmts = Array.from({ length: span - 2 }, (_, i) => `  const y${i} = ${i}`).join("\n")
  return `export function fn() {\n${stmts}\n}\n`
}

describe("detectGodFunctions (AST body span)", () => {
  test("a function whose BODY exceeds the threshold is flagged by file::name", () => {
    const got = detectGodFunctions([
      { path: "f.ts", text: fnWithBodySpan(GOD_FUNCTION_MAX_LINES + 1) },
    ])
    expect(got.map((f) => f.key)).toEqual(["f.ts::fn"])
  })

  test("a function whose BODY is exactly AT the threshold is NOT flagged (boundary)", () => {
    expect(
      detectGodFunctions([{ path: "f.ts", text: fnWithBodySpan(GOD_FUNCTION_MAX_LINES) }]),
    ).toEqual([])
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

// ── Accessors — a closed DETECTION HOLE. `get`/`set` carry a body like a method;
//    a 200-line accessor used to slide past the ratchet entirely. ──
describe("detectGodFunctions (accessor coverage)", () => {
  // A class accessor whose BODY block spans exactly `span` source lines (same
  // layout math as fnWithBodySpan: open line + span-2 statements + close line).
  const accessor = (sig: string, span: number): string => {
    const stmts = Array.from({ length: span - 2 }, (_, i) => `    const y${i} = ${i}`).join("\n")
    return `export class C {\n  ${sig} {\n${stmts}\n  }\n}\n`
  }

  test("a god-sized GETTER body is flagged (previously invisible)", () => {
    const got = detectGodFunctions([
      { path: "g.ts", text: accessor("get big()", GOD_FUNCTION_MAX_LINES + 1) },
    ])
    expect(got.map((f) => f.key)).toEqual(["g.ts::big"])
  })

  test("a god-sized SETTER body is flagged", () => {
    const got = detectGodFunctions([
      { path: "s.ts", text: accessor("set big(v: number)", GOD_FUNCTION_MAX_LINES + 1) },
    ])
    expect(got.map((f) => f.key)).toEqual(["s.ts::big"])
  })

  test("a short accessor is NOT flagged (boundary holds for accessors too)", () => {
    expect(detectGodFunctions([{ path: "g.ts", text: accessor("get small()", 10) }])).toEqual([])
  })
})

// ── Anonymous callbacks get a LINE-SHIFT-INDEPENDENT key (`<scope>~anon<ordinal>`),
//    not `<anonymous@line>` — so an allowlisted anon god-fn is not silently
//    re-bound to a different callback when code above it shifts. ──
describe("detectGodFunctions (stable anonymous keys)", () => {
  const body = (span: number): string =>
    Array.from({ length: span - 2 }, (_, i) => `    const y${i} = ${i}`).join("\n")
  // A named scope `run` whose only anonymous callback is a `new Promise(executor)`.
  const anonInScope = (prefixBlankLines: number, span: number): string =>
    `${"\n".repeat(prefixBlankLines)}export const run = () => {\n  return new Promise((resolve) => {\n${body(span)}\n  })\n}\n`

  test("an anon god-callback is keyed <scope>~anon0, never a line number", () => {
    const got = detectGodFunctions([
      { path: "a.ts", text: anonInScope(0, GOD_FUNCTION_MAX_LINES + 1) },
    ])
    expect(got.map((f) => f.key)).toContain("a.ts::run~anon0")
    expect(got.every((f) => !f.name.includes("@"))).toBe(true) // no `<anonymous@line>`
  })

  test("the anon key is UNCHANGED when lines are added ABOVE it (fragility fix — red on regressing to line keys)", () => {
    const at0 = detectGodFunctions([
      { path: "a.ts", text: anonInScope(0, GOD_FUNCTION_MAX_LINES + 1) },
    ])
    const at50 = detectGodFunctions([
      { path: "a.ts", text: anonInScope(50, GOD_FUNCTION_MAX_LINES + 1) },
    ])
    const key = (fs: ReturnType<typeof detectGodFunctions>) =>
      fs.find((f) => f.name.includes("~anon"))?.key
    expect(key(at0)).toBe("a.ts::run~anon0")
    expect(key(at50)).toBe(key(at0)) // a line shift above must not move the key
  })

  test("multiple anon callbacks in one scope get stable ordinals anon0, anon1", () => {
    const text = `export const run = () => {\n  first(() => {\n${body(GOD_FUNCTION_MAX_LINES + 1)}\n  })\n  second(() => {\n${body(GOD_FUNCTION_MAX_LINES + 1)}\n  })\n}\n`
    const anons = detectGodFunctions([{ path: "m.ts", text }])
      .filter((f) => f.name.includes("~anon"))
      .map((f) => f.name)
      .sort()
    expect(anons).toEqual(["run~anon0", "run~anon1"])
  })
})
