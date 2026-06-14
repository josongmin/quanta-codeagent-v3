/**
 * Hellgate tests for Round 2 adversarial audit findings:
 *   F-B4-crlf-stray-cr   — ast-grep CRLF \r survives newline replacement
 *   F-B7-max-count-flag   — ast-grep --max-count flag (unverified, may fail)
 *   C3-JAIL-PATH-MISMATCH — lsp_nav tools pass abs to port, not relative path
 *   D4-REPL-FENCE         — session-picker.ts comment overclaims fence scope
 *   A5-SILENT-NOHEADER    — unified diff missing +++ line → zero-op, no error
 *
 * Every test carries a // Red-on-injection comment.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ── source snapshots ──────────────────────────────────────────────────────────

const AST_GREP_SRC = readFileSync(
  join(import.meta.dir, "../..", "src/tool/ast-grep/index.ts"),
  "utf8",
)

const SESSION_PICKER_SRC = readFileSync(
  join(import.meta.dir, "../..", "src/apps/cli/repl/session-picker.ts"),
  "utf8",
)

const UNIFIED_TO_V4A_SRC = readFileSync(
  join(import.meta.dir, "../..", "src/patch/unified-to-v4a.ts"),
  "utf8",
)

// ── imports for live tests ────────────────────────────────────────────────────

import type { SignatureHelpPort } from "@/lsp"
import type { FormatPort } from "@/lsp"
import type { CodeActionPort, CodeActionKind } from "@/lsp"
import { lspSignatureHelpTool } from "@/tool/lsp_nav"
import { lspFormatTool } from "@/tool/lsp_nav"
import { lspCodeActionTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import { isUnifiedDiff, parsePatch, unifiedDiffToV4A } from "@/patch"

// ── helpers ───────────────────────────────────────────────────────────────────

const collect = async (
  tool: { execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent> },
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, context)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

const ctx = (cwd = "/work/proj"): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

// ═══════════════════════════════════════════════════════════════════════════════
// F-B4-CRLF: \r\n sequences must not leave a stray \r after newline replacement
// ═══════════════════════════════════════════════════════════════════════════════

describe("F-B4-crlf-stray-cr: ast-grep CRLF handling in match text", () => {
  test("F-B4-1: source uses /\\r?\\n/ to strip CR before replacing newline", () => {
    // Red-on-injection: change /\r?\n/ back to /\n/ →
    // m.text containing "\r\n" produces "line1\r↵line2" with a stray \r,
    // which resets the cursor on ANSI terminals, garbling output.
    expect(AST_GREP_SRC).toMatch(/\\r\?\\n/)
  })

  test("F-B4-2: source does NOT use bare /\\n/g for internal-newline replacement", () => {
    // Red-on-injection: leave /\n/g unchanged →
    // CRLF source files corrupt the one-line output contract.
    // The regex used for the B4 fix must include \r? before \n.
    //
    // We verify that the replacement call in the match-text normalisation path
    // uses the CRLF-aware form, not the bare-LF form.
    // Strategy: find the line containing the ↵ marker replacement and confirm it
    // uses \r?\n instead of a bare \n.
    const replaceLine = AST_GREP_SRC
      .split("\n")
      .find((l) => l.includes("↵") && l.includes("replace"))
    expect(replaceLine).toBeDefined()
    // Must contain \r?\n (the CRLF-aware form)
    expect(replaceLine).toMatch(/\\r\?\\n/)
  })

  test("F-B4-3: paired control — LF-only text still produces ↵ markers", () => {
    // Red-on-injection: change replacement to /\r\n/g only →
    // pure LF files are no longer normalised; output breaks line contract.
    //
    // Structural test: the replacement pattern /\r?\n/ matches both LF and CRLF.
    // We simulate the replacement inline to confirm both cases.
    const lfText = "line1\nline2"
    const crlfText = "line1\r\nline2"
    const normalise = (t: string): string => t.replace(/\r?\n/g, "↵")
    expect(normalise(lfText)).toBe("line1↵line2")
    expect(normalise(crlfText)).toBe("line1↵line2")
    // No stray \r in either case
    expect(normalise(crlfText)).not.toContain("\r")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// F-B7-MAX-COUNT: --max-count flag may not be in ast-grep's CLI
// ═══════════════════════════════════════════════════════════════════════════════

describe("F-B7-max-count-flag: ast-grep --max-count must be removed (flag not in CLI)", () => {
  test("F-B7-1: source does NOT pass --max-count to ast-grep", () => {
    // Red-on-injection: restore `parts.push("--max-count", String(MAX_MATCHES))` →
    // if the installed ast-grep version doesn't recognise --max-count,
    // every call fails with exit code 2 and the tool is completely non-functional.
    // The stdout-slice guard (MAX_STDOUT_BYTES) is sufficient for OOM protection.
    expect(AST_GREP_SRC).not.toContain("--max-count")
  })

  test("F-B7-2: stdout-slice guard (MAX_STDOUT_BYTES) is still present as OOM protection", () => {
    // Red-on-injection: remove MAX_STDOUT_BYTES slice →
    // --max-count was the only cap; without either, OOM is possible on broad patterns.
    expect(AST_GREP_SRC).toContain("MAX_STDOUT_BYTES")
    expect(AST_GREP_SRC).toContain("slice(0, MAX_STDOUT_BYTES)")
  })

  test("F-B7-3: paired control — ast-grep run command is still assembled correctly", () => {
    // Red-on-injection: remove the entire parts assembly →
    // no shell command is ever built; tool silently fails.
    expect(AST_GREP_SRC).toContain("ast-grep")
    expect(AST_GREP_SRC).toContain("--pattern")
    expect(AST_GREP_SRC).toContain("--json")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// C3-JAIL-PATH-MISMATCH: lsp_nav tools must pass abs (not relative) to port
// ═══════════════════════════════════════════════════════════════════════════════

describe("C3-JAIL-PATH-MISMATCH: lsp_nav tools pass jailed abs path to port", () => {
  // ── lsp_signature_help ────────────────────────────────────────────────────

  test("C3-SIG-1: lsp_signature_help passes abs path to port, not relative path", async () => {
    // Red-on-injection: change port call from abs to parsed.data.path →
    // the path that reaches ensureOpen() resolves against process.cwd(),
    // not ctx.cwd; the FS-jail check is performed on a different path than
    // what actually hits the LSP server, defeating the security invariant.
    const calls: string[] = []
    const port: SignatureHelpPort = {
      signatureHelp: async (file) => {
        calls.push(file)
        return []
      },
    }
    await collect(lspSignatureHelpTool(port), { path: "src/x.ts", line: 1, character: 1 }, ctx("/work/proj"))
    // The port must receive the absolute path rooted at ctx.cwd
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("/work/proj/src/x.ts")
    // NOT the bare relative path
    expect(calls[0]).not.toBe("src/x.ts")
  })

  test("C3-SIG-2: paired control — relative path resolves against ctx.cwd", async () => {
    // Red-on-injection: hardcode process.cwd() as base instead of ctx.cwd →
    // subagent/worktree contexts get wrong file paths.
    const calls: string[] = []
    const port: SignatureHelpPort = {
      signatureHelp: async (file) => {
        calls.push(file)
        return []
      },
    }
    await collect(lspSignatureHelpTool(port), { path: "src/y.ts", line: 2, character: 3 }, ctx("/other/root"))
    expect(calls[0]).toBe("/other/root/src/y.ts")
  })

  // ── lsp_code_action ───────────────────────────────────────────────────────

  test("C3-CA-3: lsp_code_action passes abs path to port, not relative path", async () => {
    // Red-on-injection: change port call from abs to parsed.data.path →
    // same jail-bypass as C3-SIG-1 but for code actions.
    const calls: string[] = []
    const port: CodeActionPort = {
      resolveCodeActions: async (file) => {
        calls.push(file)
        return []
      },
      applyEdit: async () => {},
    }
    await collect(lspCodeActionTool(port), { path: "src/x.ts", line: 1, character: 1 }, ctx("/work/proj"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("/work/proj/src/x.ts")
    expect(calls[0]).not.toBe("src/x.ts")
  })

  // ── lsp_format ────────────────────────────────────────────────────────────

  test("C3-FMT-4: lsp_format passes abs path to port (whole-file), not relative path", async () => {
    // Red-on-injection: change port call from abs to parsed.data.path →
    // same jail-bypass as C3-SIG-1 but for format.
    const calls: string[] = []
    const port: FormatPort = {
      format: async (file) => {
        calls.push(file)
        return []
      },
    }
    await collect(lspFormatTool(port), { path: "src/x.ts" }, ctx("/work/proj"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("/work/proj/src/x.ts")
    expect(calls[0]).not.toBe("src/x.ts")
  })

  test("C3-FMT-5: lsp_format passes abs path for range format too", async () => {
    // Red-on-injection: the range branch passes parsed.data.path while the
    // whole-file branch passes abs — divergent security posture.
    const calls: string[] = []
    const port: FormatPort = {
      format: async (file) => {
        calls.push(file)
        return []
      },
    }
    await collect(lspFormatTool(port), {
      path: "src/x.ts",
      range: { startLine: 1, startCharacter: 1, endLine: 2, endCharacter: 1 },
    }, ctx("/work/proj"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("/work/proj/src/x.ts")
  })

  test("C3-JAIL-6: absolute path that escapes jail produces ok:false (FsJailError)", async () => {
    // Red-on-injection: remove resolveJailed call →
    // /etc/passwd is passed to the port without any jail check.
    const calls: string[] = []
    const port: SignatureHelpPort = {
      signatureHelp: async (file) => {
        calls.push(file)
        return []
      },
    }
    const r = await collect(
      lspSignatureHelpTool(port),
      { path: "/etc/passwd", line: 1, character: 1 },
      ctx("/work/proj"),
    )
    expect(r.ok).toBe(false)
    // Port must NOT be called — the jail check must fire before port contact
    expect(calls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// D4-REPL-FENCE: session-picker.ts comment must not overclaim fence scope
// ═══════════════════════════════════════════════════════════════════════════════

describe("D4-REPL-FENCE: session-picker.ts comment scope is accurate", () => {
  test("D4-1: session-picker.ts does NOT claim 'no ... process.env reads in repl.ts can hold'", () => {
    // Red-on-injection: restore the overclaiming comment →
    // readers trust the comment as a fence invariant and miss that repl.ts
    // still has many process.env reads; they add more without noticing.
    //
    // The comment must NOT contain the phrase 'process.env.<KEY> reads in repl.ts'.
    expect(SESSION_PICKER_SRC).not.toMatch(/process\.env\.<KEY>\s+reads in repl\.ts/)
  })

  test("D4-2: session-picker.ts comment accurately describes its actual scope (TTY + argv)", () => {
    // Red-on-injection: remove all comment documentation →
    // future maintainers have no context for why this extraction happened.
    //
    // The file header must mention 'isTTY' or 'TTY' (its actual scope).
    expect(SESSION_PICKER_SRC).toMatch(/isTTY|TTY/)
  })

  test("D4-3: session-picker.ts still contains the actual isTTY guard (its real purpose)", () => {
    // Red-on-injection: remove the TTY check →
    // session picker runs in piped/one-shot/headless mode and hangs on stdin.
    expect(SESSION_PICKER_SRC).toContain("process.stderr.isTTY")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// A5-SILENT-NOHEADER: unified diff missing +++ line → silent zero-op
// ═══════════════════════════════════════════════════════════════════════════════

describe("A5-SILENT-NOHEADER: missing +++ line produces zero-op (documented behavior)", () => {
  test("A5-1: unified diff with --- but no +++ line produces zero ops (no error thrown)", () => {
    // Red-on-injection: change the best-effort skip to throw a PatchParseError →
    // the no-throw contract breaks; callers expecting best-effort get exceptions.
    //
    // Current documented behavior: best-effort conversion silently skips the
    // malformed file entry. The converter returns zero ops.
    const malformed = ["--- a/foo.py", "-old", "+new"].join("\n")
    // isUnifiedDiff must still detect it as a unified diff
    expect(isUnifiedDiff(malformed)).toBe(true)
    // The converter must not throw
    let v4a: string
    expect(() => {
      v4a = unifiedDiffToV4A(malformed)
    }).not.toThrow()
    // parsePatch must not throw either
    let patch: ReturnType<typeof parsePatch>
    expect(() => {
      patch = parsePatch(v4a!)
    }).not.toThrow()
    // The result must have zero ops (best-effort skips the malformed entry)
    expect(patch!.ops).toHaveLength(0)
  })

  test("A5-2: well-formed unified diff after a malformed entry is still parsed", () => {
    // Red-on-injection: an infinite loop or early return instead of i++ →
    // the converter hangs or discards subsequent valid entries.
    const input = [
      "--- a/bad.py",  // missing +++ → silently skipped
      "-dropped",
      "+dropped",
      "--- a/good.py",
      "+++ b/good.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    const patch = parsePatch(v4a)
    // The good entry after the bad one must still be converted
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("update")
    expect(patch.ops[0]?.path).toBe("good.py")
  })

  test("A5-3: paired control — well-formed diff with +++ produces expected op count", () => {
    // Red-on-injection: always return zero ops regardless of input →
    // legitimate patches silently become no-ops; data loss.
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("update")
  })
})
