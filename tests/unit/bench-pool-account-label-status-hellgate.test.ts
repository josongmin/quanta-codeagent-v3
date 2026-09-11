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

/** The AMI id the fake `aws ssm get-parameter` resolves to. */
const RESOLVED_AMI = "ami-0123456789abcdef0"

const spawnOk = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })

const commandFromArgs = (args: readonly string[]): string => args[args.length - 1] ?? ""

const runIdFromArgs = (args: readonly string[]): string =>
  commandFromArgs(args).match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"

const emitPoolPass = (
  args: readonly string[],
  onData: ((data: string) => void) | undefined,
): void => {
  if (!args.some((arg) => arg.includes("cli.ts run"))) return
  onData?.(`[PASS] ${runIdFromArgs(args)}__inst-1 (turns=2)\n`)
}

const sshResponse = (args: readonly string[]): SpawnResult => {
  const command = commandFromArgs(args)
  // The family-profile readiness probe, added with `assertBoxProfileReady`,
  // ends `&& echo OK` and the caller requires stdout to contain "OK". This
  // stub had no branch for it and fell through to `spawnOk("")`, so bootstrap
  // threw "dataset-family=verified readiness probe failed" and both cases here
  // failed on provisioning before either could assert anything about account
  // labels. Answering what the probe ASKS FOR rather than a sentinel of the
  // stub's own choosing is what keeps the two from drifting again.
  if (command.trim().endsWith("echo OK")) return spawnOk("OK")
  if (command.includes("READY")) return spawnOk("READY")
  if (command.includes("run.exit")) return spawnOk("0\n==XQ-RUN-EXIT-XQ==\n")
  if (command.includes("mkdir ~/.pool-grade.lock")) return spawnOk("LOCKED")
  if (command.includes("rmdir ~/.pool-grade.lock")) return spawnOk("")
  const report = command.match(/cat ~\/runs\/([^/]+)\/report\.json/)
  return report === null
    ? spawnOk("")
    : spawnOk(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
}

const infrastructureResponse = (args: readonly string[]): SpawnResult | undefined => {
  if (args.includes("get-parameter")) return spawnOk(`${RESOLVED_AMI}\n`)
  if (args.includes("run-instances")) return spawnOk("i-box")
  if (args.includes("describe-instances")) return spawnOk("1.2.3.4")
  return args.includes("terminate-instances") ? spawnOk("") : undefined
}

const mockSpawn = () => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const fn: SpawnFn = async (cmd, args, options): Promise<SpawnResult> => {
    calls.push({
      cmd,
      args: [...args],
      ...(options?.input !== undefined ? { input: options.input } : {}),
    })
    if (cmd === "curl") return spawnOk("9.9.9.9") // ifconfig.me public-IP probe (SG ingress)
    // aug-22 regression repair (`9d5369d31`): the default AMI is now an `ssm:`
    // reference that `resolveLaunchAmi` dereferences BEFORE RunInstances. Without
    // this branch the stub returned empty stdout ⇒ resolution threw ⇒ the pool
    // aborted before a single status snapshot was written. The resolution contract
    // itself stays pinned by src/apps/bench/remote/box-session/ami-resolution.test.ts.
    const infrastructure = infrastructureResponse(args)
    if (infrastructure !== undefined) return infrastructure
    if (cmd !== "ssh") return spawnOk("")
    emitPoolPass(args, options?.onData)
    return sshResponse(args)
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
    const provider = createLeasePoolAuthProvider(mgr, () =>
      JSON.stringify({ access_token: "ACCESS-a", expires_at: "2099-01-01T00:00:00.000Z" }),
    )
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
    await runPool(
      CHUNK,
      baseCfg(fn, {
        authJsonProvider: () =>
          JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }),
      }),
    )
    const writes = statusWrites(calls)
    expect(writes.length).toBeGreaterThan(0)
    for (const s of writes) expect(s).not.toContain("accountLabel")
  })
})
