import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Hellgate: prevent .test.js artifact contamination.
 *
 * Symptom this catches: stale TS-emit lying next to .test.ts source, causing
 * double execution at test time and slow gate. Reproduced 2026-05-25 with 520
 * orphan .test.js files / 505 sibling pairs (T1 cleanup commit).
 *
 * Enforcement: filesystem walk asserts zero .test.js under tests/.
 */
function findTestJs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) findTestJs(full, out)
    else if (entry.name.endsWith(".test.js")) out.push(full)
  }
  return out
}

describe("no .test.js artifacts under tests/", () => {
  test("zero .test.js files exist", () => {
    const victims = findTestJs("tests")
    expect(victims).toEqual([])
  })

  test("zero sibling .test.js for any .test.ts (defense-in-depth)", () => {
    const findTestTs = (root: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        const full = join(root, entry.name)
        if (entry.isDirectory()) findTestTs(full, out)
        else if (entry.name.endsWith(".test.ts")) out.push(full)
      }
      return out
    }
    const siblings = findTestTs("tests")
      .map((ts) => ts.replace(/\.test\.ts$/, ".test.js"))
      .filter((js) => {
        try {
          statSync(js)
          return true
        } catch {
          return false
        }
      })
    expect(siblings).toEqual([])
  })
})
