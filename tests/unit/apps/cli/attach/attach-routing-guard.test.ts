/**
 * Routing guard for the `quanta attach` subcommand (jun-09 audit, finding #8).
 *
 * The attach route in `src/apps/cli/index.ts` MUST be gated strictly on
 * `process.argv[2] === "attach"` so a bare `quanta` run (and every other
 * subcommand / flag / slash invocation) is byte-identical: it never reaches the
 * `await import("./attach-cmd")` dynamic import nor `runAttachCmd`. A looser
 * guard (e.g. `argv.includes("attach")`, or a positional scan that treats the
 * first non-flag token as the subcommand) would let a prompt containing the
 * word "attach", or a resume path, accidentally open a WebSocket — a real
 * regression. These tests pin BOTH the behavioral decision and the source form.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const INDEX_PATH = resolve(REPO_ROOT, "src/apps/cli/index.ts")

/**
 * The EXACT routing decision the entrypoint makes for the attach branch:
 * strict positional equality on `argv[2]` (the subcommand slot). Mirrors
 * `if (process.argv[2] === "attach")` in `index.ts`. Kept here as a pure
 * predicate so the byte-identical guarantee is unit-testable without importing
 * `index.ts` (which has top-level side effects + invokes `main()`).
 */
const routesToAttach = (argv: readonly string[]): boolean => argv[2] === "attach"

describe("attach routing guard — only argv[2] === 'attach' reaches the attach path", () => {
  test("the exact `quanta attach …` invocation routes to attach", () => {
    expect(routesToAttach(["node", "quanta", "attach"])).toBe(true)
    expect(routesToAttach(["node", "quanta", "attach", "ws://x/"])).toBe(true)
  })

  test("a bare `quanta` (no subcommand) does NOT route to attach (byte-identical default)", () => {
    expect(routesToAttach(["node", "quanta"])).toBe(false)
  })

  test("non-attach subcommands / flags / slash / prompt tokens never route to attach", () => {
    for (const tail of [
      [], // bare
      ["session"],
      ["remote"],
      ["batch"],
      ["mcp-server"],
      ["/memory"],
      ["--help"],
      ["-h"],
      ["-p", "attach the file to the report"], // "attach" only as a later token
      ["./resume/path/attach"], // a path that merely contains "attach"
      ["ATTACH"], // case-sensitive: not the subcommand
      ["attach-cmd"], // not an exact match
    ]) {
      expect(routesToAttach(["node", "quanta", ...tail])).toBe(false)
    }
  })

  test("the word 'attach' appearing as a non-subcommand argv token never routes", () => {
    // A prompt that merely MENTIONS attach must not open a socket.
    expect(routesToAttach(["node", "quanta", "-p", "please attach the log"])).toBe(false)
    expect(routesToAttach(["node", "quanta", "run", "attach"])).toBe(false)
  })
})

describe("attach routing guard — source form is the strict positional gate", () => {
  const source = readFileSync(INDEX_PATH, "utf8")

  test("index.ts gates the attach route on exact `process.argv[2] === \"attach\"`", () => {
    expect(source).toContain('process.argv[2] === "attach"')
  })

  test("the attach route is NOT gated on a loose `.includes(\"attach\")`", () => {
    // A `process.argv.includes("attach")` (or `.slice(2).includes`) would let a
    // later argv token trip the route — the strict equality above forbids it.
    expect(source).not.toMatch(/argv[^\n]*\.includes\(\s*["']attach["']\s*\)/)
  })

  test("the attach branch lazily imports ./attach-cmd (kept off the common startup path)", () => {
    expect(source).toContain('await import("./attach-cmd")')
  })
})
