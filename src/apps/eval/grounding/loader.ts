import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseGroundingCase, type GroundingCase, type GroundingSuite } from "./schema"

const DEFAULT_CASES_ROOT = join(import.meta.dir, "cases")

const listJson = (dir: string): readonly string[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort()
}

export interface LoadGroundingCasesOpts {
  suite: GroundingSuite
  casesRoot?: string
}

export const loadGroundingCases = (opts: LoadGroundingCasesOpts): readonly GroundingCase[] => {
  const root = opts.casesRoot ?? DEFAULT_CASES_ROOT
  const dirs =
    opts.suite === "canary" ? [join(root, "canary")] : [join(root, "canary"), join(root, "nightly")]
  const seen = new Set<string>()
  const out: GroundingCase[] = []
  for (const dir of dirs) {
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`grounding cases path is not a directory: ${dir}`)
    }
    for (const file of listJson(dir)) {
      const parsed = parseGroundingCase(JSON.parse(readFileSync(file, "utf8")))
      if (seen.has(parsed.id)) throw new Error(`duplicate grounding case id: ${parsed.id}`)
      seen.add(parsed.id)
      out.push(parsed)
    }
  }
  return out
}
