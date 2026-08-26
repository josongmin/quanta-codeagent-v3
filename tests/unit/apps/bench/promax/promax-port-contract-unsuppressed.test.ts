/**
 * THE PORT CONTRACT MAY NOT BE SUPPRESSED.
 *
 * `src/apps/bench/profiles/` IS the dataset-family port contract: the `types.ts`
 * declarations and the per-family implementations that must satisfy them. A
 * type assertion inside that directory does not narrow a value — it switches
 * off the one check that makes a port a port.
 *
 * MEASURED consequence, not a hypothetical. `promax.ts` called the official
 * receipt builder through
 *
 *     } as Parameters<typeof buildProMaxOfficialGradeReceipt>[0])
 *
 * and the port declared no `images` field. The cast made the mismatch compile,
 * so image digests were captured, given the power to FAIL a run, and dropped on
 * the floor — under a commit whose headline said the receipt recorded them.
 * Nothing was wrong at runtime that anyone could observe; the type system had
 * been told not to look.
 *
 * `registry.ts` carried the other one. It turned out to suppress nothing at all
 * — `...(opts ?? {})` typechecks — which is the more dangerous kind: a cast that
 * is load-bearing for nothing still silently absorbs the next real drift.
 *
 * SCOPE, deliberately narrow. This is not a repo-wide ban. Nine of these casts
 * live in `src/`, and most are union-dispatch narrowing (`dispatch-6.ts` hands a
 * union member to its handler) where the alternative is a discriminated-union
 * rewrite and the cast is honest. Banning those would be papering over a real
 * distinction to make a number look better. The port directory is different:
 * there is no legitimate reason to assert your way past a contract you are
 * implementing.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// `fileURLToPath`, not `.pathname` — the latter stays percent-encoded, so the
// guard crashed with ENOENT on any checkout whose path contains a space.
const PORT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../src/apps/bench/profiles",
)

/**
 * Escapes that switch off checking rather than narrow a value.
 *
 * `as any` and a bare `: any` annotation are the same hole from opposite ends —
 * one suppresses at a call, the other declares the contract not to care — so
 * the detector covers both. (`as any` alone left a `readonly sneak: any` in
 * `types.ts` undetected; measured.)
 */
const SUPPRESSION =
  /\bas\s+(Parameters<|ReturnType<|any\b|never\b|unknown\s+as\b)|:\s*any\b|<[^>]*\bany\b[^>]*>|\bany\s*\[\]|=\s*any\b/

/**
 * `tsc`'s OWN suppression directives live in COMMENTS, so they are matched
 * before comments are stripped. Missing them meant the guard ignored the only
 * mechanism that actually switches the compiler off: a `@ts-expect-error` on a
 * port call compiled a field the contract does not declare, with
 * `bun run typecheck` green.
 */
const TS_DIRECTIVE = /@ts-(ignore|expect-error|nocheck)\b/

/** Comments are not code — the files here explain the rule in prose. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const sources = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, into)
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) into.push(full)
  }
  return into
}

describe("the dataset-family port contract is checked, not asserted", () => {
  test("🔴 no file in src/apps/bench/profiles suppresses its own types", () => {
    const offenders = sources(PORT_DIR)
      .filter((f) => {
        const src = readFileSync(f, "utf8")
        return TS_DIRECTIVE.test(src) || SUPPRESSION.test(stripComments(src))
      })
      .map((f) => f.slice(PORT_DIR.length + 1))
    expect(
      offenders,
      "a port implementation asserted its way past the contract it implements",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan reaches the real port files", () => {
    // without this the guard passes just as well when the walk finds nothing,
    // or when the directory moves and the resolve lands somewhere empty
    const found = sources(PORT_DIR).map((f) => f.slice(PORT_DIR.length + 1))
    expect(found.length).toBeGreaterThan(5)
    for (const required of ["types.ts", "promax.ts", "registry.ts"]) {
      expect(found, `${required} is not being scanned`).toContain(required)
    }
  })

  test("ANTI-VACUITY: the detector fires on the shapes it names", () => {
    const hit = (s: string) => SUPPRESSION.test(stripComments(s))
    expect(hit("} as Parameters<typeof buildProMaxOfficialGradeReceipt>[0])")).toBe(true)
    expect(hit("const x = y as any")).toBe(true)
    expect(hit("images as never")).toBe(true)
    expect(hit("const r = parsed as unknown as Receipt")).toBe(true)
    // …and it does not fire on ordinary narrowing or on prose
    expect(hit("readonly sneak: any")).toBe(true)
    expect(hit("type Loose = any")).toBe(true)
    expect(hit("readonly xs: readonly any[]")).toBe(true)
    expect(hit("const m: Record<string, any> = {}")).toBe(true)
    expect(hit("const f = x as FamilyBoxGradeVerdicts")).toBe(false)
    expect(hit("// never write `as Parameters<typeof f>[0]` here")).toBe(false)
  })
})
