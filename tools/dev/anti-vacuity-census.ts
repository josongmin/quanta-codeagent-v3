import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const R = join(import.meta.dir, "..", "..")
const SCAN =
  /\breaddirSync\s*\(|\bBun\.Glob\b|\bnew Glob\b|"ls-files"|\bglobSync\s*\(|\bopendirSync\s*\(/
const VERDICT =
  /\.toEqual\(\s*\[\s*\]\s*\)|\.toBeLessThanOrEqual\(|\.toHaveLength\(\s*0\s*\)|\.toBe\(\s*0\s*\)/
const NUMERIC_FLOOR = /\.toBeGreaterThan(?:OrEqual)?\(\s*([1-9]\d*)\s*\)/
const THROW_FLOOR = /vacuous|read no |far below|would pass over/i
/** Scans only a directory it created itself — the empty case is the assertion. */
const TEMP_ONLY = (s: string): boolean =>
  /mkdtempSync|mkdtemp\(/.test(s) && !/import\.meta\.dir|__dirname|REPO_ROOT|ls-files/.test(s)
const out: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith(".test.ts")) {
      const s = readFileSync(p, "utf8")
      if (!SCAN.test(s) || !VERDICT.test(s)) continue
      if (NUMERIC_FLOOR.test(s) || THROW_FLOOR.test(s)) continue
      if (TEMP_ONLY(s)) continue
      out.push(p.slice(R.length + 1))
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
export const floorlessGuards = (): readonly string[] => {
  out.length = 0
  walk(join(R, "tests"))
  walk(join(R, "src"))
  return out.sort()
}

if (import.meta.main) {
  console.log(JSON.stringify(floorlessGuards(), null, 2))
}
