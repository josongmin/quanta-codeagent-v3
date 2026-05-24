import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadEnvFiles } from "../../src/apps/cli/dotenv"

const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

let envSnapshot: NodeJS.ProcessEnv

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  // Fully restore process.env so tests cannot leak vars into each other.
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  Object.assign(process.env, envSnapshot)
})

let counter = 0
const envFile = (contents: string): string => {
  const path = join(dir, `env-${counter++}.env`)
  writeFileSync(path, contents)
  return path
}

describe("loadEnvFiles", () => {
  test("parses simple KEY=VALUE pairs", () => {
    const f = envFile("FOO=bar\nBAZ=qux\n")
    loadEnvFiles([f])
    expect(process.env.FOO).toBe("bar")
    expect(process.env.BAZ).toBe("qux")
  })

  test("ignores blank lines and comment lines", () => {
    const f = envFile("\n# a comment\n   \nALPHA=1\n#BETA=2\n")
    loadEnvFiles([f])
    expect(process.env.ALPHA).toBe("1")
    expect(process.env.BETA).toBeUndefined()
  })

  test("strips matching double and single quotes", () => {
    const f = envFile(`DQ="hello world"\nSQ='single val'\n`)
    loadEnvFiles([f])
    expect(process.env.DQ).toBe("hello world")
    expect(process.env.SQ).toBe("single val")
  })

  test("does not strip mismatched or unbalanced quotes", () => {
    const f = envFile(`MISMATCH="oops'\nLEADONLY="open\n`)
    loadEnvFiles([f])
    expect(process.env.MISMATCH).toBe(`"oops'`)
    expect(process.env.LEADONLY).toBe(`"open`)
  })

  test("trims whitespace around key and value", () => {
    const f = envFile("  SPACED   =   value here  \n")
    loadEnvFiles([f])
    expect(process.env.SPACED).toBe("value here")
  })

  test("skips lines with no '=' or an empty key", () => {
    const f = envFile("NOTAPAIR\n=novalue\nGOOD=ok\n")
    loadEnvFiles([f])
    expect(process.env.GOOD).toBe("ok")
    expect(process.env.NOTAPAIR).toBeUndefined()
    expect(process.env[""]).toBeUndefined()
  })

  test("keeps '=' inside the value (only first '=' splits)", () => {
    const f = envFile("URL=postgres://u:p@h/db?x=1\n")
    loadEnvFiles([f])
    expect(process.env.URL).toBe("postgres://u:p@h/db?x=1")
  })

  test("strips a leading `export ` prefix (shell-sourceable .env)", () => {
    const f = envFile(`export EXPORTED=yes\nexport QUOTED="with space"\nPLAIN=raw\n`)
    loadEnvFiles([f])
    expect(process.env.EXPORTED).toBe("yes")
    expect(process.env.QUOTED).toBe("with space")
    expect(process.env.PLAIN).toBe("raw")
    // The literal `export FOO` key must NOT be created.
    expect(process.env["export EXPORTED"]).toBeUndefined()
  })

  test("a key literally named `export` (no space) is left intact", () => {
    // Only the `export ` PREFIX (with a space) is stripped; `export=1` is a
    // legitimate KEY=VALUE pair and must round-trip unchanged.
    const f = envFile("export=1\n")
    loadEnvFiles([f])
    expect(process.env.export).toBe("1")
  })

  test("does not override a value already set in process.env", () => {
    // Real env-access verification: clear first to undefined to prove the
    // preset write is what makes the assertion pass (not stale state).
    process.env.PRESET = undefined
    process.env.PRESET = "from-real-env"
    const f = envFile("PRESET=from-file\n")
    loadEnvFiles([f])
    expect(process.env.PRESET).toBe("from-real-env")
    // Cleanup so the next test starts clean (matches `= undefined` pattern).
    process.env.PRESET = undefined
  })

  test("first file wins over later files for the same key", () => {
    const first = envFile("SHARED=first\n")
    const second = envFile("SHARED=second\n")
    loadEnvFiles([first, second])
    expect(process.env.SHARED).toBe("first")
  })

  test("a missing file is a silent no-op", () => {
    const present = envFile("FROMPRESENT=yes\n")
    const missing = join(dir, "does-not-exist.env")
    expect(() => loadEnvFiles([missing, present])).not.toThrow()
    expect(process.env.FROMPRESENT).toBe("yes")
  })

  test("empty file list is a no-op", () => {
    expect(() => loadEnvFiles([])).not.toThrow()
  })
})
