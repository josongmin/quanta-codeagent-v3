/**
 * Integration hellgate — T-1 auth-pool dry-run wiring (jun-20 multi-auth fleet).
 *
 * Drives the real `quanta-bench` CLI to prove:
 *  - `pool` / `grade --mode full` dry-run print the resolved auth source,
 *  - a pool manifest surfaces account LABELS, never token bytes,
 *  - dry-run never reads any auth JSON file (points auth at a path that does
 *    NOT exist; a read would crash the process).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoundedTestExecutor } from "../_support/bounded-test-concurrency"

const ENTRY = "src/apps/bench/cli.ts"
// Repo root anchored on this file, not on the ambient cwd: ENTRY below is a
// repo-RELATIVE path, so the spawn only works when `cwd` is the real repo root.
const REPO = join(import.meta.dir, "..", "..")
const runBounded = createBoundedTestExecutor(2)
setDefaultTimeout(30_000)

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
  return runBounded(async () => {
    const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    })
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
    return { code: await proc.exited, out }
  })
}

describe("T-1 bench pool dry-run with auth pool", () => {
  test.concurrent("single-auth dry-run prints the single source and stays exit-0", async () => {
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

  test.concurrent("pool manifest dry-run lists account labels, never token bytes", async () => {
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

  test.concurrent("--auth-pool flag is honored on the pool dry-run plan", async () => {
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

  test.concurrent("--auth-label pins the pool dry-run to one account", async () => {
    const { code, out } = await runCli(
      {},
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--auth-pool",
      manifest,
      "--auth-label",
      "acct-b",
      "--datasets",
      ds,
    )
    expect(code).toBe(0)
    expect(out).toContain("auth: pool of 1")
    expect(out).toContain("acct-b")
    expect(out).not.toContain("acct-a")
    expect(out).toMatch(/plan chunk .* acct-b/)
  })

  test.concurrent("unknown --auth-label fails fast instead of silently using another account", async () => {
    const { code, out } = await runCli(
      {},
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--auth-pool",
      manifest,
      "--auth-label",
      "missing",
      "--datasets",
      ds,
    )
    expect(code).toBe(1)
    expect(out).toMatch(/unknown account label "missing"/)
  })

  test.concurrent("all-disabled auth pools fail fast instead of silently using a disabled account", async () => {
    const disabledManifest = join(dir, "auth-pool-disabled.yaml")
    writeFileSync(
      disabledManifest,
      [
        "accounts:",
        "  - label: acct-a",
        `    auth_file: ${join(dir, "nope-a.json")}`,
        "    max_parallel: 6",
        "    disabled: true",
        "  - label: acct-b",
        `    auth_file: ${join(dir, "nope-b.json")}`,
        "    max_parallel: 6",
        "    disabled: true",
      ].join("\n"),
    )
    const { code, out } = await runCli(
      {},
      "pool",
      "--allow-remote-secrets",
      "--dry-run",
      "--auth-pool",
      disabledManifest,
      "--datasets",
      ds,
    )
    expect(code).toBe(1)
    expect(out).toMatch(/no enabled accounts available/i)
  })
})

describe("T-1 full-remote dry-run shares the auth source", () => {
  test.concurrent("grade --mode full dry-run prints the resolved auth source (pool)", async () => {
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

  test.concurrent("grade --mode full rejects --auth-label outside pool mode", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_FILE: NONEXISTENT_AUTH },
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      ds,
      "--dry-run",
      "--auth-label",
      "acct-a",
    )
    expect(code).toBe(1)
    expect(out).toMatch(/requires auth pool mode/i)
  })

  test.concurrent("grade --mode full rejects all-disabled auth pools", async () => {
    const disabledManifest = join(dir, "full-auth-pool-disabled.yaml")
    writeFileSync(
      disabledManifest,
      [
        "accounts:",
        "  - label: acct-a",
        `    auth_file: ${join(dir, "nope-a.json")}`,
        "    max_parallel: 6",
        "    disabled: true",
      ].join("\n"),
    )
    const { code, out } = await runCli(
      {},
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      ds,
      "--dry-run",
      "--auth-pool",
      disabledManifest,
    )
    expect(code).toBe(1)
    expect(out).toMatch(/no enabled accounts available/i)
  })
})
