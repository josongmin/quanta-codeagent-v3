/**
 * Adversarial scenario tests for the ast_grep tool.
 *
 * Covers error paths, output format, match cap, path behavior, and language flag.
 * Does NOT duplicate tests already in ast-grep-tool-hellgate.test.ts (structural)
 * or ast-grep-e2e-hellgate.test.ts (e2e integration + apply_patch).
 *
 * GROUP 1: S-PROBE-*  Probe / shape (always run, no binary needed)
 * GROUP 2: S-BIN-*    Binary-absent path (skip if binary IS available)
 * GROUP 3: S-FMT-*    Output format       (skip if binary NOT available)
 * GROUP 4: S-ZERO-*   Zero-match case     (skip if binary NOT available)
 * GROUP 5: S-CAP-*    Match cap           (skip if binary NOT available)
 * GROUP 6: S-PATH-*   Path argument       (skip if binary NOT available)
 * GROUP 7: S-LANG-*   Language flag       (skip if binary NOT available)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { z } from "zod"
import type { ToolContext, ToolEvent } from "@/tool"
import { astGrepTool } from "@/tool/ast-grep"
import { present } from "../_helpers/expect-present"

// ─── binary probe (sync, once) ──────────────────────────────────────────────

let astGrepAvailable = false
try {
  execSync("ast-grep --version", { stdio: "pipe" })
  astGrepAvailable = true
} catch {
  // binary absent
}

// ─── helper: drain the execute generator ────────────────────────────────────

async function runTool(input: unknown, cwd: string): Promise<{ ok: boolean; output: string }> {
  const ctx: ToolContext = { cwd, signal: new AbortController().signal }
  let last: { ok: boolean; output: string } = { ok: false, output: "no result" }
  for await (const ev of astGrepTool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") {
      last = { ok: ev.result.ok, output: String(ev.result.output) }
    }
  }
  return last
}

// ─── temp-directory lifecycle ────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "quanta-ast-scenarios-"))
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 1: Probe / shape — always run, no binary needed
// ════════════════════════════════════════════════════════════════════════════

describe("S-PROBE-1: execute exists and is a function", () => {
  test("astGrepTool.execute is a function", () => {
    // Red-on-injection: remove the execute property from defineTool → typeof is
    // "undefined" and this test fails, exposing a broken tool definition.
    expect(typeof astGrepTool.execute).toBe("function")
  })
})

describe("S-PROBE-2: tool name identity", () => {
  test('astGrepTool.name === "ast_grep"', () => {
    // Red-on-injection: rename the tool to "ast-grep" (with dash) → downstream
    // manifest lookup by "ast_grep" string fails; this test catches the rename.
    expect(astGrepTool.name).toBe("ast_grep")
  })
})

describe("S-PROBE-3: missing pattern field → schema rejects or execute returns error", () => {
  test("inputSchema.safeParse({}) returns success:false (zod rejects missing pattern)", () => {
    // Red-on-injection: make pattern optional in the zod schema → safeParse
    // succeeds on {} and no validation error is surfaced; this test fails.
    const schema = astGrepTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>
    const result = schema.safeParse({})
    expect(result.success).toBe(false)
  })

  test("calling execute with {} does not crash silently — either rejects or yields ok:false", async () => {
    // Red-on-injection: remove the zod parse guard in execute → the tool
    // receives undefined pattern, passes it to ast-grep as "undefined", and
    // produces a nonsense result with ok:true; this assertion catches that.
    let threw = false
    let result: { ok: boolean; output: string } | null = null
    try {
      result = await runTool({}, tmpDir)
    } catch {
      threw = true
    }
    // Acceptable outcomes: threw (zod hard-throws) OR returned ok:false.
    // What is NOT acceptable: returned ok:true with no error indication.
    if (!threw) {
      expect(result).not.toBeNull()
      // If it didn't throw, it must surface an error (ok:false) rather than
      // silently pretending the call succeeded.
      expect(present(result, "result").ok).toBe(false)
    }
    // Either path satisfies the contract; reaching here means no silent success.
    expect(threw || result?.ok === false).toBe(true)
  })
})

describe("S-PROBE-4: description contains 'pattern'", () => {
  test("description documents the key concept 'pattern'", () => {
    // Red-on-injection: remove the word "pattern" from description → the LLM
    // has no schema-level hint that this is the primary field; this test fails.
    expect(astGrepTool.description).toMatch(/pattern/i)
  })
})

describe("S-PROBE-5: description contains 'ast-grep'", () => {
  test("description contains tool identity 'ast-grep'", () => {
    // Red-on-injection: rename the binary reference in description to "sg" →
    // install hint becomes wrong; users cannot find the package; test fails.
    expect(astGrepTool.description).toMatch(/ast-grep/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 2: Binary-absent path
// Only run these if ast-grep is NOT installed on this machine.
// If it IS installed, skip: we cannot test the absent path without patching
// the module-level probe cache.
// ════════════════════════════════════════════════════════════════════════════

describe("S-BIN-1: execute with real args but no binary -> ok:false", () => {
  test.skipIf(astGrepAvailable)("yields ok:false when ast-grep binary is absent", async () => {
    // Red-on-injection: remove the probeAstGrep guard → the tool attempts to
    // exec ast-grep, which fails with a non-zero exit and the error falls
    // through to an unexpected code path; ok may become true; test fails.
    const result = await runTool({ pattern: "console.log($A)" }, tmpDir)
    expect(result.ok).toBe(false)
  })
})

describe("S-BIN-2: error message contains installation guidance", () => {
  test.skipIf(astGrepAvailable)("output mentions 'brew' or 'cargo' or 'install'", async () => {
    // Red-on-injection: strip the installation-hint string in probeAstGrep →
    // output is an empty or generic error; users get no actionable guidance;
    // this test fails.
    const result = await runTool({ pattern: "console.log($A)" }, tmpDir)
    expect(result.output).toMatch(/brew|cargo|install/i)
  })
})

describe("S-BIN-3: result shape is {ok:false, output:string} not a throw", () => {
  test.skipIf(astGrepAvailable)("binary-absent path returns object, does not throw", async () => {
    // Red-on-injection: replace the probeError yield with a bare `throw` →
    // the generator propagates an uncaught exception; callers crash; this
    // test fails because threw becomes true.
    let threw = false
    let result: { ok: boolean; output: string } | null = null
    try {
      result = await runTool({ pattern: "console.log($A)" }, tmpDir)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).not.toBeNull()
    expect(present(result, "result").ok).toBe(false)
    expect(typeof present(result, "result").output).toBe("string")
    expect(present(result, "result").output.length).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 3: Output format
// ════════════════════════════════════════════════════════════════════════════

describe("S-FMT-1: output line format matches /^.+:\\d+: .+/", () => {
  test.skipIf(!astGrepAvailable)("each match line is file:lineno: text", async () => {
    const file = join(tmpDir, "fmt1-sample.ts")
    writeFileSync(file, "console.log('hello');\n")

    const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    expect(result.ok).toBe(true)

    // Red-on-injection: remove the `${m.file}:${line + 1}: ${text}` format in
    // execute() → lines have no colon-separated structure; regex fails.
    const matchLines = result.output
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith("..."))
    expect(matchLines.length).toBeGreaterThan(0)
    for (const line of matchLines) {
      expect(line).toMatch(/^.+:\d+: .+/)
    }
  })
})

describe("S-FMT-2: line numbers are 1-indexed", () => {
  test.skipIf(!astGrepAvailable)("first line of file produces line number 1, not 0", async () => {
    const file = join(tmpDir, "fmt2-sample.ts")
    // Match is on line 1 (first line)
    writeFileSync(file, "console.log('first');\nfoo();\n")

    const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    expect(result.ok).toBe(true)

    // Red-on-injection: change `line + 1` to `line` in execute() → first match
    // reports line 0 instead of 1; this assertion fails.
    // The output should contain ":1:" (1-indexed line)
    expect(result.output).toMatch(/:1:/)
    // Must NOT contain ":0:" (0-indexed would be wrong)
    expect(result.output).not.toMatch(/:0:/)
  })
})

describe("S-FMT-3: multiple matches each appear on separate output lines", () => {
  test.skipIf(!astGrepAvailable)("3 matches → at least 3 non-empty output lines", async () => {
    const file = join(tmpDir, "fmt3-sample.ts")
    writeFileSync(file, "console.log('a');\nconsole.log('b');\nconsole.log('c');\n")

    const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    expect(result.ok).toBe(true)

    // Red-on-injection: join lines with "" instead of "\n" in execute() →
    // all matches collapse into one line; split produces only 1 element; test fails.
    const matchLines = result.output
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith("..."))
    expect(matchLines.length).toBeGreaterThanOrEqual(3)
  })
})

describe("S-FMT-4: file path in output matches the path passed in", () => {
  test.skipIf(!astGrepAvailable)("output lines contain the exact file path supplied", async () => {
    const file = join(tmpDir, "fmt4-sample.ts")
    writeFileSync(file, "console.log('x');\n")

    const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    expect(result.ok).toBe(true)

    // Red-on-injection: remove `m.file` from the line formatter → the file
    // path is absent from output; this assertion fails.
    // The path may be absolute or relative — at minimum it must contain the
    // filename portion.
    expect(result.output).toContain("fmt4-sample.ts")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 4: Zero-match case
// ════════════════════════════════════════════════════════════════════════════

describe("S-ZERO-1: pattern matching nothing → ok:true with empty/no-match output", () => {
  test.skipIf(!astGrepAvailable)("zero matches returns ok:true and empty-ish output", async () => {
    const file = join(tmpDir, "zero-sample.ts")
    writeFileSync(file, "const x = 1;\n")

    // Pattern that will never match the file content
    const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    expect(result.ok).toBe(true)

    // Red-on-injection: make the zero-match branch yield ok:false → callers
    // treat "no results" as an error; this test fails.
    // Output must be "no matches" string or empty — NOT a hard error.
    const lower = result.output.toLowerCase()
    const isNoMatch = lower.includes("no match") || lower === "" || result.output === "(no matches)"
    expect(isNoMatch).toBe(true)
  })
})

describe("S-ZERO-2: zero matches does not throw", () => {
  test.skipIf(!astGrepAvailable)("execute completes without throwing on zero matches", async () => {
    const file = join(tmpDir, "zero2-sample.ts")
    writeFileSync(file, "const y = 2;\n")

    // Red-on-injection: add `throw new Error("no matches")` in the zero-match
    // branch → runTool propagates the exception; threw becomes true; test fails.
    let threw = false
    try {
      await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 5: Match cap
// ════════════════════════════════════════════════════════════════════════════

describe("S-CAP-1: 60-match file → output has at most 50 match lines", () => {
  test.skipIf(!astGrepAvailable)(
    "result output contains ≤50 match lines when 60 exist",
    async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `console.log(${i});`)
      const file = join(tmpDir, "cap-60.js")
      writeFileSync(file, `${lines.join("\n")}\n`)

      const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
      expect(result.ok).toBe(true)

      // Red-on-injection: remove the `.slice(0, MAX_MATCHES)` call → all 60 lines
      // appear, this count check fails (60 > 50).
      const matchLines = result.output.split("\n").filter((l) => l.includes("console.log"))
      expect(matchLines.length).toBeLessThanOrEqual(50)
    },
  )
})

describe("S-CAP-2: cap hit → output contains a 'more' indicator", () => {
  test.skipIf(!astGrepAvailable)(
    "'... N more matches' appears when 60 matches exist (cap=50)",
    async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `console.log(${i});`)
      const file = join(tmpDir, "cap-60b.js")
      writeFileSync(file, `${lines.join("\n")}\n`)

      const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
      expect(result.ok).toBe(true)

      // Red-on-injection: remove the `more` suffix in execute() → users have no
      // indication that results were truncated; silent data loss; test fails.
      expect(result.output).toMatch(/\.\.\. \d+ more matches/)
    },
  )
})

describe("S-CAP-3: 5 matches → no 'more' indicator", () => {
  test.skipIf(!astGrepAvailable)(
    "output has no 'more matches' text when only 5 matches exist",
    async () => {
      const lines = Array.from({ length: 5 }, (_, i) => `console.log(${i});`)
      const file = join(tmpDir, "cap-5.js")
      writeFileSync(file, `${lines.join("\n")}\n`)

      const result = await runTool({ pattern: "console.log($A)", path: file }, tmpDir)
      expect(result.ok).toBe(true)

      // Red-on-injection: always append the "more matches" suffix regardless of
      // count → output incorrectly reports truncation; this test fails.
      expect(result.output).not.toMatch(/more matches/)
    },
  )
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 6: Path argument behavior
// ════════════════════════════════════════════════════════════════════════════

describe("S-PATH-1: path=undefined → searches current dir, no crash", () => {
  test.skipIf(!astGrepAvailable)("omitting path argument does not crash or throw", async () => {
    // Red-on-injection: make path required (remove optional()) → the schema
    // rejects the call; execute throws; this test fails.
    let threw = false
    let result: { ok: boolean; output: string } | null = null
    try {
      // Intentionally omit path so it searches cwd (tmpDir)
      result = await runTool({ pattern: "console.log($A)" }, tmpDir)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).not.toBeNull()
    expect(typeof present(result, "result").ok).toBe("boolean")
    expect(typeof present(result, "result").output).toBe("string")
  })
})

describe("S-PATH-2: path=specific file → only that file's matches returned", () => {
  test.skipIf(!astGrepAvailable)(
    "when path is a single file, output only mentions that file",
    async () => {
      const fileA = join(tmpDir, "path2-a.ts")
      const fileB = join(tmpDir, "path2-b.ts")
      writeFileSync(fileA, "console.log('from-a');\n")
      writeFileSync(fileB, "console.log('from-b');\n")

      // Pass only fileA
      const result = await runTool({ pattern: "console.log($A)", path: fileA }, tmpDir)
      expect(result.ok).toBe(true)

      // Red-on-injection: ignore the path argument and always search cwd →
      // output contains both files; "path2-b.ts" appears; this assertion fails.
      expect(result.output).not.toContain("path2-b.ts")
      expect(result.output).toContain("path2-a.ts")
    },
  )
})

describe("S-PATH-3: path=nonexistent → ok:false or empty, no throw or crash", () => {
  test.skipIf(!astGrepAvailable)(
    "nonexistent path returns a result object without throwing",
    async () => {
      // Red-on-injection: remove the `r.exitCode > 1` guard in execute() →
      // JSON.parse("") throws SyntaxError, propagating out of the generator;
      // callers crash; threw becomes true; test fails.
      let threw = false
      let result: { ok: boolean; output: string } | null = null
      try {
        result = await runTool(
          { pattern: "console.log($A)", path: "/tmp/no-such-dir-xyzzy-scenario-99/file.ts" },
          tmpDir,
        )
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(result).not.toBeNull()
      // Either ok:false with error, or ok:true with empty/no-match
      expect(typeof present(result, "result").ok).toBe("boolean")
      expect(typeof present(result, "result").output).toBe("string")
    },
  )
})

// ════════════════════════════════════════════════════════════════════════════
// GROUP 7: Language flag
// ════════════════════════════════════════════════════════════════════════════

describe("S-LANG-1: language='typescript' with .ts file → valid results", () => {
  test.skipIf(!astGrepAvailable)(
    "explicit typescript language produces ok:true on a TS file",
    async () => {
      const file = join(tmpDir, "lang1-sample.ts")
      writeFileSync(file, "console.log('ts');\n")

      // Red-on-injection: break the --lang argument construction (e.g. add a
      // spurious space) → ast-grep rejects the flag; exitCode > 1; ok:false;
      // this test fails.
      const result = await runTool(
        { pattern: "console.log($A)", path: file, language: "typescript" },
        tmpDir,
      )
      expect(result.ok).toBe(true)
      expect(typeof result.output).toBe("string")
    },
  )
})

describe("S-LANG-2: language='nonexistentlang999' → ok:false with error, no throw", () => {
  test.skipIf(!astGrepAvailable)("bogus language returns ok:false and does not throw", async () => {
    const file = join(tmpDir, "lang2-sample.ts")
    writeFileSync(file, "console.log('lang2');\n")

    // Red-on-injection: remove the `r.exitCode > 1` guard → an invalid-language
    // error from ast-grep falls through to JSON.parse of the stderr text, which
    // throws; callers crash; threw becomes true; test fails.
    let threw = false
    let result: { ok: boolean; output: string } | null = null
    try {
      result = await runTool(
        { pattern: "console.log($A)", path: file, language: "nonexistentlang999" },
        tmpDir,
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).not.toBeNull()
    // Must signal failure — ok:false — not silently succeed
    expect(present(result, "result").ok).toBe(false)
    expect(typeof present(result, "result").output).toBe("string")
    expect(present(result, "result").output.length).toBeGreaterThan(0)
  })
})
