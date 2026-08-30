import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The SHARED stripper. A local copy is exactly what
// `comment-scanner-burndown-ratchet` forbids, and for the reason this file
// exists: a hand-rolled one gets its own blind spots.
import { stripComments } from "../../src/shared/source-text"

const R = join(import.meta.dir, "..", "..")

/** Any way this repo reaches the tree. */
/**
 * Any way this repo reaches the tree — as a CALL, never as a mention.
 *
 * `ls-files` used to match as a bare token, so a guard that never runs git but
 * names it in a failure message joined the population: `repro-grounding` was in
 * it on the strength of `throw new Error("git ls-files failed")` and nothing
 * else, and an enrollment campaign would have spent work giving a corpus floor
 * to a file with no corpus. It now requires the argument-array shape
 * (`["git", "ls-files", …]`); the shell-string shape (`execSync("git ls-files …")`)
 * is already covered by the `execSync` branch, and both are pinned.
 */
const SCAN =
  /\breaddirSync\s*\(|\breaddir\s*\(|\bBun\.Glob\b|\bnew Glob\b|\[\s*["'`]git["'`]\s*,\s*["'`]ls-files["'`]|\bglobSync\s*\(|\bopendirSync\s*\(|\bexecSync\s*\(\s*["'`][^"'`]*\b(?:find|git|rg|grep)\b/

/**
 * Any way a scan-derived verdict is expressed.
 *
 * Widened after an audit built nine defective files the original missed. The
 * additions are not hypothetical spellings: `toBeFalsy`, a bare `throw` on a
 * non-empty result, and `.size === 0` are all in live use here, and each says
 * "no violations" in a way an empty scan satisfies for free.
 */
const VERDICT =
  /\.toEqual\(\s*\[\s*\]\s*\)|\.toStrictEqual\(\s*\[\s*\]\s*\)|\.toBeLessThanOrEqual\(|\.toBeLessThan\(|\.toHaveLength\(\s*0\s*\)|\.toBe\(\s*0\s*\)|\.toBe\(\s*false\s*\)|\.toBeFalsy\(\s*\)|\.toEqual\(\s*new Set\(\s*\)\s*\)|\.toEqual\(\s*new Map\(\s*\)\s*\)|\.toEqual\(\s*\{\s*\}\s*\)|\.length\s*>\s*0\s*\)\s*\{?\s*throw|\.size\s*>\s*0\s*\)\s*\{?\s*throw/

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
 * floor that started this. A bare `toBeGreaterThan(N)` anywhere in the block is
 * NOT enough and used to be the last hole — an `expect(elapsedMs)
 * .toBeGreaterThan(1)` sitting beside a scan exempted the scan.
 *
 * The trailing `,?` is not cosmetic: the original required `)` immediately after
 * the digits, so every floor long enough for the formatter to wrap — which is
 * every `expect(x, "message").toBeGreaterThan(N)` — got a trailing comma and was
 * invisible. Three guards fixed during that campaign stayed off the ledger only
 * because the prose regex happened to match their assertion message.
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

/**
 * An exact positive anchor on a scan-shaped Map. A call-site census commonly
 * records counts by path, then proves both a required live site and the total
 * population. `Map#get` is stronger than a loose numeric lower bound, but the
 * generic `.length` scanner cannot see it.
 */
const MAP_ENTRY_FLOOR =
  /expect\(\s*\b(?:files?|entries|paths?|matches|scanned|declared|all|found|sources?|tracked|dirs?|count)\w*\.get\([^)]*\)\s*\)\s*\.toBe\(\s*([1-9]\d*)\s*\)/

/**
 * The canonical floor helper. Stronger than a numeric floor: reach is the
 * intersection of the scan with `git ls-files` (an untracked or gitignored twin
 * is not evidence the corpus was read), coverage is recursive over the tracked
 * set, and the number itself comes from `tools/dev/scan-reach-baseline.json`
 * rather than from whatever the author typed. It is not a `>0`-grade escape
 * hatch, which is why it counts here.
 *
 * WHAT IT DOES NOT PROVE, corrected after an audit found this comment claiming
 * otherwise. A bare call floors the WALKED set only. "A matcher that stopped
 * matching" is caught by the SECOND number (`matched`, floored from the same
 * baseline), and at the time of writing NO guard passes one — so crediting a
 * bare call as predicate coverage was false. Reach coverage is what it grants.
 */
const HELPER_FLOOR = /\bassertScanPopulation\s*\(/

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
      // Delegates to `isFloorless`. This body used to restate the whole rule —
      // the SCAN/VERDICT gates, TEMP_ONLY, and the block/file two-pass — and the
      // copies drifted the moment a floor shape was added: the shape reached
      // `hasScanFloor` while this census kept reporting the file as floorless.
      // One definition, so teaching it once is teaching it everywhere.
      if (isFloorless(readFileSync(p, "utf8"))) out.push(p.slice(R.length + 1))
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
  HELPER_FLOOR.test(text) ||
  SCAN_FLOOR.test(text) ||
  WRAPPED_SCAN_FLOOR.test(text) ||
  MAP_ENTRY_FLOOR.test(text) ||
  THROW_FLOOR.test(text)

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

/**
 * Does this file scan the tree and state a zero-verdict over it?
 *
 * The census's own gate, minus the floor question. `isFloorless` answers "does it
 * lack a floor"; this answers "is it the kind of file a floor is owed by at all",
 * which is what an ENROLLMENT ratchet has to iterate. Sharing the definition is
 * the point — a second copy of SCAN/VERDICT/TEMP_ONLY is how the previous two
 * detectors drifted apart.
 */
export const isScanVerdictGuard = (rawSource: string): boolean => {
  const s = stripComments(rawSource)
  return SCAN.test(s) && VERDICT.test(s) && !TEMP_ONLY(s)
}

/** Every in-scope scan-verdict guard, repo-relative. */
export const scanVerdictGuards = (): readonly string[] => {
  const found: string[] = []
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(d, e.name)
      if (e.isDirectory()) visit(p)
      else if (p.endsWith(".test.ts") && isScanVerdictGuard(readFileSync(p, "utf8"))) {
        found.push(p.slice(R.length + 1))
      }
    }
  }
  visit(join(R, "tests"))
  visit(join(R, "src"))
  return found.sort()
}

export const floorlessGuards = (): readonly string[] => {
  out.length = 0
  walk(join(R, "tests"))
  walk(join(R, "src"))
  return out.sort()
}

if (import.meta.main) {
  // biome-ignore lint/suspicious/noConsole: the CLI form of this file IS its output
  console.log(JSON.stringify(floorlessGuards(), null, 2))
}
