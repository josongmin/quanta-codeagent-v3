import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = readFileSync(join(import.meta.dir, "../../src/apps/eval/index.ts"), "utf8")
const HEAVY_ROOTS = [
  "audit",
  "compare",
  "grounding",
  "public",
  "report",
  "synthetic",
  "taxonomy",
  "trajectory",
] as const

const staticHeavyImports = (source: string): readonly string[] =>
  source
    .split("\n")
    .filter((line) =>
      HEAVY_ROOTS.some((root) => new RegExp(`^import .+ from "\\./${root}"$`).test(line)),
    )

const dynamicHeavyCalls = (source: string): readonly string[] =>
  source.match(
    /await import\("\.\/(?:audit|compare|grounding|public|report|synthetic|taxonomy|trajectory)"\)/g,
  ) ?? []

describe("eval CLI lazy-import hellgate", () => {
  test("heavy command graphs stay behind executable dynamic-import calls", () => {
    expect(staticHeavyImports(SOURCE)).toEqual([])
    expect(dynamicHeavyCalls(SOURCE).length).toBe(13)
  })

  test("paired controls reject a static re-import and a removed call", () => {
    const staticRegression = `import { runAudit } from "./audit"\n${SOURCE}`
    expect(staticHeavyImports(staticRegression)).toEqual(['import { runAudit } from "./audit"'])

    const callRegression = SOURCE.replace('await import("./trajectory")', "Promise.resolve({})")
    expect(dynamicHeavyCalls(callRegression).length).toBe(12)
  })
})
