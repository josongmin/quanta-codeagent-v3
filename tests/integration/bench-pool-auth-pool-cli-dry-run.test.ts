/**
 * Integration hellgate — T-3 pool account-aware dry-run plan (jun-20).
 *
 * The operator must be able to SEE, before launch, which account each chunk
 * would route to. This drives the real CLI and asserts the per-chunk account
 * plan renders (and never leaks token bytes / reads auth files).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let dsA = ""
let dsB = ""
let manifest = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-pool-auth-dry-"))
  const row = `${JSON.stringify({
    instance_id: "demo__inst-1",
    repo: "demo/repo",
    base_commit: "0".repeat(40),
    problem_statement: "fix one",
  })}\n`
  dsA = join(dir, "ca.jsonl")
  dsB = join(dir, "cb.jsonl")
  writeFileSync(dsA, row)
  writeFileSync(dsB, row)
  manifest = join(dir, "pool.yaml")
  writeFileSync(
    manifest,
    [
      "accounts:",
      "  - label: acct-a",
      `    auth_file: ${join(dir, "nope-a.json")}`,
      "    max_parallel: 6",
      "  - label: acct-b",
      `    auth_file: ${join(dir, "nope-b.json")}`,
      "    max_parallel: 6",
    ].join("\n"),
  )
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runCli = async (
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  return { code: await proc.exited, out }
}

describe("T-3 pool dry-run shows the per-chunk account plan", () => {
  test("two-account manifest spreads chunks across acct-a and acct-b", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_POOL: manifest },
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      `${dsA},${dsB}`,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: pool of 2")
    // least-loaded spread ⇒ first chunk acct-a, second acct-b.
    expect(out).toMatch(/plan ca → acct-a/)
    expect(out).toMatch(/plan cb → acct-b/)
    // dry-run never reads the (missing) token files, never prints token bytes.
    expect(out).not.toMatch(/ENOENT|no such file/)
    expect(out).not.toMatch(/access_token|refresh_token/)
  })

  test("single-auth pool dry-run shows NO per-chunk account plan", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_FILE: "/tmp/qbap-single.json" },
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      dsA,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: single")
    expect(out).not.toMatch(/plan ca →/)
  })
})
