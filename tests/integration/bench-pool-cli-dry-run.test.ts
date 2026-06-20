import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let dsA = ""
let dsB = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-pool-dry-run-"))
  const aDir = join(dir, "a")
  const bDir = join(dir, "b")
  mkdirSync(aDir)
  mkdirSync(bDir)
  dsA = join(aDir, "same.jsonl")
  dsB = join(bDir, "same.jsonl")
  const row = `${JSON.stringify({
    instance_id: "demo__inst-1",
    repo: "demo/repo",
    base_commit: "0".repeat(40),
    problem_statement: "fix one",
  })}\n`
  writeFileSync(dsA, row)
  writeFileSync(dsB, row)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runCli = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      QUANTA_BENCH_AUTH_FILE: "/tmp/not-read-in-dry-run.json",
    },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  return { code: await proc.exited, out }
}

describe("bench pool cli dry-run", () => {
  test("single-box default spends the full shared token budget on one box", async () => {
    const { code, out } = await runCli(
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      dsA,
    )
    expect(code).toBe(0)
    expect(out).toContain("workers=1")
    expect(out).toContain("concurrency=16")
  })

  test("workers > 1 is refused without explicit extra-box opt-in", async () => {
    const { code, out } = await runCli(
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      `${dsA},${dsB}`,
      "--workers",
      "2",
    )
    expect(code).not.toBe(0)
    expect(out).toContain("--allow-extra-boxes")
  })

  test("explicit multi-box opt-in is allowed and splits the default token budget", async () => {
    const { code, out } = await runCli(
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--allow-extra-boxes",
      "--datasets",
      `${dsA},${dsB}`,
      "--workers",
      "2",
    )
    expect(code).toBe(0)
    expect(out).toContain("workers=2")
    expect(out).toContain("concurrency=8")
  })

  test("duplicate dataset basenames get unique runIds (no silent chunk collision)", async () => {
    const { code, out } = await runCli(
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      `${dsA},${dsB}`,
    )
    expect(code).toBe(0)
    expect(out).toContain(`chunk same ← ${dsA}`)
    expect(out).toContain(`chunk same_2 ← ${dsB}`)
    expect(out).toContain("box dir ~/runs/same/")
    expect(out).toContain("box dir ~/runs/same_2/")
  })
})
