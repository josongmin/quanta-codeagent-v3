import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const R = join(import.meta.dir, "..", "..")
/**
 * Comments are stripped BEFORE any predicate runs.
 *
 * The exclusion for a throw-based floor was a prose match, so a file with no
 * floor of any kind stayed off the ledger for as long as the word `vacuous`
 * appeared anywhere in it — including a comment. Proven by deleting one comment
 * line from an otherwise-unchanged file and watching it appear. Sixteen real
 * files were being excluded by prose alone. A self-issued exemption is worse than
 * no rule.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

/** Any way this repo reaches the tree. */
const SCAN =
  /\breaddirSync\s*\(|\breaddir\s*\(|\bBun\.Glob\b|\bnew Glob\b|ls-files|\bglobSync\s*\(|\bopendirSync\s*\(|\bexecSync\s*\(\s*["'`][^"'`]*\b(?:find|git|rg|grep)\b/

/**
 * Any way a scan-derived verdict is expressed.
 *
 * Widened after an audit built nine defective files the original missed. The
 * additions are not hypothetical spellings: `toBeFalsy`, a bare `throw` on a
 * non-empty result, and `.size === 0` are all in live use here, and each says
 * "no violations" in a way an empty scan satisfies for free.
 */
const VERDICT =
  /\.toEqual\(\s*\[\s*\]\s*\)|\.toBeLessThanOrEqual\(|\.toHaveLength\(\s*0\s*\)|\.toBe\(\s*0\s*\)|\.toBeFalsy\(\s*\)|\.toEqual\(\s*new Set\(\s*\)\s*\)|\.length\s*>\s*0\s*\)\s*\{?\s*throw|\.size\s*>\s*0\s*\)\s*\{?\s*throw/

/**
 * A numeric floor, in the shape biome actually emits.
 *
 * The original required `)` immediately after the digits, so every floor long
 * enough for the formatter to wrap — which is every
 * `expect(x, "message").toBeGreaterThan(N)` — got a trailing comma and was
 * invisible. Three guards fixed during this campaign were kept off the ledger
 * only because the prose regex happened to match their assertion message.
 */
const NUMERIC_FLOOR = /\.toBeGreaterThan(?:OrEqual)?\(\s*([1-9]\d*)\s*,?\s*\)/

/**
 * A floor asserted by throwing rather than by `expect`.
 *
 * Now requires a real `throw` near the phrase, not the phrase alone — the whole
 * point of stripping comments above is that prose cannot grant the exemption by
 * itself.
 */
/**
 * A numeric floor asserted on something that LOOKS like a scan result — a count
 * of files, entries, paths, matches, or the `.length`/`.size` of a collection.
 *
 * This is the file-wide backstop, and it is narrowed by NAME on purpose: the
 * whole point is to accept a corpus floor while still rejecting the latency
 * floor that started this.
 */
const SCAN_FLOOR =
  /(?:\b(?:files?|entries|paths?|matches|scanned|declared|all|found|sources?|tracked|dirs?|count)\w*(?:\.(?:length|size))?|\.(?:length|size)|count\w*\([^)]*\))\s*(?:,[\s\S]{0,120}?)?\)?\s*\)?\s*\.toBeGreaterThan(?:OrEqual)?\(\s*([1-9]\d*)\s*,?\s*\)/

/**
 * `expect(<scan expr>, "message").toBeGreaterThan(N)` where biome has wrapped the
 * arguments onto their own lines — the scan expression and the floor end up far
 * apart with the message between them, which the single-line pattern cannot span.
 */
const WRAPPED_SCAN_FLOOR =
  /expect\(\s*\n[\s\S]{0,200}?(?:count\w*\(|\.(?:length|size)\b|\bfiles?\b|\bentries\b|\bscanned\b|\bdeclared\b)[\s\S]{0,200}?\n\s*\)\s*\.toBeGreaterThan(?:OrEqual)?\(\s*([1-9]\d*)\s*,?\s*\)/

const THROW_FLOOR =
  /throw new Error\((?:[^)]|\)(?!\s*$))*?(?:vacuous|read no |far below|would pass over|never happened)/is

/** Scans only a directory it created itself — the empty case is the assertion. */
const TEMP_ONLY = (s: string): boolean =>
  /mkdtempSync|mkdtemp\(/.test(s) && !/\bls-files\b|walk\(\s*join\(\s*REPO_ROOT/.test(s)

/**
 * Split a source into per-`test`/`it` bodies, plus everything outside them.
 *
 * Deliberately crude — split on the next `test(`/`it(` rather than brace-match —
 * because the only question is which floor is NEAR which scan, and a scan in a
 * module-scope helper is attributed to the preamble block where its floor would
 * also have to live.
 */
const blocks = (src: string): readonly string[] => {
  const parts = src.split(/\n(?=\s*(?:it|test)(?:\.\w+(?:\([^)]*\))?)?\s*\()/)
  const preamble = parts[0] ?? ""
  // A module-scope scan is shared by every block, so the preamble travels with
  // each one rather than being judged alone.
  return parts.length === 1 ? parts : parts.slice(1).map((b) => `${preamble}\n${b}`)
}

const out: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith(".test.ts")) {
      const s = stripComments(readFileSync(p, "utf8"))
      if (!SCAN.test(s) || !VERDICT.test(s)) continue
      if (TEMP_ONLY(s)) continue
      // The floor must live in a block that actually SCANS. A file-wide check let
      // an unrelated `expect(ms).toBeGreaterThan(1)` in a different test exempt
      // every scan in the file — a floor on latency vouching for a corpus.
      // Two passes, and the second is what keeps the precision.
      //
      // Block-scoping alone was too strict: a floor asserted in a `describe`-level
      // helper, or in a sibling `test` that shares the same scan, is real and the
      // per-block view cannot see it. It reported 70 files including three that
      // had been given derived floors hours earlier.
      //
      // File-scoping alone was too loose: an unrelated `expect(ms).toBeGreaterThan(1)`
      // in a different test exempted every scan in the file — a latency floor
      // vouching for a corpus.
      //
      // So a file is listed only when NO scanning block carries a floor AND the
      // file has no floor asserted on a scan-shaped quantity anywhere. The second
      // condition is what a reader would check by eye.
      const unflooredBlock = blocks(s).some(
        (b) => SCAN.test(b) && !NUMERIC_FLOOR.test(b) && !THROW_FLOOR.test(b),
      )
      if (
        unflooredBlock &&
        !SCAN_FLOOR.test(s) &&
        !WRAPPED_SCAN_FLOOR.test(s) &&
        !THROW_FLOOR.test(s)
      ) {
        out.push(p.slice(R.length + 1))
      }
    }
  }
}
/**
 * Files that scan the repo, derive a verdict, and assert no floor on what the
 * scan actually reached.
 *
 * The shape is the one every defect in this campaign reduced to: `[]`, `0` and
 * `false` mean both "clean" and "I never looked", so a scan that reaches nothing
 * passes. Eight instances were PROVEN by running byte-identical copies of the
 * guards against an empty mirror of the repo's directory skeleton; all eight
 * were green there.
 *
 * Three exclusions keep this precise rather than loud, each measured:
 *   - a THROW-based floor counts (`vacuous` / `read no` / `far below`), because
 *     several guards assert the floor by throwing rather than by `expect`.
 *   - a guard that only ever scans a directory it created itself is not in
 *     scope: there "empty" IS the assertion.
 *   - a numeric `toBeGreaterThan(n≥1)` counts; `> 0` does not, and that is
 *     deliberate — 56 of 81 authors in this repo already write the floor as
 *     `> 0`, which passes against any non-empty directory and proves nothing
 *     about a partial walk or a rotted matcher.
 */
/**
 * The predicate, over one source, with no filesystem involved.
 *
 * Exported so the ratchet can DRIVE it instead of asserting a tautology about the
 * ledger. The previous test — `known.filter(P).every(f => known.includes(f))` —
 * was true for every P, never touched this function, and passed under a mutation
 * that made `> 0` count as a floor.
 */
/**
 * Does this text assert a floor on a SCAN-SHAPED quantity?
 *
 * `NUMERIC_FLOOR` alone was the last hole: any `toBeGreaterThan(N)` in the block
 * satisfied it, so an `expect(elapsedMs).toBeGreaterThan(1)` sitting beside a
 * scan exempted the scan. A floor only counts when it is on the thing scanned.
 */
const hasScanFloor = (text: string): boolean =>
  SCAN_FLOOR.test(text) || WRAPPED_SCAN_FLOOR.test(text) || THROW_FLOOR.test(text)

export const isFloorless = (rawSource: string): boolean => {
  const s = stripComments(rawSource)
  if (!SCAN.test(s) || !VERDICT.test(s)) return false
  if (TEMP_ONLY(s)) return false
  return blocks(s).some((b) => SCAN.test(b) && !hasScanFloor(b)) && !hasScanFloor(s)
}

/**
 * How many test files the census actually walked.
 *
 * The ratchet floors THIS rather than the ledger: a census that returned no
 * findings is indistinguishable from one that read nothing, and a burn-down
 * driven to zero must be green rather than red.
 */
export const censusCorpusSize = (): number => {
  let n = 0
  const count = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(d, e.name)
      if (e.isDirectory()) count(p)
      else if (p.endsWith(".test.ts")) n++
    }
  }
  count(join(R, "tests"))
  count(join(R, "src"))
  return n
}

export const floorlessGuards = (): readonly string[] => {
  out.length = 0
  walk(join(R, "tests"))
  walk(join(R, "src"))
  return out.sort()
}

if (import.meta.main) {
  console.log(JSON.stringify(floorlessGuards(), null, 2))
}
