import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const indexSource = readFileSync(resolve(ROOT, "src/apps/cli/index.ts"), "utf8")
const sessionSource = readFileSync(resolve(ROOT, "src/apps/cli/session-main.ts"), "utf8")
const focusedEntrySource = readFileSync(
  resolve(ROOT, "src/apps/cli/session-command-entry.ts"),
  "utf8",
)

const sessionRouteIsLazy = (source: string): boolean =>
  /process\.argv\[2\]\s*===\s*"session"[\s\S]*?await import\("\.\/session-main"\)[\s\S]*?runSessionMain\s*\(/u.test(
    source,
  )

describe("CLI session route stays off the REPL/agent startup graph", () => {
  test("public CLI dynamically reaches the focused production session entry", () => {
    expect(sessionRouteIsLazy(indexSource)).toBe(true)
    expect(indexSource).not.toMatch(/import\s*\{[^}]*runSessionMain[^}]*\}\s*from/u)
    expect(
      sessionRouteIsLazy(indexSource.replace('await import("./session-main")', "undefined")),
    ).toBe(false)
  })

  test("focused entry has an anti-vacuum command call and no REPL/agent imports", () => {
    expect(sessionSource.match(/runSessionCommand\s*\(/gu)?.length).toBe(1)
    expect(sessionSource).not.toMatch(/from\s+"@\/agent|from\s+"\.\/repl/u)
    expect(sessionSource.replace(/runSessionCommand\s*\(/u, "removed(")).not.toMatch(
      /runSessionCommand\s*\(/u,
    )
  })

  test("subprocess entry calls the same focused production function", () => {
    expect(focusedEntrySource).toContain('import { runSessionMain } from "./session-main"')
    expect(focusedEntrySource).toMatch(/runSessionMain\s*\(process\.argv\.slice\(2\)\)/u)
    expect(
      focusedEntrySource.replace(/runSessionMain\s*\(/u, "removed(").match(/runSessionMain\s*\(/gu)
        ?.length ?? 0,
    ).toBe(0)
  })
})
