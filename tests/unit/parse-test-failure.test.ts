import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolResult } from "@/tool"
import { parseTestFailure, parseTestFailureTool } from "@/tool"

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

const run = async (output: string, max_results?: number): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of parseTestFailureTool.execute(
    max_results === undefined ? { output } : { output, max_results },
    ctx(),
  )) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("parseTestFailure (pure) — framework patterns", () => {
  test("pytest short form: path.py:line: AssertionError", () => {
    const out = "tests/test_auth.py:42: AssertionError: token expired\nmore noise"
    const frames = parseTestFailure(out, 30)
    expect(frames).toContainEqual(expect.objectContaining({ file: "tests/test_auth.py", line: 42 }))
  })

  test('python traceback frame: File "x.py", line N, in fn', () => {
    const out = `Traceback (most recent call last):
  File "src/app/handler.py", line 88, in handle_request
    raise ValueError("boom")`
    const frames = parseTestFailure(out, 30)
    const hit = frames.find((f) => f.file === "src/app/handler.py" && f.line === 88)
    expect(hit).toBeDefined()
    expect(hit?.framework).toBe("python-traceback")
    expect(hit?.message).toContain("handle_request")
  })

  test("jest/vitest stack frame: at fn (/path/x.test.ts:12:34)", () => {
    const out = "  at Object.<anonymous> (/repo/src/util.test.ts:12:34)"
    const frames = parseTestFailure(out, 30)
    expect(frames).toContainEqual(
      expect.objectContaining({ file: "/repo/src/util.test.ts", line: 12, framework: "js-stack" }),
    )
  })

  test("bun test stack frame (same js-stack shape)", () => {
    const out = "(fail) my test\n at <anonymous> (/repo/x.ts:5:9)"
    const frames = parseTestFailure(out, 30)
    expect(frames.some((f) => f.file === "/repo/x.ts" && f.line === 5)).toBe(true)
  })

  test("go test: file_test.go:NN: message", () => {
    const out = "--- FAIL: TestThing (0.00s)\n    thing_test.go:31: expected 3 got 4"
    const frames = parseTestFailure(out, 30)
    const hit = frames.find((f) => f.file === "thing_test.go" && f.line === 31)
    expect(hit).toBeDefined()
    expect(hit?.message).toContain("expected 3 got 4")
  })

  test("cargo/rust panic (new form): panicked at src/lib.rs:42:9:", () => {
    const out = "thread 'tests::it_works' panicked at src/lib.rs:42:9:\nassertion failed"
    const frames = parseTestFailure(out, 30)
    const hit = frames.find((f) => f.file === "src/lib.rs" && f.line === 42)
    expect(hit).toBeDefined()
    expect(hit?.framework).toBe("cargo-test")
  })

  test("cargo/rust panic (old form): panicked at 'msg', src/lib.rs:42:9", () => {
    const out = "thread 'main' panicked at 'index out of bounds', src/lib.rs:7:13"
    const frames = parseTestFailure(out, 30)
    const hit = frames.find((f) => f.file === "src/lib.rs" && f.line === 7)
    expect(hit).toBeDefined()
    expect(hit?.message).toContain("index out of bounds")
  })

  test("dedup: same file:line from two patterns → one frame", () => {
    const out = `tests/x.py:10: AssertionError
  File "tests/x.py", line 10, in test_x`
    const frames = parseTestFailure(out, 30)
    const matches = frames.filter((f) => f.file === "tests/x.py" && f.line === 10)
    expect(matches).toHaveLength(1)
  })

  test("non-file tokens rejected (no extension / has spaces)", () => {
    const out = "ERROR: 5: something went wrong at module: 7"
    const frames = parseTestFailure(out, 30)
    // "module" has no extension; "5"/"7" are not files.
    expect(frames).toHaveLength(0)
  })

  test("max_results cap respected", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `f${i}.py:${i + 1}: err`).join("\n")
    expect(parseTestFailure(lines, 3)).toHaveLength(3)
  })

  test("empty output → []", () => {
    expect(parseTestFailure("", 30)).toEqual([])
  })
})

describe("parseTestFailureTool — tool surface", () => {
  test("renders file:line [framework] rows", async () => {
    const r = await run("tests/test_x.py:42: boom")
    expect(r.ok).toBe(true)
    expect(r.output).toContain("tests/test_x.py:42")
    expect(r.output).toContain("[pytest]")
  })

  test("no locations → sentinel, still ok:true", async () => {
    const r = await run("all green, nothing failed")
    expect(r.ok).toBe(true)
    expect(r.output).toContain("no file:line locations")
  })

  test("read-only + concurrency-safe (pure parser)", () => {
    expect(parseTestFailureTool.isReadOnly?.()).toBe(true)
    expect(parseTestFailureTool.isConcurrencySafe?.({ output: "" })).toBe(true)
  })
})
