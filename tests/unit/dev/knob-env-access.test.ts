/**
 * Unit contract for `tools/dev/knob-env-access` — the AST census that replaced
 * the completeness ratchet's regex.
 *
 * One case per ACCESS FORM, each asserted separately. A single smoke test over a
 * blob of source would pass while one form silently stopped matching, which is
 * exactly how the regex version reached `orphans=0` with 63 undeclared reads in
 * the tree: it was never wrong loudly, only wrong narrowly.
 *
 * The forms below are the ones measured as invisible to the regex, verbatim from
 * the tree — `env(...)` as a function, a bag aliased to `e` / `envSource` /
 * `args.envSource`, a cast bag, and a local helper taking the key as a literal.
 *
 * Pure: `censusSource` parses a string. No disk, no git, no env.
 */
import { describe, expect, test } from "bun:test"
import { censusSource } from "../../../tools/dev/knob-env-access"

const keysOf = (src: string, kind = "read"): string[] =>
  censusSource("x.ts", src)
    .filter((a) => a.kind === kind)
    .map((a) => a.key)

const formOf = (src: string, key: string): string | undefined =>
  censusSource("x.ts", src).find((a) => a.key === key)?.form

describe("knob-env-access — one test per access form", () => {
  test("plain `env.KEY`", () => {
    expect(keysOf("const v = env.QUANTA_A")).toContain("QUANTA_A")
    expect(formOf("const v = env.QUANTA_A", "QUANTA_A")).toBe("property")
  })

  test("`process.env.KEY`", () => {
    expect(keysOf("const v = process.env.QUANTA_B")).toContain("QUANTA_B")
  })

  // The bag is named `e`, so `/\benv\./` never matched. Measured at
  // `src/apps/cli/rewind-cmd.ts:174` and `memory-cmd.ts:107`.
  test("bag aliased to a short identifier — `e.KEY`", () => {
    expect(keysOf('return isOn(e.QUANTA_C, "1")')).toContain("QUANTA_C")
  })

  test("bag behind a field — `args.envSource.KEY`", () => {
    expect(keysOf("const v = args.envSource.QUANTA_D")).toContain("QUANTA_D")
  })

  // `src/llm/factory.ts:473`.
  test("cast bag — `(env as { KEY?: string }).KEY`", () => {
    expect(keysOf("const v = (env as { QUANTA_E?: string }).QUANTA_E")).toContain("QUANTA_E")
  })

  test("bracket access with a string literal", () => {
    expect(keysOf('const v = env["QUANTA_F"]')).toContain("QUANTA_F")
    expect(formOf('const v = env["QUANTA_F"]', "QUANTA_F")).toBe("element-literal")
  })

  test("bracket access through a file-local const alias", () => {
    const src = 'const K = "QUANTA_G"\nconst v = env[K]'
    expect(keysOf(src)).toContain("QUANTA_G")
    expect(formOf(src, "QUANTA_G")).toBe("element-alias")
  })

  test("destructure off a bag", () => {
    expect(keysOf("const { QUANTA_H } = process.env")).toContain("QUANTA_H")
  })

  // `env("QUANTA_PERMISSION", "default")` — env is a FUNCTION here, which is why
  // no bag-shaped pattern could see it (`session-runtime-config.ts:87`).
  test('key passed to a helper — `env("KEY", d)` / `intEnv("KEY")`', () => {
    expect(keysOf('const v = env("QUANTA_I", "d")')).toContain("QUANTA_I")
    expect(keysOf('const v = intEnv("QUANTA_J")')).toContain("QUANTA_J")
    expect(formOf('const v = intEnv("QUANTA_J")', "QUANTA_J")).toBe("call-arg")
  })

  // `gateOnStrict(env, CONTEXT_1M_FLAG)`. The regex could not see this call, so it
  // counted the const DEFINITION instead — which meant a const declared and never
  // used read as a live read. Resolving at the CALL is narrower and truer.
  test("const-keyed call — `gateOn(env, KEY_CONST)` resolves through the local const", () => {
    const src = 'const FLAG = "QUANTA_K1"\nconst v = gateOnStrict(env, FLAG)'
    expect(keysOf(src)).toContain("QUANTA_K1")
    expect(formOf(src, "QUANTA_K1")).toBe("call-arg")
  })

  test("a const declared but never passed anywhere is NOT a read", () => {
    expect(keysOf('const UNUSED = "QUANTA_K2"')).toEqual([])
  })
})

