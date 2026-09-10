import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoundedTestExecutor } from "../_support/bounded-test-concurrency"

const ENTRY = "src/apps/bench/index.ts"
// Repo root anchored on this file, not on the ambient cwd: ENTRY below is a
// repo-RELATIVE path, so the spawn only works when `cwd` is the real repo root.
const REPO = join(import.meta.dir, "..", "..")
const runBounded = createBoundedTestExecutor(2)
setDefaultTimeout(30_000)

let dir: string
let datasetFile = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-dataset-dry-run-"))
  datasetFile = join(dir, "instances.jsonl")
  writeFileSync(
    datasetFile,
    `${[
      JSON.stringify({
        instance_id: "demo__inst-1",
        repo: "demo/repo",
        base_commit: "0".repeat(40),
        problem_statement: "fix one",
      }),
      JSON.stringify({
        instance_id: "demo__inst-2",
        repo: "demo/repo",
        base_commit: "1".repeat(40),
        problem_statement: "fix two",
      }),
    ].join("\n")}\n`,
  )
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runBench = async (...args: string[]): Promise<{ code: number; out: string }> => {
  return runBounded(async () => {
    const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        QUANTA_PROVIDER: "openai",
        QUANTA_BENCH_PRESET: "",
        QUANTA_BENCH_SOTA: "",
        QUANTA_KNOBS_PRESET: "",
      },
    })
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
    const code = await proc.exited
    return { code, out }
  })
}

describe("bench index dataset dry-run", () => {
  test.concurrent("--list-presets uses the shared preset renderer and exits", async () => {
    const { code, out } = await runBench("--list-presets")
    expect(code).toBe(0)
    expect(out).toContain("agentless-v1")
    expect(out).toContain("Default live execution preset: agentless-v3-thin-strict.")
    expect(out).toContain("Individual QUANTA_BENCH_* env vars override a preset's values.")
    expect(out).toContain("QUANTA_BENCH_SOTA=1")
  })

  test.concurrent("--help exits with usage instead of starting a run", async () => {
    const { code, out } = await runBench("--help")
    expect(code).toBe(0)
    expect(out).toContain("quanta bench")
    expect(out).toContain("--swebench <dataset.jsonl>")
    expect(out).toContain("--repair-rounds <N>")
    expect(out).not.toContain("instance(s), provider=")
  })

  test.concurrent("--swebench --dry-run prints the plan and never asks for API keys", async () => {
    const { code, out } = await runBench("--swebench", datasetFile, "--dry-run", "--limit", "1")
    expect(code).toBe(0)
    expect(out).toContain("dry-run plan")
    expect(out).toContain(`dataset: ${datasetFile}`)
    expect(out).toContain("2 loaded, 1 selected (--limit 1)")
    expect(out).toContain("preset: agentless-v3-thin-strict")
    expect(out).toContain("sample ids: demo__inst-1")
    expect(out.toLowerCase()).not.toContain("no api key")
  })

  test.concurrent("--flag=value forms route to dataset dry-run instead of silently falling back to corpus", async () => {
    const { code, out } = await runBench(`--swebench=${datasetFile}`, "--dry-run", "--limit=1")
    expect(code).toBe(0)
    expect(out).toContain("dry-run plan")
    expect(out).toContain(`dataset: ${datasetFile}`)
    expect(out).toContain("2 loaded, 1 selected (--limit 1)")
    expect(out).toContain("preset: agentless-v3-thin-strict")
    expect(out).toContain("sample ids: demo__inst-1")
  })

  test.concurrent("invalid --limit in dataset mode falls back to no cap instead of selecting zero", async () => {
    const { code, out } = await runBench("--swebench", datasetFile, "--dry-run", "--limit", "bogus")
    expect(code).toBe(0)
    expect(out).toContain("2 loaded, 2 selected")
    expect(out).toContain("sample ids: demo__inst-1, demo__inst-2")
  })
})
