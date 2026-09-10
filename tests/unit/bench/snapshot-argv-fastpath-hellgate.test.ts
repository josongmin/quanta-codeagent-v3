import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(
  resolve(import.meta.dir, "../../../src/runner/batch/eval/snapshot.ts"),
  "utf8",
)

const hasArgvFastPath = (text: string): boolean => {
  const calls = text.match(/execArgv\s*\(/gu)?.length ?? 0
  return (
    calls >= 8 &&
    text.includes('["git", "rev-parse", "--git-dir"]') &&
    text.includes('["git", "init", "-q", "."]') &&
    !text.includes('exec("git rev-parse --git-dir"') &&
    !text.includes("exec(prep")
  )
}

describe("bench snapshot fixed git operations stay argv-native", () => {
  test("anti-vacuum fast path rejects either shell-wrapper regression", () => {
    expect(hasArgvFastPath(source)).toBe(true)
    expect(hasArgvFastPath(source.replaceAll("execArgv", "exec"))).toBe(false)
    expect(
      hasArgvFastPath(
        source.replace(
          'execArgv(["git", "rev-parse", "--git-dir"], sandbox, timeoutMs)',
          'exec("git rev-parse --git-dir", sandbox, timeoutMs)',
        ),
      ),
    ).toBe(false)
  })
})
