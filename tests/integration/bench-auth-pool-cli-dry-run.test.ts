/**
 * Integration hellgate — T-1 auth-pool dry-run wiring (jun-20 multi-auth fleet).
 *
 * Drives the real `quanta-bench` CLI to prove:
 *  - `pool` / `grade --mode full` dry-run print the resolved auth source,
 *  - a pool manifest surfaces account LABELS, never token bytes,
 *  - dry-run never reads any auth JSON file (points auth at a path that does
 *    NOT exist; a read would crash the process).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let ds = ""
let manifest = ""
const NONEXISTENT_AUTH = "/tmp/qbap-does-not-exist-dry-run.json"

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-auth-pool-dry-"))
  ds = join(dir, "chunk.jsonl")
  writeFileSync(
    ds,
    `${JSON.stringify({
      instance_id: "demo__inst-1",
      repo: "demo/repo",
      base_commit: "0".repeat(40),
      problem_statement: "fix one",
    })}\n`,
  )
  manifest = join(dir, "auth-pool.yaml")
  // auth files deliberately point at NONEXISTENT paths — dry-run must not read them.
  writeFileSync(
    manifest,
    [
      "accounts:",
      "  - label: acct-a",
      `    auth_file: ${join(dir, "nope-a.json")}`,
      "    max_parallel: 6",
      "    max_boxes: 1",
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

describe("T-1 bench pool dry-run with auth pool", () => {
  test("single-auth dry-run prints the single source and stays exit-0", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_FILE: NONEXISTENT_AUTH },
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      ds,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: single")
    expect(out).toContain(NONEXISTENT_AUTH)
  })

  test("pool manifest dry-run lists account labels, never token bytes", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_POOL: manifest },
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--datasets",
      ds,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: pool of 2")
    expect(out).toContain("acct-a")
    expect(out).toContain("acct-b")
    // dry-run never reads the (nonexistent) auth files ⇒ no ENOENT crash
    expect(out).not.toMatch(/ENOENT|no such file/)
    expect(out).not.toMatch(/access_token|refresh_token/)
  })

  test("--auth-pool flag is honored on the pool dry-run plan", async () => {
    const { code, out } = await runCli(
      {},
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--auth-pool",
      manifest,
      "--datasets",
      ds,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: pool of 2")
  })
})

describe("T-1 full-remote dry-run shares the auth source", () => {
  test("grade --mode full dry-run prints the resolved auth source (pool)", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_POOL: manifest },
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      ds,
      "--dry-run",
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: pool of 2")
    expect(out).not.toMatch(/ENOENT|no such file/)
  })
})
