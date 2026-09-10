import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"
const CLI = join(import.meta.dir, "cli.ts")
const fixtureDir = mkdtempSync(join(tmpdir(), "quanta-cli-canary-"))
const dataset = join(fixtureDir, "dataset.jsonl")
const report = join(fixtureDir, "report.json")

writeFileSync(
  dataset,
  `${JSON.stringify({
    instance_id: "demo__pkg-1",
    repo: "demo/pkg",
    base_commit: "0".repeat(40),
    problem_statement: "fix it",
    patch: "",
    test_patch: "",
    FAIL_TO_PASS: "[]",
    PASS_TO_PASS: "[]",
  })}\n`,
)
writeFileSync(report, JSON.stringify({ model: "gpt-5.4", resolved_ids: [] }))

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

interface Invocation {
  readonly name: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly absentAccepts: (code: number, output: string) => boolean
}

const roots: readonly Invocation[] = [
  {
    name: "run",
    args: ["run", "--swebench", dataset, "--dry-run"],
    absentAccepts: (code, output) => code === 0 && output.includes("dry-run plan"),
  },
  {
    name: "no-subcommand",
    args: ["--swebench", dataset, "--dry-run"],
    absentAccepts: (code, output) => code === 0 && output.includes("dry-run plan"),
  },
  {
    name: "grade",
    args: ["grade"],
    absentAccepts: (code, output) => code === 2 && /usage: quanta-bench grade/.test(output),
  },
  {
    name: "grade-full",
    args: ["grade", "--mode", "full", "--allow-remote-secrets", "--dataset", dataset, "--dry-run"],
    absentAccepts: (code, output) => code === 0 && output.includes("full-remote plan"),
  },
  {
    name: "pool",
    args: ["pool"],
    absentAccepts: (code, output) => code === 2 && /refused: pool runs patch-gen/.test(output),
  },
  {
    name: "bestk-passk",
    args: [
      "bestk-passk",
      "--observe-root",
      "/nonexistent-observe-root",
      "--dataset",
      "/nonexistent.jsonl",
      "--backend",
      "ec2",
      "--report",
      report,
    ],
    env: { QUANTA_BENCH_BESTK_PASSK: "1" },
    absentAccepts: (code, output) => code !== 0 && !/unknown dataset family/i.test(output),
  },
  {
    name: "terminal",
    args: ["terminal"],
    absentAccepts: (code) => code === 0,
  },
]

interface Result {
  readonly code: number
  readonly output: string
}

const runCli = async (invocation: Invocation, extraArgs: readonly string[]): Promise<Result> => {
  const env: Record<string, string | undefined> = { ...process.env, ...invocation.env }
  delete env[FAMILY_KEY]
  const processHandle = Bun.spawn([process.execPath, CLI, ...invocation.args, ...extraArgs], {
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { code, output: `${stdout}${stderr}` }
}

const runBatch = async (extraArgs: readonly string[]): Promise<Result[]> => {
  const results = new Array<Result>(roots.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < roots.length) {
      const index = cursor
      cursor += 1
      const root = roots[index]
      if (root !== undefined) results[index] = await runCli(root, extraArgs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, roots.length) }, () => worker()))
  return results
}

test("PR canary: every family-bearing root rejects an invalid selector and admits its absent control", async () => {
  const invalid = await runBatch(["--dataset-family", "prow"])
  const absent = await runBatch([])
  expect(invalid).toHaveLength(roots.length)
  expect(absent).toHaveLength(roots.length)
  for (const [index, root] of roots.entries()) {
    const rejected = invalid[index]
    const control = absent[index]
    expect(rejected, `${root.name}: missing invalid result`).toBeDefined()
    expect(control, `${root.name}: missing absent result`).toBeDefined()
    expect(rejected?.code, `${root.name}: invalid selector exit`).not.toBe(0)
    expect(rejected?.output, `${root.name}: invalid selector reason`).toMatch(
      /unknown dataset family|SWE-only/i,
    )
    expect(
      root.absentAccepts(control?.code ?? -1, control?.output ?? ""),
      `${root.name}: absent control returned ${control?.code}: ${control?.output.slice(0, 160)}`,
    ).toBe(true)
  }
}, 240_000)

test("PR canary: run root exposes the canonical Pro family and preset decision", async () => {
  const result = await runCli(roots[0] as Invocation, ["--dataset-family", "pro"])
  expect(result.code).toBe(0)
  expect(result.output).toMatch(/dataset family:\s*pro/i)
  expect(result.output).toMatch(/preset:\s*agentless-v1/i)
}, 60_000)
