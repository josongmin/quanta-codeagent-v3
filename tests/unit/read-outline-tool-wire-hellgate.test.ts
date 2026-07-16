/**
 * HELLGATE — `read outline:true` TOOL WIRING (RFC jun-6 §4.4 / §6.2).
 *
 * Proves the end-to-end branch through the real `read` tool with an injected
 * `fakeParser` (NO real WASM):
 *   - knob ON + parser wired + canned parse ⇒ collapsed outline output;
 *   - knob OFF ⇒ `outline:true` degrades to a normal line-range read + the
 *     explicit `(no outline: …)` note (NO-THROW);
 *   - `outline:true` with an `{ok:false}` parse ⇒ same graceful degrade;
 *   - `read` WITHOUT `outline` ⇒ BYTE-IDENTICAL to today regardless of knob,
 *     and the parser is NEVER consulted (default-OFF byte-identity).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeParser, type ParsedFile, type ParseOutcome } from "@/retrieval"
import { __resetRuntimeConfig } from "@/shared"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { ToolContext, ToolResult } from "@/tool"
import { makeReadTool, type ReadOutlineParserPort } from "@/tool/read"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const dirs: string[] = []
const mkFile = (name: string, body: string): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "read-outline-wire-"))
  dirs.push(dir)
  writeFileSync(join(dir, name), body)
  return { dir, path: name }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.QUANTA_READ_OUTLINE
  __resetKnobOverrides()
  __resetRuntimeConfig()
})

const FILE_BODY = ["function add(a, b) {", "  return a + b", "}"].join("\n")

const CANNED: ParsedFile = {
  lang: "typescript",
  decls: [
    { kind: "function", name: "add", startLine: 1, endLine: 3, signatureEndLine: 1, children: [] },
  ],
}

const run = async (
  tool: ReturnType<typeof makeReadTool>,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("read outline tool wire hellgate", () => {
  test("knob ON + parser wired ⇒ collapsed outline (bodies elided)", async () => {
    process.env.QUANTA_READ_OUTLINE = "1"
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.ts", FILE_BODY)
    const fp = fakeParser(
      new Map<string, ParseOutcome>([[FILE_BODY, { ok: true, parsed: CANNED }]]),
    )
    const tool = makeReadTool(undefined, fp)
    const res = await run(tool, { path, outline: true }, dir)
    expect(res.ok).toBe(true)
    expect(res.output).toContain("function add(a, b) {")
    expect(res.output).not.toContain("return a + b")
    expect(res.output).toContain("// …")
    expect(fp.calls()).toBe(1)
  })

  test("knob OFF ⇒ outline:true degrades to line-range read + note, NO-THROW", async () => {
    // knob unset — also clear the live-override store so a prior buildConfig call
    // that set QUANTA_READ_OUTLINE=1 via setKnobOverride doesn't leak through.
    __resetKnobOverrides()
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.ts", FILE_BODY)
    const fp = fakeParser(
      new Map<string, ParseOutcome>([[FILE_BODY, { ok: true, parsed: CANNED }]]),
    )
    const tool = makeReadTool(undefined, fp)
    const res = await run(tool, { path, outline: true }, dir)
    expect(res.ok).toBe(true)
    expect(res.output).toContain("no outline: outline disabled")
    // The actual content is line-numbered (the normal read).
    expect(res.output).toContain("1\tfunction add(a, b) {")
    // Parser never consulted when the knob is off.
    expect(fp.calls()).toBe(0)
  })

  test("knob ON but parse {ok:false} ⇒ graceful line-range degrade + note", async () => {
    process.env.QUANTA_READ_OUTLINE = "1"
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.unknown", FILE_BODY)
    const fp = fakeParser(new Map()) // every text ⇒ { ok:false, no-grammar }
    const tool = makeReadTool(undefined, fp)
    const res = await run(tool, { path, outline: true }, dir)
    expect(res.ok).toBe(true)
    expect(res.output).toContain("unsupported language or missing parser grammar")
    expect(res.output).toContain("1\tfunction add(a, b) {")
  })

  test.each([
    ["unsupported-language", "unsupported language"],
    ["missing-grammar", "missing parser grammar"],
    ["parse-error", "source parse failed"],
  ] as const)("typed %s fallback is visible", async (reason, message) => {
    process.env.QUANTA_READ_OUTLINE = "1"
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.ts", FILE_BODY)
    const parser: ReadOutlineParserPort = {
      parse: async () => ({ ok: false, reason }),
    }

    const res = await run(makeReadTool(undefined, parser), { path, outline: true }, dir)

    expect(res.ok).toBe(true)
    expect(res.output).toContain(`no outline: ${message}`)
    expect(res.output).toContain("1\tfunction add(a, b) {")
  })

  test("throwing parser degrades visibly instead of escaping", async () => {
    process.env.QUANTA_READ_OUTLINE = "1"
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.ts", FILE_BODY)
    const parser: ReadOutlineParserPort = {
      parse: () => Promise.reject(new Error("broken adapter")),
    }

    const res = await run(makeReadTool(undefined, parser), { path, outline: true }, dir)

    expect(res.ok).toBe(true)
    expect(res.output).toContain("no outline: source parse failed")
    expect(res.output).toContain("1\tfunction add(a, b) {")
  })

  test("read WITHOUT outline ⇒ byte-identical regardless of knob, parser unused", async () => {
    process.env.QUANTA_READ_OUTLINE = "1"
    __resetRuntimeConfig()
    const { dir, path } = mkFile("foo.ts", FILE_BODY)
    const fp = fakeParser(
      new Map<string, ParseOutcome>([[FILE_BODY, { ok: true, parsed: CANNED }]]),
    )
    const withParser = makeReadTool(undefined, fp)
    const a = await run(withParser, { path }, dir)
    // Same as the default tool (no parser).
    const plain = makeReadTool()
    const { dir: dir2, path: path2 } = mkFile("foo.ts", FILE_BODY)
    const b = await run(plain, { path: path2 }, dir2)
    expect(a.output).toBe(b.output)
    expect(fp.calls()).toBe(0)
  })
})
