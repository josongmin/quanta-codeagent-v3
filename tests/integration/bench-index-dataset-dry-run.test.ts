import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/index.ts"
const REPO = process.cwd()

let dir: string
let datasetFile = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-dataset-dry-run-"))
  datasetFile = join(dir, "instances.jsonl")
  writeFileSync(
    datasetFile,
    [
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
    ].join("\n") + "\n",
  )
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runBench = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      QUANTA_PROVIDER: "openai",
    },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  const code = await proc.exited
  return { code, out }
}

describe("bench index dataset dry-run", () => {
  test("--swebench --dry-run prints the plan and never asks for API keys", async () => {
    const { code, out } = await runBench("--swebench", datasetFile, "--dry-run", "--limit", "1")
    expect(code).toBe(0)
    expect(out).toContain("dry-run plan")
    expect(out).toContain(`dataset: ${datasetFile}`)
    expect(out).toContain("2 loaded, 1 selected (--limit 1)")
    expect(out).toContain("sample ids: demo__inst-1")
    expect(out.toLowerCase()).not.toContain("no api key")
  })

  test("invalid --limit in dataset mode falls back to no cap instead of selecting zero", async () => {
    const { code, out } = await runBench("--swebench", datasetFile, "--dry-run", "--limit", "bogus")
    expect(code).toBe(0)
    expect(out).toContain("2 loaded, 2 selected")
    expect(out).toContain("sample ids: demo__inst-1, demo__inst-2")
  })
})
