import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")
const cliSource = readFileSync(join(ROOT, "src/apps/cli/index.ts"), "utf8")
const entrySource = readFileSync(join(ROOT, "src/apps/cli/serve-stdio-entry.ts"), "utf8")

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0

const hasFocusedServeChain = (cli: string, entry: string): boolean =>
  count(cli, /await import\("\.\/serve-stdio-entry"\)/g) === 1 &&
  count(cli, /runServeStdioEntry\s*\(serveArgv\)/g) === 1 &&
  count(entry, /runServeStdioCmd\s*\(argv\)/g) === 1

describe("serve stdio focused-entry wiring hellgate", () => {
  test("the public CLI route reaches the real command through exactly one focused entry", () => {
    expect(hasFocusedServeChain(cliSource, entrySource)).toBe(true)
  })

  test("paired mutations prove every call edge is required", () => {
    expect(
      hasFocusedServeChain(
        cliSource.replace("runServeStdioEntry(serveArgv)", "Promise.resolve(0)"),
        entrySource,
      ),
    ).toBe(false)
    expect(
      hasFocusedServeChain(
        cliSource,
        entrySource.replace("runServeStdioCmd(argv)", "Promise.resolve(0)"),
      ),
    ).toBe(false)
  })
})
