import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../../../..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const forbiddenFrontendDerivations = (source: string): readonly string[] =>
  ["sourceDigest", ".completion"].filter((token) => source.includes(token))

describe("R2 — freshness stays host-owned", () => {
  test("CLI and web live read paths each call the canonical reconcile operation", () => {
    const calls = [
      ...(read("src/apps/cli/slash/goal-cmd.ts").match(/reconcileAndRead\s*\(/g) ?? []),
      ...(read("src/apps/web-daemon/readout-compose.ts").match(/reconcileObjectiveRead\s*\(/g) ??
        []),
    ]
    expect(calls).toHaveLength(2)
  })

  test("browser runtime does not reconstruct source digest or completion receipts", () => {
    const runtime = [
      read("apps/web-frontend/src/components/slash-goal.ts"),
      read("apps/web-frontend/src/components/slash-readout.ts"),
    ].join("\n")
    expect(runtime.length).toBeGreaterThan(1_000)
    expect(forbiddenFrontendDerivations(runtime)).toEqual([])
  })

  test("red-on-injection: either forbidden derivation is reported by name", () => {
    expect(forbiddenFrontendDerivations("const x = payload.sourceDigest")).toEqual(["sourceDigest"])
    expect(forbiddenFrontendDerivations("const x = criterion.completion")).toEqual([".completion"])
  })
})
