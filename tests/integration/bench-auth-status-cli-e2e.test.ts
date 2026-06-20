/**
 * Integration hellgate — T-6 `quanta-bench auth status` (jun-20 multi-auth fleet).
 *
 * Operators must be able to see the account roster before/while running a fleet,
 * WITHOUT any token material leaking. Drives the real CLI:
 *  - pool manifest ⇒ lists every account label + capacity (incl. disabled),
 *  - single-auth ⇒ a sane single-account view,
 *  - --json is machine-readable,
 *  - no auth file CONTENTS are read and no token bytes are ever printed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let manifest = ""
const NONEXISTENT = "/tmp/qbap-auth-status-missing.json"

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-auth-status-"))
  manifest = join(dir, "pool.yaml")
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
      "    max_parallel: 4",
      "    disabled: true",
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

describe("T-6 auth status", () => {
  test("pool manifest lists every account with capacity + disabled flag", async () => {
    const { code, out } = await runCli({ QUANTA_BENCH_AUTH_POOL: manifest }, "auth", "status")
    expect(code).toBe(0)
    expect(out).toContain("pool of 2 account(s)")
    expect(out).toMatch(/acct-a.*maxParallel=6.*maxBoxes=1/)
    expect(out).toMatch(/acct-b.*maxParallel=4/)
    expect(out).toContain("(disabled)") // acct-b disabled is visible
    // token-blind: never read the (missing) files, never print token-shaped bytes
    expect(out).not.toMatch(/ENOENT|no such file/)
    expect(out).not.toMatch(/access_token|refresh_token|id_token/)
  })

  test("--json is machine-readable and token-blind", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_POOL: manifest },
      "auth",
      "status",
      "--json",
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1))
    expect(parsed.mode).toBe("pool")
    expect(parsed.accounts.map((a: { label: string }) => a.label)).toEqual(["acct-a", "acct-b"])
    expect(parsed.accounts[1].disabled).toBe(true)
    expect(out).not.toMatch(/access_token|refresh_token/)
  })

  test("single-auth renders a sane single-account view", async () => {
    const { code, out } = await runCli({ QUANTA_BENCH_AUTH_FILE: NONEXISTENT }, "auth", "status")
    expect(code).toBe(0)
    expect(out).toContain("single account")
    expect(out).toContain(NONEXISTENT)
    expect(out).not.toMatch(/ENOENT|access_token/)
  })

  test("--auth-label narrows the roster to one account", async () => {
    const { code, out } = await runCli(
      { QUANTA_BENCH_AUTH_POOL: manifest },
      "auth",
      "status",
      "--auth-label",
      "acct-a",
    )
    expect(code).toBe(0)
    expect(out).toContain("pool of 1 account(s)")
    expect(out).toContain("acct-a")
    expect(out).not.toContain("acct-b")
  })

  test("unknown subaction prints usage and exits non-zero", async () => {
    const { code, out } = await runCli({}, "auth", "bogus")
    expect(code).not.toBe(0)
    expect(out).toMatch(/usage: quanta-bench auth status/)
  })
})
