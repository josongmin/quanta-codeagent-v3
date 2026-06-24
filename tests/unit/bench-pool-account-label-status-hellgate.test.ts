/**
 * Hellgate — T-6 account label in the box status snapshot (jun-20 multi-auth).
 *
 * The pool leases an account per chunk (T-3); this proves that label is THREADED
 * all the way into the box status snapshot the operator reads via `box ls`, so a
 * 429 can be attributed to a specific account. Single-auth writes NO label.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthLeaseManager } from "../../src/apps/bench/auth-pool"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import { createLeasePoolAuthProvider } from "../../src/apps/bench/remote/pool-auth"

const BUDGET_DIRS = new Set<string>()
const allocBudgetDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-acct-status-"))
  BUDGET_DIRS.add(dir)
  return dir
}
afterAll(() => {
  for (const d of BUDGET_DIRS) rmSync(d, { recursive: true, force: true })
})

const mockSpawn = () => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
  const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
    calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
    if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
      const runId =
        (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"
      o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
    }
    const a = [...args]
    if (cmd === "curl") return ok("9.9.9.9") // ifconfig.me public-IP probe (SG ingress)
    if (a.includes("run-instances")) return ok("i-box")
    if (a.includes("describe-instances")) return ok("1.2.3.4")
    if (a.includes("terminate-instances")) return ok("")
    if (cmd === "ssh") {
      const c = a[a.length - 1] ?? ""
      if (c.includes("READY")) return ok("READY")
      if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
      if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
      if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
      const r = c.match(/cat ~\/runs\/([^/]+)\/report\.json/)
      if (r) return ok(JSON.stringify({ resolved_ids: [`x__${r[1]}-1`] }))
      return ok("")
    }
    return ok("")
  }
  return { fn, calls }
}

const provision = (spawn: SpawnFn) => ({
  repoDir: "/tmp/repo",
  authJson: "{}",
  datasetPath: "/tmp/unused.jsonl",
  spawn,
  sleep: async () => {},
  maxReadyPolls: 2,
})

const statusWrites = (calls: Array<{ cmd: string; args: string[]; input?: string }>): string[] =>
  calls
    .filter(
      (c) =>
        c.cmd === "ssh" &&
        c.input !== undefined &&
        c.args.join(" ").includes("bench-box-status.json"),
    )
    .map((c) => c.input ?? "")

const baseCfg = (spawn: SpawnFn, over: Record<string, unknown>) => ({
  provision: provision(spawn),
  workers: 1,
  preset: "agentless-v2",
  model: "gpt-5.4",
  concurrency: 8,
  tokenBudgetDir: allocBudgetDir(),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  singleBoxGuardDir: join(allocBudgetDir(), "guard"), // isolate the cross-run box guard per test
  authJsonProvider: () => "{}", // default; `over` may replace it
  ...over,
})

const CHUNK: PoolChunk[] = [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }]

describe("T-6 account label in box status snapshot", () => {
  test("pool mode writes the leased accountLabel into the status snapshot", async () => {
    const { fn, calls } = mockSpawn()
    const mgr = new AuthLeaseManager([{ label: "acct-a", authFile: "/a.json", maxParallel: 6 }], {
      now: () => 1_000_000,
    })
    const provider = createLeasePoolAuthProvider(mgr, () => JSON.stringify({ access_token: "ACCESS-a", expires_at: "2099-01-01T00:00:00.000Z" }))
    await runPool(CHUNK, baseCfg(fn, { authProvider: provider, authJsonProvider: () => "{}" }))
    const writes = statusWrites(calls)
    expect(writes.length).toBeGreaterThan(0)
    // PARSE each snapshot (not substring-match the serialized bytes) and assert the
    // accountLabel FIELD equals the leased account — constrains semantics, not layout.
    const snaps = writes.map((s) => JSON.parse(s) as { accountLabel?: string; runId?: string })
    const labeled = snaps.filter((s) => s.accountLabel !== undefined)
    expect(labeled.length).toBeGreaterThan(0)
    for (const s of labeled) expect(s.accountLabel).toBe("acct-a")
    // and the runId rides along on the same snapshots
    expect(snaps.some((s) => s.runId === "c1")).toBe(true)
  })

  test("single-auth mode writes NO accountLabel (byte-clean legacy snapshot)", async () => {
    const { fn, calls } = mockSpawn()
    await runPool(CHUNK, baseCfg(fn, { authJsonProvider: () => JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }) }))
    const writes = statusWrites(calls)
    expect(writes.length).toBeGreaterThan(0)
    for (const s of writes) expect(s).not.toContain("accountLabel")
  })
})
