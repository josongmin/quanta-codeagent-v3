import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * #24 STRUCTURAL RATCHET — runtime-config gate doc ↔ resolver consistency.
 *
 * The gate-vocab unification (jun-07) replaced the strict `=== "1"` reads with
 * the loose `gateOn` / `parseBool` superset (`1`/`on`/`true`/`yes`) but left
 * ~30 field-doc + inline comments still asserting `Strict opt-in (=== "1")`.
 * A doc that claims a knob keys on the EXACT literal `"1"` while the resolver
 * actually accepts `on`/`true`/`yes` is a LIE an operator acts on.
 *
 * GROUND TRUTH = the resolver call, NOT the prose:
 *   - `gateOnStrict(env, "X")`  ⇒ genuinely `=== "1"` (claim ALLOWED)
 *   - `gateOn(env, "X")`        ⇒ loose superset (claiming `=== "1"` is a LIE)
 *   - `parseBool(env["X"])`     ⇒ loose superset (claiming `=== "1"` is a LIE)
 *
 * INVARIANT: for every boolean knob resolved via the LOOSE family, neither its
 * field doc NOR its inline resolver comment may affirmatively claim `=== "1"`.
 * Corrected docs (which mention `=== "1"` only to say "NOT strict `=== "1"`")
 * carry an explicit loose-marker and are exempted — so this guard is precise,
 * not a blanket ban on the substring.
 *
 * This is a hellgate (not a vacuous grep): RED-ON-INJECTION — reintroduce one
 * stale `Strict opt-in (=== "1")` over a `gateOn` knob and this test RED-flags
 * the exact field. See the self-test at the bottom.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
// The god-module split moved the `RuntimeConfig` interface (the field JSDoc
// corpus) into `runtime-config/types.ts`; the `loadFromEnv` resolver lines stay
// in `runtime-config.ts`. The drift ratchet cross-checks the two, so it reads
// BOTH sources — resolvers from the parent, field docs from the type module.
const RESOLVER_SRC = join(REPO_ROOT, "src/shared/runtime-config.ts")
// The `RuntimeConfig` interface is split across two type modules (`types.ts`
// holds the feature-gate half + `extends RuntimeConfigPaths`; `types-extra.ts`
// holds the launcher/path/bench half). Both carry per-field JSDoc, so the drift
// corpus reads both.
const FIELD_DOC_SRCS = [
  join(REPO_ROOT, "src/shared/runtime-config/types.ts"),
  join(REPO_ROOT, "src/shared/runtime-config/types-extra.ts"),
]

/** Strict claim = the literal `=== "1"` appears in the prose. */
const claimsExactOne = (text: string): boolean => text.includes('=== "1"')

/** A comment is an EXEMPTED correction iff it carries a loose-vocab marker —
 *  these mention `=== "1"` only to DENY it ("…NOT strict `=== "1"`"). */
const LOOSE_MARKERS = [
  "gateOn vocab",
  "standard boolean vocab",
  "canonical `gateOn`",
  "NOT strict",
  "#24 doc-fix",
]
const isExemptedCorrection = (text: string): boolean => LOOSE_MARKERS.some((m) => text.includes(m))

/** True iff prose AFFIRMATIVELY claims the exact-"1" gate (and is not a
 *  corrected "NOT strict" note). */
const affirmsStrictOne = (text: string): boolean =>
  claimsExactOne(text) && !isExemptedCorrection(text)

interface ResolverEntry {
  readonly field: string
  readonly kind: "gateOnStrict" | "gateOn" | "parseBool"
  readonly inlineComment: string
}

/** Walk UP from `from-1`, collecting trimmed lines while `classify` says so.
 *  `"include"` keeps walking, `"include-stop"` keeps this line then stops,
 *  `"stop"` halts without including. Shared by both parsers so the upward-scan
 *  logic lives in ONE place (no duplicated loop, no per-parser complexity). */
type LineVerdict = "include" | "include-stop" | "stop"
const collectAbove = (
  lines: string[],
  from: number,
  classify: (ln: string) => LineVerdict,
): string[] => {
  const acc: string[] = []
  for (let j = from - 1; j >= 0; j--) {
    const verdict = classify((lines[j] ?? "").trim())
    if (verdict === "stop") break
    acc.unshift((lines[j] ?? "").trim())
    if (verdict === "include-stop") break
  }
  return acc
}

