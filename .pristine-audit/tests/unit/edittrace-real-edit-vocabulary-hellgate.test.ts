/**
 * jul-13 editTrace HONESTY hellgate (D2) — couple the `editTrace` debug parser
 * to the REAL `edit`-tool output vocabulary.
 *
 * `contributeEditTraceDebug` (src/apps/bench/eval/driver.ts) derives a slice's
 * `mode` / `outcome` / `occurrences` by pattern-matching the edit tool's OWN
 * output message (which the tap forwards verbatim as `preview`). Those patterns
 * are only honest if they track the strings `src/tool/edit/**` actually emits.
 * This suite drives the ACTUAL edit tool over an in-memory FS through each
 * strategy — exact, replace_all, fuzzy (whitespace-flex), stale-precondition,
 * not-found — feeds the tool's real result string through the shaper exactly as
 * the tap does, and asserts the produced editTrace slice. So a future reword of
 * the edit tool's output messages BREAKS this test instead of silently
 * mis-tagging every edit slice `mode:"exact"` with the count dropped.
 *
 * It also pins fix (a): a NON-edit write tool (`write`), whose output vocabulary
 * differs, is NOT captured as an edit-moded slice — it is dropped by the shaper's
 * `name` scope guard, never silently tagged `mode:"exact"`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { contributeEditTraceDebug } from "@/apps/bench/eval/driver"
import { debugSink } from "@/apps/bench/trajectory-debug-sink"
import type { FileInfo, FileSystemPort } from "@/storage"
import { sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeWriteTool } from "@/tool/write"

const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
const DEBUG_KEY = "QUANTA_BENCH_TRAJECTORY_DEBUG"

let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = { [RECORD_KEY]: process.env[RECORD_KEY], [DEBUG_KEY]: process.env[DEBUG_KEY] }
  // Turn the debug tier ON so `append` accrues (the shaper is only reached on the
  // wired path in production; here we call it directly with the tier enabled).
  process.env[RECORD_KEY] = "debug"
  delete process.env[DEBUG_KEY]
  debugSink.reset()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  debugSink.reset()
})
afterAll(() => debugSink.reset())

/** Minimal in-memory FileSystemPort seeded with one file. */
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

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

/** Drive a tool.execute to its terminal `result` event. */
const run = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  cwd: string,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result" && ev.result !== undefined) result = ev.result
  }
  if (result === undefined) throw new Error("tool produced no result event")
  return result
}

/** Reproduce EXACTLY what BenchStreamTap.onEditResult forwards to the shaper: the
 *  tool NAME, the target file, the applied bit, and the tool's own output string
 *  as `preview`. This is the load-bearing coupling — `preview` is the REAL tool
 *  message, not a hand-written literal. */
const shapeFromResult = (name: string, file: string, r: ToolResult, replaceAll = false): void => {
  contributeEditTraceDebug({ name, file, ok: r.ok, preview: r.output, replaceAll })
}

const onlyEditTrace = (): unknown => {
  const drained = debugSink.drain() as { editTrace?: unknown } | undefined
  return drained?.editTrace
}

describe("D2 — editTrace parser is coupled to the REAL edit-tool output vocabulary", () => {
  test("EXACT single-occurrence success ⇒ mode:exact outcome:matched occurrences:1", async () => {
    const { port } = makePort({ "a.py": "before\nx = 1\nafter\n" })
    const edit = makeEditTool(port)
    const r = await run(edit, { path: "a.py", old_string: "x = 1", new_string: "x = 2" }, "/")
    expect(r.ok).toBe(true)
    // Sanity: the tool spoke the EXACT vocabulary the parser keys on.
    expect(r.output).toContain("Replaced 1 occurrence(s)")

    shapeFromResult("edit", "a.py", r)
    expect(onlyEditTrace()).toEqual([
      { tool: "edit", file: "a.py", mode: "exact", outcome: "matched", occurrences: 1 },
    ])
  })

  test("replace_all bulk exact ⇒ occurrences parsed as N, replaceAll:true", async () => {
    const { port } = makePort({ "b.py": "k=0\nk=0\nk=0\n" })
    const edit = makeEditTool(port)
    const r = await run(
      edit,
      { path: "b.py", old_string: "k=0", new_string: "k=1", replace_all: true },
      "/",
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Replaced 3 occurrence(s)")

    shapeFromResult("edit", "b.py", r, /* replaceAll */ true)
    expect(onlyEditTrace()).toEqual([
      {
        tool: "edit",
        file: "b.py",
        mode: "exact",
        outcome: "matched",
        occurrences: 3,
        replaceAll: true,
      },
    ])
  })

  test("FUZZY whitespace-flex recovery ⇒ mode:fuzzy fuzzyEscalated:true", async () => {
    // Exact miss (irregular whitespace); fuzzy=true escalates and matches.
    const { port } = makePort({ "c.py": "def f():\n      return   a +  b\n" })
    const edit = makeEditTool(port)
    const r = await run(
      edit,
      { path: "c.py", old_string: "return a + b", new_string: "return a - b", fuzzy: true },
      "/",
    )
    expect(r.ok).toBe(true)
    // The tool announces the fuzzy strategy in its own message.
    expect(r.output).toMatch(/whitespace-flexible|anchored-trim/)

    shapeFromResult("edit", "c.py", r)
    expect(onlyEditTrace()).toEqual([
      {
        tool: "edit",
        file: "c.py",
        mode: "fuzzy",
        outcome: "matched",
        occurrences: 1,
        fuzzyEscalated: true,
      },
    ])
  })

  test("STALE precondition (expected_hash mismatch) ⇒ outcome:stale, file untouched", async () => {
    const { port, files } = makePort({ "d.py": "x = 1\n" })
    const edit = makeEditTool(port)
    const wrongHash = sha256Hex("something else entirely")
    const r = await run(
      edit,
      { path: "d.py", old_string: "x = 1", new_string: "x = 2", expected_hash: wrongHash },
      "/",
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("stale_precondition")
    // The edit did NOT land (precondition gate refused before commit).
    expect(files.get("d.py")).toBe("x = 1\n")

    shapeFromResult("edit", "d.py", r)
    expect(onlyEditTrace()).toEqual([
      { tool: "edit", file: "d.py", mode: "exact", outcome: "stale" },
    ])
  })

  test("NOT-FOUND miss ⇒ outcome:failed (no stale marker), no occurrences", async () => {
    const { port } = makePort({ "e.py": "alpha\nbeta\n" })
    const edit = makeEditTool(port)
    const r = await run(
      edit,
      { path: "e.py", old_string: "this text is absent", new_string: "z" },
      "/",
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("old_string not found in file")

    shapeFromResult("edit", "e.py", r)
    expect(onlyEditTrace()).toEqual([
      { tool: "edit", file: "e.py", mode: "exact", outcome: "failed" },
    ])
  })

  test("FIX (a) — the `write` tool's REAL output is NOT captured as an edit slice", async () => {
    const { port } = makePort({})
    const write = makeWriteTool(port)
    const r = await run(write as never, { path: "new.py", content: "print('hi')\n" }, "/")
    expect(r.ok).toBe(true)
    // The write tool speaks a DIFFERENT vocabulary — "Created … (N bytes)".
    expect(r.output).toMatch(/Created .* \(\d+ bytes\)/)

    // Forward it through the shaper exactly as the tap does (name="write").
    shapeFromResult("write", "new.py", r)
    // It is DROPPED — not mislabeled mode:"exact" with the byte count lost.
    expect(debugSink.drain()).toBeUndefined()
  })
})