describe("knob-env-access — what must NOT count as a read", () => {
  // `src/plugin-isolation/bun-spawner.ts:87`. The old scanner counted this,
  // which asked the registry to declare a value the process SETS for a child.
  test("a write is a write, never a read", () => {
    const src = 'process.env.QUANTA_ALLOW_UNSIGNED = "1"'
    expect(keysOf(src, "write")).toEqual(["QUANTA_ALLOW_UNSIGNED"])
    expect(keysOf(src, "read")).toEqual([])
  })

  test("compound assignment is also a write", () => {
    expect(keysOf('env.QUANTA_K ??= "1"', "write")).toEqual(["QUANTA_K"])
    expect(keysOf('env.QUANTA_K ??= "1"', "read")).toEqual([])
  })

  test("delete is neither read nor write", () => {
    const src = "delete process.env.QUANTA_L"
    expect(keysOf(src, "delete")).toEqual(["QUANTA_L"])
    expect(keysOf(src, "read")).toEqual([])
  })

  // A trailing `_` marks a composed prefix. `QUANTA_BENCH_` and
  // `QUANTA_SWEBENCH_PRO_` are both live in the tree.
  test("a trailing-underscore token is a prefix, not a scalar knob", () => {
    // The shape both live prefixes actually take: passed to a helper that
    // composes the full key (`box-session.ts:224`, `registry.test.ts:370`).
    const src = 'const v = envPrefixed(env, "QUANTA_BENCH_")'
    expect(keysOf(src, "prefix")).toContain("QUANTA_BENCH_")
    expect(keysOf(src, "read")).toEqual([])
  })

  // The AST replacement for the old `[=:]\s*"…"` anchor.
  test("a literal that merely CONTAINS a key is a message, not a read", () => {
    expect(keysOf('throw new Error("QUANTA_M failed to parse")')).toEqual([])
  })

  test("a comment is not a read", () => {
    expect(keysOf("// set QUANTA_N=1 to enable\nconst v = 1")).toEqual([])
  })

  // The asymmetry that keeps the census attributable: with the key invisible,
  // the object is the only evidence, so a non-bag index never enters.
  test("a computed index into a NON-bag is ignored entirely", () => {
    const hits = censusSource("x.ts", "const v = rows[i]\nconst w = lookup[SOME_CONST]")
    expect(hits).toEqual([])
  })

  test("a computed index into a bag IS surfaced as unattributable", () => {
    const kinds = censusSource("x.ts", "const v = process.env[name]").map((a) => a.kind)
    expect(kinds).toEqual(["const-alias-unresolved"])
  })

  test("an unresolved SCREAMING_CASE index into a bag is reported, not dropped", () => {
    const hits = censusSource("x.ts", "const v = env[IMPORTED_KEY]")
    expect(hits.map((a) => [a.key, a.kind])).toEqual([["IMPORTED_KEY", "const-alias-unresolved"]])
  })
})

describe("knob-env-access — anti-vacuity", () => {
  test("the census is not trivially empty on a file that has every form", () => {
    const src = [
      "const v1 = env.QUANTA_A1",
      'const v2 = env["QUANTA_A2"]',
      "const { QUANTA_A3 } = process.env",
      'const v4 = gateOn(env, "QUANTA_A4")',
    ].join("\n")
    expect(new Set(keysOf(src)).size).toBe(4)
  })

  test("an empty file yields nothing (no phantom hits)", () => {
    expect(censusSource("x.ts", "")).toEqual([])
  })
})
