import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext, TrajectoryKind } from "@/shared"
import { makeEvent } from "@/shared"
import { main } from "../../src/apps/probe/index"

let dir: string
let out: string[]
let restore: () => void

const capture = (): (() => string) => {
  out = []
  const orig = process.stdout.write.bind(process.stdout)
  // biome-ignore lint/suspicious/noExplicitAny: test-only stdout shim
  process.stdout.write = ((c: any): boolean => {
    out.push(String(c))
    return true
  }) as typeof process.stdout.write
  restore = () => {
    process.stdout.write = orig
  }
  return () => out.join("")
}

const ctxFor = (instanceId: string): RunContext => ({ runId: "r1", instanceId, attempt: 0 })

const writeTraj = (
  file: string,
  ctx: RunContext,
  rows: Array<[TrajectoryKind, Record<string, unknown>]>,
): void => {
  const body = rows
    .map(([k, d], i) => JSON.stringify(makeEvent(i, k, ctx, d, { ts: 1_700_000_000_000 + i })))
    .join("\n")
  writeFileSync(file, `${body}\n`)
}

const snapshot = (d: string): string =>
  readdirSync(d)
    .sort()
    .map((f) => `${f}:${statSync(join(d, f)).mtimeMs}:${statSync(join(d, f)).size}`)
    .join("|")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-int-"))
  // Instance pass: patch + verify passed.
  writeTraj(join(dir, "pass1.0.jsonl"), ctxFor("pass1"), [
    ["session_start", {}],
    ["turn_start", { turn: 1 }],
    ["assistant_text", { delta: "I will fix the bug by editing foo.py" }],
    ["tool_call", { id: "tu1", name: "bash", input: { cmd: "pytest" } }],
    ["tool_progress", { id: "tu1", name: "bash", message: "running" }],
    ["tool_result", { name: "bash", ok: true, durationMs: 1200, stdoutTail: "1 passed" }],
    ["llm_usage", { model: "gpt-4o", inputTokens: 1000, outputTokens: 200, costUsd: null }],
    ["patch_generated", { diffPath: "/p", filesChanged: 1, hunks: 2, applyStatus: "ok" }],
    [
      "verify",
      {
        command: "pytest",
        exitCode: 0,
        passed: true,
        failedTests: [],
        logTail: "ok",
        reportPath: "/r1.json",
      },
    ],
    ["session_end", { reason: "stop", turns: 1 }],
  ])
  // Instance fail: verify failed.
  writeTraj(join(dir, "fail1.0.jsonl"), ctxFor("fail1"), [
    ["session_start", {}],
    ["turn_start", { turn: 1 }],
    ["assistant_text", { delta: "Attempting a fix" }],
    ["tool_result", { name: "bash", ok: false, durationMs: 9000, stdoutTail: "boom" }],
    ["llm_usage", { model: "gpt-4o", inputTokens: 5000, outputTokens: 800, costUsd: null }],
    ["patch_generated", { diffPath: "/p2", filesChanged: 1, hunks: 1, applyStatus: "ok" }],
    [
      "verify",
      {
        command: "pytest",
        exitCode: 1,
        passed: false,
        failedTests: ["test_broken"],
        logTail: "AssertionError: nope",
        reportPath: "/r2.json",
      },
    ],
    ["session_end", { reason: "stop", turns: 1 }],
  ])
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      runId: "r1",
      resolved: 1,
      total: 2,
      degraded: 0,
      instances: [
        { id: "pass1", passed: true, verdict: "ok", turns: 1 },
        { id: "fail1", passed: false, verdict: "ok", turns: 1 },
      ],
    }),
  )
  writeFileSync(
    join(dir, "metrics.json"),
    JSON.stringify({ runId: "r1", pricingVersion: "pricing.v1", snapshot: {} }),
  )
})

afterEach(() => {
  restore?.()
  rmSync(dir, { recursive: true, force: true })
})

describe("probe main — integration", () => {
  test("default → run overview (counts) + does not crash", async () => {
    const read = capture()
    const code = await main([dir])
    restore()
    expect(code).toBe(0)
    const text = read()
    expect(text).toMatch(/pass1/)
    expect(text).toMatch(/fail1/)
    expect(text).toMatch(/1\s*\/\s*2|resolved 1/)
  })

  test("default single trajectory → timeline with tool span + usage line", async () => {
    const read = capture()
    const code = await main([join(dir, "pass1.0.jsonl")])
    restore()
    expect(code).toBe(0)
    const text = read()
    expect(text).toMatch(/bash/)
    expect(text).toMatch(/1200ms|1200/)
    expect(text).toMatch(/1000.*200|tokens/i)
  })

  test("--failed yields a hedged hypothesis + evidence (non-authoritative)", async () => {
    const read = capture()
    const code = await main([dir, "--failed"])
    restore()
    expect(code).toBe(0)
    const text = read()
    expect(text).toMatch(/fail1/)
    expect(text).toMatch(/likely|suggest|appears|may|hypothes/i)
    expect(text).not.toMatch(/\bverdict\b|definitive|certain/i)
    expect(text).toMatch(/test_broken|AssertionError|verify/i)
  })

  test("--cost shows pricingVersion and a USD or n/a", async () => {
    const read = capture()
    const code = await main([dir, "--cost"])
    restore()
    expect(code).toBe(0)
    const text = read()
    expect(text).toMatch(/pricing\.v1/)
    expect(text).toMatch(/\$|n\/a/)
  })

  test("--json parses and carries NO certainty field", async () => {
    const read = capture()
    const code = await main([dir, "--json"])
    restore()
    expect(code).toBe(0)
    const parsed = JSON.parse(read())
    expect(parsed).toBeTypeOf("object")
    expect(JSON.stringify(parsed).toLowerCase()).not.toMatch(
      /"verdict"|definitive|"certain"|proven/,
    )
  })

  test("--slow renders hotspots by durationMs", async () => {
    const read = capture()
    const code = await main([join(dir, "fail1.0.jsonl"), "--slow"])
    restore()
    expect(code).toBe(0)
    expect(read()).toMatch(/9000|bash/)
  })

  test("read-only: fixture dir unchanged before/after", async () => {
    const before = snapshot(dir)
    const read = capture()
    await main([dir, "--failed"])
    await main([dir, "--cost"])
    await main([dir, "--json"])
    restore()
    read()
    expect(snapshot(dir)).toBe(before)
  })

  test("bad path → usage error exit 1, no crash", async () => {
    const read = capture()
    const code = await main([join(dir, "does-not-exist")])
    restore()
    read()
    expect(code).toBe(1)
  })

  test("no args → usage error exit 1", async () => {
    const read = capture()
    const code = await main([])
    restore()
    read()
    expect(code).toBe(1)
  })

  test("--instance filters to a single instance", async () => {
    const read = capture()
    const code = await main([dir, "--instance", "fail1"])
    restore()
    expect(code).toBe(0)
    const text = read()
    expect(text).toMatch(/fail1/)
  })
})