/** Parse `loadFromEnv` resolver lines: `field: gateOn|gateOnStrict|parseBool(…)`.
 *  `gateOnStrict` is listed first so the alternation never mis-tags it as the
 *  `gateOn` substring. The inline comment = the contiguous `//` block directly
 *  above the resolver line. */
const parseResolvers = (lines: string[]): ResolverEntry[] => {
  const out: ResolverEntry[] = []
  const re = /^\s*(\w+):\s*(gateOnStrict|gateOn|parseBool)\(/
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i] ?? "")
    if (m === null) continue
    const comment = collectAbove(lines, i, (ln) => (ln.startsWith("//") ? "include" : "stop"))
    out.push({
      field: m[1] as string,
      kind: m[2] as ResolverEntry["kind"],
      inlineComment: comment.join("\n"),
    })
  }
  return out
}

/** For each `readonly <field>: …` interface decl, capture the JSDoc block
 *  (`/** … *​/`) immediately above it. */
const parseFieldDocs = (lines: string[]): Map<string, string> => {
  const docs = new Map<string, string>()
  const re = /^\s*readonly\s+(\w+):/
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i] ?? "")
    if (m === null) continue
    const comment = collectAbove(lines, i, (ln) =>
      ln.startsWith("/**")
        ? "include-stop"
        : ln.endsWith("*/") || ln.startsWith("*")
          ? "include"
          : "stop",
    )
    if (comment.length > 0) docs.set(m[1] as string, comment.join("\n"))
  }
  return docs
}

const RESOLVER_LINES = readFileSync(RESOLVER_SRC, "utf8").split("\n")
const FIELD_DOC_LINES = FIELD_DOC_SRCS.flatMap((src) => readFileSync(src, "utf8").split("\n"))
const RESOLVERS = parseResolvers(RESOLVER_LINES)
const FIELD_DOCS = parseFieldDocs(FIELD_DOC_LINES)

describe("#24 — runtime-config gate doc ↔ resolver consistency ratchet", () => {
  test("the parser actually found the resolver + doc corpus (anti-vacuous)", () => {
    // Broad invariant first: if these collapse to 0 the assertions below are
    // vacuously green. Anchor on known knobs.
    expect(RESOLVERS.length).toBeGreaterThan(20)
    expect(RESOLVERS.some((r) => r.field === "bgCompaction" && r.kind === "gateOnStrict")).toBe(
      true,
    )
    expect(RESOLVERS.some((r) => r.field === "progressUpdate" && r.kind === "gateOn")).toBe(true)
    expect(FIELD_DOCS.has("mcpResources")).toBe(true)
  })

  test('NO loose-resolver knob affirmatively claims `=== "1"` in its FIELD DOC', () => {
    const liars: string[] = []
    for (const r of RESOLVERS) {
      if (r.kind === "gateOnStrict") continue // genuinely === "1" — claim allowed
      const doc = FIELD_DOCS.get(r.field)
      if (doc !== undefined && affirmsStrictOne(doc)) {
        liars.push(`${r.field} (resolver=${r.kind}) — field doc claims \`=== "1"\``)
      }
    }
    expect(liars).toEqual([])
  })

  test('NO loose-resolver knob affirmatively claims `=== "1"` in its INLINE comment', () => {
    const liars: string[] = []
    for (const r of RESOLVERS) {
      if (r.kind === "gateOnStrict") continue
      if (r.inlineComment !== "" && affirmsStrictOne(r.inlineComment)) {
        liars.push(`${r.field} (resolver=${r.kind}) — inline comment claims \`=== "1"\``)
      }
    }
    expect(liars).toEqual([])
  })

  test("RED-ON-INJECTION self-test — the detector fires on a stale strict claim", () => {
    // A loose knob's doc that affirmatively claims `=== "1"` MUST be flagged…
    expect(affirmsStrictOne('Strict opt-in (`=== "1"`). Default false ⇒ …')).toBe(true)
    // …while a corrected "NOT strict" note (carrying a loose marker) MUST NOT.
    expect(affirmsStrictOne('gateOn vocab (`1`/`on`); NOT strict `=== "1"`.')).toBe(false)
    // …and prose with no `=== "1"` claim at all is clean.
    expect(affirmsStrictOne("Opt-in. Default false ⇒ byte-identical.")).toBe(false)
  })
})
