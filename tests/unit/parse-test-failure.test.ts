import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolResult } from "@/tool"
import { classifyFrame, parseTestFailure, parseTestFailureTool } from "@/tool"

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

describe("parseTestFailure — tier classification + ranking (R-Phase8 #1)", () => {
  test("user-code frame ranks ABOVE vendored node_modules frame", () => {
    const out = [
      "  at run (/repo/node_modules/jest-runner/build/x.js:120:10)",
      "  at testFn (/repo/src/auth.ts:42:5)",
    ].join("\n")
    const frames = parseTestFailure(out, 30)
    // user-code src/auth.ts must come first despite appearing later in the log.
    expect(frames[0]?.file).toBe("/repo/src/auth.ts")
    expect(frames[0]?.tier).toBe("user")
    expect(frames.find((f) => f.file.includes("node_modules"))?.tier).toBe("vendored")
  })

  test("ordering: user > test > vendored", () => {
    const out = [
      "/repo/node_modules/lib/v.js:1:1",
      "/repo/tests/auth.test.ts:9:2",
      "/repo/src/handler.ts:55:3",
    ].join("\n")
    const tiers = parseTestFailure(out, 30).map((f) => f.tier)
    expect(tiers).toEqual(["user", "test", "vendored"])
  })

  test("python site-packages / .venv classified vendored", () => {
    const out = [
      'File "/proj/.venv/lib/python3.11/site-packages/requests/api.py", line 59, in get',
      'File "/proj/app/service.py", line 12, in handle',
    ].join("\n")
    const frames = parseTestFailure(out, 30)
    expect(frames[0]?.file).toBe("/proj/app/service.py")
    expect(frames.find((f) => f.file.includes("site-packages"))?.tier).toBe("vendored")
  })

  test("vendored flood cannot push user frame past max_results cap", () => {
    // 20 node_modules frames + 1 user frame; cap 5. The user frame MUST survive
    // because ranking happens BEFORE the cap.
    const noise = Array.from(
      { length: 20 },
      (_, i) => `/repo/node_modules/p/f${i}.js:${i + 1}:1`,
    ).join("\n")
    const out = `${noise}\n/repo/src/real.ts:7:1`
    const frames = parseTestFailure(out, 5)
    expect(frames).toHaveLength(5)
    expect(frames[0]?.file).toBe("/repo/src/real.ts")
    expect(frames[0]?.tier).toBe("user")
  })

  test("classifyFrame: user / test / vendored buckets", () => {
    expect(classifyFrame("src/x.ts")).toBe("user")
    expect(classifyFrame("tests/x.test.ts")).toBe("test")
    expect(classifyFrame("pkg/foo_test.go")).toBe("test")
    expect(classifyFrame("node_modules/lib/x.js")).toBe("vendored")
    expect(classifyFrame("target/release/build.rs")).toBe("vendored")
    expect(classifyFrame("dist/bundle.js")).toBe("vendored")
  })

  // R-Phase10: generator/eval/coverage/log noise dirs are vendored. These
  // consistently outranked source files in localize per-query data; treating
  // them as vendored closes that gap and reuses one regex in both consumers.
  test("R-Phase10: runs/ generator output classified vendored", () => {
    expect(classifyFrame("runs/snapshot/x.js")).toBe("vendored")
  })

  test("R-Phase10: outputs/ eval dir classified vendored", () => {
    expect(classifyFrame("outputs/eval/foo.json")).toBe("vendored")
  })

  test("R-Phase10: coverage/ classified vendored", () => {
    expect(classifyFrame("coverage/lcov.info")).toBe("vendored")
  })

  test("R-Phase10: .nyc_output/ classified vendored", () => {
    expect(classifyFrame(".nyc_output/x.json")).toBe("vendored")
  })

  test("R-Phase10: logs/ classified vendored", () => {
    expect(classifyFrame("logs/build.log")).toBe("vendored")
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
