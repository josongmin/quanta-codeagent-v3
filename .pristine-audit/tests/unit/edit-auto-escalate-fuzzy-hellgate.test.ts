/**
 * jun-26 edit-escalate HELLGATE — auto-escalate the whitespace-tolerant fuzzy
 * ladder on an exact MISS (frontier parity: Claude Code / Codex both auto-retry
 * whitespace-tolerant). The behavior is GATED on `ctx.autoEscalateFuzzy`
 * (wired from `QUANTA_EDIT_AUTO_FUZZY`), so this proves BOTH:
 *
 *  (1) RED-ON-INJECTION — with the flag ON, an edit whose `old_string` differs
 *      from the file by WHITESPACE ONLY (so exact misses) is RECOVERED via the
 *      fuzzy ladder and lands on disk. Flip the flag OFF (the default) and the
 *      SAME edit fails `not_found` and the file is untouched. The recovery is
 *      what the auto-escalate code adds; removing it (or the gate) ⇒ RED.
 *
 *  (2) BYTE-IDENTITY (default-OFF safety) — with the flag OFF and `input.fuzzy`
 *      unset, the edit tool's failure output + the on-disk bytes are IDENTICAL
 *      to the legacy path. A genuine exact match still succeeds unchanged on
 *      both paths (the flag only ever ADDS a recovery rung; it never alters a
 *      hit). The fail-closed bias is preserved: an AMBIGUOUS whitespace match is
 *      still rejected (never a wrong write) even with the flag ON.
 *
 *  (3) NEAREST-CANDIDATE — the ON path appends a Claude-style "Nearest match:
 *      line N differs only in whitespace" note on a not-found miss when a
 *      whitespace-equal file line exists; the OFF path NEVER appends it
 *      (byte-identical not-found output).
 */
import { describe, expect, test } from "bun:test"
import type { FileInfo, FileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

/** In-memory FS fake (no writeFileAtomic ⇒ commits via writeFile). */
const makePort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }
  return { port, files }
}

const ctx = (cwd: string, autoEscalateFuzzy?: boolean): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(autoEscalateFuzzy ? { autoEscalateFuzzy: true } : {}),
})

const run = async (
  port: FileSystemPort,
  input: Record<string, unknown>,
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeEditTool(port).execute(input as never, c)) {
    if (ev.type === "result" && ev.result) result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const CWD = "/mem"
const FILE = "/mem/f.py"
// A line that differs from the model's old_string by WHITESPACE ONLY (the file
// uses irregular internal spacing): exact match misses, fuzzy whitespace-flex hits.
const SRC = "def f():\n    return    a +  b\n"
const OLD = "    return a + b" // single-spaced — exact never matches
const NEW = "    return a - b"

describe("jun-26 edit-escalate — auto-escalate ON recovers a whitespace-only miss", () => {
  test("flag ON: exact miss is RECOVERED via fuzzy and lands on disk", async () => {
    const { port, files } = makePort({ [FILE]: SRC })
    // No input.fuzzy — the recovery is driven SOLELY by ctx.autoEscalateFuzzy.
    const r = await run(port, { path: FILE, old_string: OLD, new_string: NEW }, ctx(CWD, true))
    expect(r.ok).toBe(true)
    // The byte-faithful fuzzy splice replaced the matched window verbatim.
    expect(files.get(FILE)).toBe("def f():\n    return a - b\n")
  })

  test("RED-ON-INJECTION — flag OFF: the SAME edit fails not_found, file UNTOUCHED", async () => {
    const { port, files } = makePort({ [FILE]: SRC })
    // Default ctx (no autoEscalateFuzzy, no input.fuzzy) — the legacy path.
    const r = await run(port, { path: FILE, old_string: OLD, new_string: NEW }, ctx(CWD))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("not_found")
    // The file is byte-identical to its seed: a wrong/no edit, never a silent hit.
    expect(files.get(FILE)).toBe(SRC)
  })
})

describe("jun-26 edit-escalate — byte-identity & fail-closed safety", () => {
  test("flag OFF vs legacy: a genuine EXACT match succeeds identically (flag never alters a hit)", async () => {
    const exactSrc = "x = 1\n"
    const a = makePort({ [FILE]: exactSrc })
    const b = makePort({ [FILE]: exactSrc })
    const off = await run(
      a.port,
      { path: FILE, old_string: "x = 1", new_string: "x = 2" },
      ctx(CWD),
    )
    const on = await run(
      b.port,
      { path: FILE, old_string: "x = 1", new_string: "x = 2" },
      ctx(CWD, true),
    )
    expect(off.ok).toBe(true)
    expect(on.ok).toBe(true)
    expect(off.output).toBe(on.output) // identical success bytes
    expect(a.files.get(FILE)).toBe("x = 2\n")
    expect(b.files.get(FILE)).toBe(a.files.get(FILE)) // identical on-disk result
  })

  test("fail-closed: an AMBIGUOUS whitespace match is REJECTED even with the flag ON", async () => {
    // Every line is a whitespace variant of "x = 1" ⇒ whitespace-flex finds 3
    // candidate windows ⇒ ambiguous ⇒ MUST reject (wrong-edit > no-edit).
    const ambSrc = "x  =  1\n  x  =  1\n    x  =  1\n"
    const { port, files } = makePort({ [FILE]: ambSrc })
    const r = await run(
      port,
      { path: FILE, old_string: "x = 1", new_string: "x = 2" },
      ctx(CWD, true),
    )
    expect(r.ok).toBe(false)
    expect(files.get(FILE)).toBe(ambSrc) // NOT mutated
  })
})

describe("jun-26 edit-escalate — nearest-candidate note (Claude-style)", () => {
  test("flag ON: not-found with a whitespace-equal line surfaces the nearest line", async () => {
    // `old_string` whose FIRST line trims to a real file line but mismatches by
    // whitespace, AND a later line breaks the multi-line anchor so fuzzy still
    // misses ⇒ not-found, but the nearest-candidate hint fires.
    const src = "def f():\n        value = compute()\n    return value\n"
    const { port } = makePort({ [FILE]: src })
    const r = await run(
      port,
      {
        path: FILE,
        old_string: "    value = compute()\nTHIS_LINE_IS_NOT_PRESENT",
        new_string: "x",
      },
      ctx(CWD, true),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("Nearest match: line 2 differs only in whitespace")
    expect(r.output).toContain("        value = compute()")
  })

  test("byte-identity — flag OFF NEVER appends the nearest-candidate note", async () => {
    const src = "def f():\n        value = compute()\n    return value\n"
    const a = makePort({ [FILE]: src })
    const r = await run(
      a.port,
      {
        path: FILE,
        old_string: "    value = compute()\nTHIS_LINE_IS_NOT_PRESENT",
        new_string: "x",
      },
      ctx(CWD), // flag OFF
    )
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("Nearest match")
  })
})
