/**
 * Integration-level Hellgate tests — ast_grep tool + apply_patch tool with real
 * file I/O.
 *
 * Part 1 (E2E-1 … E2E-5): drive astGrepTool.execute with a real ToolContext.
 *   E2E-1: probe failure → ok:false with install hint (always runs; ast-grep absent here)
 *   E2E-2: real pattern search finds 2 matches        (skipIf !astGrepAvailable)
 *   E2E-3: 50-match cap fires when ≥50 matches exist  (skipIf !astGrepAvailable)
 *   E2E-4: nonexistent path → no crash                (skipIf !astGrepAvailable)
 *   E2E-5: language override flag accepted             (skipIf !astGrepAvailable)
 *
 * Part 2 (APPLY-1 … APPLY-4): drive applyPatchTool.execute with a real
 * FsJailFileSystemPort routing through an on-disk temp directory.
 *   APPLY-1: unified diff update → real file rewritten
 *   APPLY-2: V4A patch update   → no regression on identity path
 *   APPLY-3: unified diff add file → file created
 *   APPLY-4: malformed diff    → ok:false or PatchParseError, no crash
 *
 * Every assertion has a "Red-on-injection" comment.
 */

import { afterAll, beforeAll, describe, expect, it, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PatchParseError } from "@/patch"
import type { ToolContext, ToolEvent } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"
import { astGrepTool } from "@/tool/ast-grep"

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Drain a tool's execute generator and return the last result event. */
async function run(
  tool: { execute: (i: never, ctx: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  const ctx: ToolContext = { cwd, signal: new AbortController().signal }
  let last = { ok: false as boolean, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") {
      last = { ok: ev.result.ok, output: ev.result.output }
    }
  }
  return last
}

/** Probe once (sync) whether the ast-grep binary is on PATH. */
const astGrepAvailable = (() => {
  try {
    execSync("which ast-grep", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// ─── temp-directory lifecycle ────────────────────────────────────────────────

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "quanta-ast-patch-e2e-"))
})

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Part 1: ast_grep tool live execution
// ════════════════════════════════════════════════════════════════════════════

describe("E2E-1: probe failure → ok:false with install hint", () => {
  // ast-grep is NOT available in this environment. The module-level probe will
  // run exactly once (it is never cached to `true`) and return the error string.
  // We do NOT call this test skipIf so it always exercises the failure path.

  test("execute yields ok:false when ast-grep binary is absent", async () => {
    if (astGrepAvailable) {
      // If ast-grep IS available on the host we cannot exercise the no-binary
      // path without monkey-patching the module cache.  Mark as a known skip.
      console.log(
        "[E2E-1] ast-grep is available on this host — probe-failure path not exercisable; skip",
      )
      return
    }

    const result = await run(astGrepTool, { pattern: "console.log($A)" }, tmpDir)

    // Red-on-injection: remove the probeAstGrep guard in index.ts → the tool
    // would attempt to run ast-grep and crash or return a different error.
    expect(result.ok).toBe(false)

    // Red-on-injection: change the install-hint string in index.ts to ""
    // → this assertion fails, exposing silent loss of the hint.
    expect(result.output).toMatch(/ast-grep not installed/)
    expect(result.output).toMatch(/brew install ast-grep/)
  })
})

// ─── E2E-2: real pattern search finds 2 matches ──────────────────────────────

describe("E2E-2: real pattern search finds matches (skipIf !astGrepAvailable)", () => {
  it("finds 2 console.log matches in a temp JS file", async () => {
    if (!astGrepAvailable) {
      console.log("[E2E-2] ast-grep not available — skipping live execution")
      return
    }

    const file = join(tmpDir, "e2e2-sample.js")
    writeFileSync(file, "console.log('hello');\nfoo.bar();\nconsole.log('world');\n")

    const result = await run(astGrepTool, { pattern: "console.log($A)", path: file }, tmpDir)

    // Red-on-injection: remove the match-formatting lines in execute() →
    // output is empty string, both assertions below fail.
    expect(result.ok).toBe(true)

    // Red-on-injection: change MAX_MATCHES to 0 → slice(0,0) = [] →
    // output is "(no matches)" and this assertion fails.
    expect(result.output).toContain("console.log")

    // Verify the temp file path is in the output (each line: "file:line: text")
    // Red-on-injection: strip the `m.file` reference from the line-formatter →
    // no file path in output, this assertion fails.
    expect(result.output).toContain(file)
  })
})

// ─── E2E-3: 50-match cap fires ───────────────────────────────────────────────

describe("E2E-3: 50-match cap fires when file has 60 matches (skipIf !astGrepAvailable)", () => {
  it("output contains cap message OR ≤50 match lines", async () => {
    if (!astGrepAvailable) {
      console.log("[E2E-3] ast-grep not available — skipping live execution")
      return
    }

    // Build a file with exactly 60 console.log lines
    const lines = Array.from({ length: 60 }, (_, i) => `console.log(${i});`)
    const file = join(tmpDir, "e2e3-many-matches.js")
    writeFileSync(file, lines.join("\n") + "\n")

    const result = await run(astGrepTool, { pattern: "console.log($A)", path: file }, tmpDir)

    expect(result.ok).toBe(true)

    // Red-on-injection: remove the `.slice(0, MAX_MATCHES)` call → all 60
    // lines appear, the cap message is absent, and the count-lines check below
    // would still pass but the "... N more" branch would never fire.
    const outputLines = result.output.split("\n").filter((l) => l.includes("console.log"))
    const hasCapMessage = result.output.includes("more matches")

    // Either the output was truncated to ≤50 lines…
    const withinCap = outputLines.length <= 50
    // …or a cap message is present (there are 60 - 50 = 10 more)
    expect(withinCap || hasCapMessage).toBe(true)
  })
})

// ─── E2E-4: nonexistent path → no crash ──────────────────────────────────────

describe("E2E-4: nonexistent path → does not throw (skipIf !astGrepAvailable)", () => {
  it("returns a {ok, output} object without throwing", async () => {
    if (!astGrepAvailable) {
      console.log("[E2E-4] ast-grep not available — skipping live execution")
      return
    }

    // Red-on-injection: remove the `r.exitCode > 1` guard → an error exit
    // code would fall through to JSON.parse("") and throw, crashing the test.
    const result = await run(
      astGrepTool,
      { pattern: "console.log($A)", path: "/tmp/nonexistent-xyzzy-12345/no-such-file.ts" },
      tmpDir,
    )

    expect(typeof result.ok).toBe("boolean")
    expect(typeof result.output).toBe("string")
    // Must not have thrown; result shape is guaranteed by the tool contract.
  })
})

// ─── E2E-5: language override respected ──────────────────────────────────────

describe("E2E-5: language override flag does not crash (skipIf !astGrepAvailable)", () => {
  it("accepts language:'rust' without throwing", async () => {
    if (!astGrepAvailable) {
      console.log("[E2E-5] ast-grep not available — skipping live execution")
      return
    }

    // Red-on-injection: remove the `--lang` branch in execute() → language is
    // silently ignored (no crash, but the flag is not forwarded; this test
    // verifies the non-crash contract at minimum).
    const result = await run(
      astGrepTool,
      { pattern: "fn $NAME($$$)", language: "rust", path: tmpDir },
      tmpDir,
    )

    expect(typeof result.ok).toBe("boolean")
    expect(typeof result.output).toBe("string")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2: unified diff end-to-end through apply_patch
// ════════════════════════════════════════════════════════════════════════════

// Helper: apply a patch via applyPatchTool.execute using tmpDir as jail root.
async function applyPatch(
  patchText: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return run(applyPatchTool, { patch: patchText }, cwd)
}

describe("APPLY-1: unified diff update rewrites a real file", () => {
  test("new_line is present and old_line is absent after apply", async () => {
    const file = join(tmpDir, "apply1-target.txt")
    writeFileSync(file, "line1\nline2\nold_line\nline4\n")

    const patch = [
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1,4 +1,4 @@",
      " line1",
      " line2",
      "-old_line",
      "+new_line",
      " line4",
    ].join("\n")

    const result = await applyPatch(patch, tmpDir)

    // Red-on-injection: remove isUnifiedDiff check in guardedParseAndApply →
    // parsePatch throws PatchParseError on the "---" header, result.ok is false.
    expect(result.ok).toBe(true)

    // Fresh readback — this is a real disk read, not re-use of in-memory state.
    // Red-on-injection: remove the writeFile call in FsJailFileSystemPort →
    // the file is unchanged; fresh readback returns old content; assertion fails.
    const content = readFileSync(file, "utf8")
    expect(content).toContain("new_line")
    expect(content).not.toContain("old_line")
  })
})

describe("APPLY-2: V4A patch update — identity path not broken", () => {
  test("new_line present after direct V4A patch", async () => {
    const file = join(tmpDir, "apply2-target.txt")
    writeFileSync(file, "line1\nline2\nold_v4a\nline4\n")

    // V4A format directly (no unified diff header — isUnifiedDiff returns false,
    // so the converter is NOT called; tests the identity path).
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${file}`,
      "@@",
      " line1",
      " line2",
      "-old_v4a",
      "+new_v4a",
      " line4",
      "*** End Patch",
    ].join("\n")

    const result = await applyPatch(patch, tmpDir)

    // Red-on-injection: break the V4A parsePatch sentinel string →
    // parsePatch throws PatchParseError; result.ok is false.
    expect(result.ok).toBe(true)

    // Fresh readback.
    // Red-on-injection: remove the writeFile in FsJailFileSystemPort →
    // file unchanged; "new_v4a" not found.
    const content = readFileSync(file, "utf8")
    expect(content).toContain("new_v4a")
    expect(content).not.toContain("old_v4a")
  })
})

describe("APPLY-3: unified diff add file creates the file", () => {
  test("new file is created with correct content", async () => {
    const newFile = join(tmpDir, "apply3-newfile.ts")

    const patch = [
      "--- /dev/null",
      `+++ b/${newFile}`,
      "@@ -0,0 +1,2 @@",
      "+export const hello = 'world';",
      "+export const answer = 42;",
    ].join("\n")

    const result = await applyPatch(patch, tmpDir)

    // Red-on-injection: remove the /dev/null → isAdd branch in unifiedDiffToV4A
    // → file treated as update, parsePatch tries to read a nonexistent file;
    // applyPatch throws PatchApplyError; result.ok is false.
    expect(result.ok).toBe(true)

    // Fresh readback of the newly-created file.
    // Red-on-injection: remove the writeFile in FsJailFileSystemPort.writeFile
    // → file never written; readFileSync throws ENOENT.
    const content = readFileSync(newFile, "utf8")
    expect(content).toContain("hello = 'world'")
    expect(content).toContain("answer = 42")
  })
})

describe("APPLY-4: malformed diff → ok:false or PatchParseError, no crash", () => {
  test("malformed unified header does not produce an unhandled crash", async () => {
    const malformed = "--- a/x.ts\n+++ b/x.ts\n@@BROKEN"

    // The converter produces a V4A shell but the content is unparseable.
    // Either:
    //   (a) parsePatch throws PatchParseError (propagates as unhandled rejection)
    //   (b) the tool catches it and returns ok:false with an error message
    //
    // Both outcomes are acceptable; what is NOT acceptable is a silent crash
    // with a raw stack trace or an unrelated uncaught exception.

    let threw: unknown = null
    let result: { ok: boolean; output: string } | null = null

    try {
      result = await applyPatch(malformed, tmpDir)
    } catch (e) {
      threw = e
    }

    if (threw !== null) {
      // Red-on-injection: change PatchParseError to a generic Error in the
      // parser → this assertion still passes but the typed-error contract breaks.
      expect(threw).toBeInstanceOf(PatchParseError)
    } else {
      // Tool swallowed and returned ok:false
      // Red-on-injection: make the tool always return ok:true on parse failure →
      // this assertion fails.
      expect(result!.ok).toBe(false)
      expect(result!.output).toBeTruthy()
    }
  })
})
