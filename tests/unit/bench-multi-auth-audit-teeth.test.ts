/**
 * Audit-hardening teeth — jun-20 multi-auth fleet (round-1 adversarial findings).
 *
 * Each test here was added because an adversarial audit found a real production
 * behavior with NO red-on-injection coverage. The comment on each names the exact
 * production line whose deletion/mutation it turns red.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthPoolEntry } from "../../src/apps/bench/auth-pool"
import { AuthLeaseManager, parseAuthPoolManifest } from "../../src/apps/bench/auth-pool"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import {
  createLeasePoolAuthProvider,
  type PoolAuthProvider,
} from "../../src/apps/bench/remote/pool-auth"
import { acquirePatchGenBudgetLease } from "../../src/apps/bench/remote/token-budget"

const FIXED_NOW = 1_000_000

/** The AMI id the fake `aws ssm get-parameter` resolves to. */
const RESOLVED_AMI = "ami-0123456789abcdef0"

// ───────────────────────── lease-manager pure teeth ─────────────────────────

describe("audit: weight biases least-loaded routing (lease-manager.ts loadScore *weight)", () => {
  test("a higher-weight account absorbs more chunks before the lighter one", () => {
    const m = new AuthLeaseManager(
      [
        { label: "a", authFile: "/a.json", maxParallel: 10, weight: 1 },
        { label: "b", authFile: "/b.json", maxParallel: 10, weight: 3 },
      ],
      { now: () => FIXED_NOW },
    )
    // 4 acquires, no release ⇒ pure least-loaded spread under weight.
    const picks = Array.from(
      { length: 4 },
      (_v, i) => m.acquire({ requestedSlots: 1, runId: `r${i}` })?.accountLabel,
    )
    const b = picks.filter((p) => p === "b").length
    const a = picks.filter((p) => p === "a").length
    // weighted (b weight 3) ⇒ b takes ≥3 of the first 4; UNWEIGHTED would give 2/2.
    // Deleting the `* weight` factor in loadScore turns this red.
    expect(b).toBeGreaterThanOrEqual(3)
    expect(b).toBeGreaterThan(a)
  })
})

describe("audit: release(rateLimited && completed) cools and does NOT reset the streak", () => {
  test("a chunk that earned verdicts but also 429'd still cools its account", () => {
    const m = new AuthLeaseManager(
      [{ label: "a", authFile: "/a.json", maxParallel: 6, cooldownBaseSec: 10 }],
      {
        now: () => FIXED_NOW,
      },
    )
    const lease = m.acquire({ requestedSlots: 1, runId: "r1" })
    lease?.release({ rateLimited: true, lostBox: false, completed: true })
    const s = m.snapshot()[0]
    expect(s?.cooldownUntil).toBe(FIXED_NOW + 10_000) // cooled (rateLimited wins the if/else)
    expect(s?.consecutiveRateLimited).toBe(1) // NOT reset to 0 by `completed`
  })
})

describe("audit: cooling account + saturated other ⇒ null acquire, nextReadyAt reflects the cooling one", () => {
  test("worker can size its wait off the cooling account even when the other is full", () => {
    const clock = FIXED_NOW
    const m = new AuthLeaseManager(
      [
        { label: "a", authFile: "/a.json", maxParallel: 6, cooldownBaseSec: 10 },
        { label: "b", authFile: "/b.json", maxParallel: 1 },
      ],
      { now: () => clock },
    )
    // saturate b (hold its single slot), cool a via a 429
    m.acquire({ requestedSlots: 1, runId: "rb", preferredAccountLabel: "b" })
    m.acquire({ requestedSlots: 1, runId: "ra", preferredAccountLabel: "a" })?.release({
      rateLimited: true,
      lostBox: false,
      completed: false,
    })
    // a cooling, b saturated ⇒ nothing acquirable now
    expect(m.acquire({ requestedSlots: 1, runId: "rc" })).toBeNull()
    // but the wait can be sized off a's cooldown (b is saturated, NOT cooling ⇒ ignored)
    expect(m.nextReadyAt()).toBe(clock + 10_000)
  })
})

describe("audit: manifest parsing is an explicit allowlist (no field smuggling / no pollution)", () => {
  test("a stray TOP-LEVEL manifest key is dropped, not copied onto the entry", () => {
    const polluted = ({} as Record<string, unknown>).polluted
    const src = parseAuthPoolManifest(
      // `evil` is a top-level account field; `__proto__` carries a payload.
      `accounts:\n  - { label: a, auth_file: /x.json, max_parallel: 1, evil: "smuggled", __proto__: { polluted: true } }`,
    )
    if (src.kind !== "pool") throw new Error("expected pool")
    const account = src.accounts[0]
    if (account === undefined) throw new Error("expected an account")
    const entry = account as unknown as Record<string, unknown>
    // TEETH: toEntry reads ONLY named fields, so a stray key never reaches the
    // entry. A refactor to `return { ...rec, label, ... }` would surface `evil`
    // here and break the exact-keys assertion. (The prior test nested the payload
    // inside __proto__, which the allowlist drops trivially — no teeth.)
    expect(entry.evil).toBeUndefined()
    expect(Object.keys(entry).sort()).toEqual(["authFile", "label", "maxParallel"])
    // and Object.prototype is never polluted by a top-level __proto__ payload
    expect(({} as Record<string, unknown>).polluted).toBe(polluted)
  })
})

// ───────────────────────── runPool worker-loop teeth ─────────────────────────

const mockSpawn = (opts: { rateLimited?: Set<string> } = {}) => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
  const emitBenchRunPass = (
    args: readonly string[],
    onData: ((chunk: string) => void) | undefined,
  ): void => {
    if (!args.some((a) => a.includes("cli.ts run"))) return
    const runId =
      (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"
    onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
  }
  /**
   * Fixed-string command replies.
   *
   * The family-profile readiness probe ends `&& echo OK` and its caller
   * requires stdout to contain "OK". Without a branch for it this stub fell
   * through and bootstrap threw "dataset-family=verified readiness probe
   * failed", so every case here failed on provisioning before it could assert
   * anything. Answering what the probe ASKS FOR keeps the two from drifting.
   */
  const literalSshReply = (command: string): string | undefined => {
    if (command.trim().endsWith("echo OK")) return "OK"
    if (command.includes("READY")) return "READY"
    if (command.includes("run.exit")) return "0\n==XQ-RUN-EXIT-XQ==\n"
    if (command.includes("mkdir ~/.pool-grade.lock")) return "LOCKED"
    if (command.includes("rmdir ~/.pool-grade.lock")) return ""
    return undefined
  }

  /** Replies derived from the run id embedded in the command. */
  const derivedSshReply = (command: string): string | undefined => {
    const report = command.match(/cat ~\/runs\/([^/]+)\/report\.json/)
    if (report) return JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] })
    const runLog = command.match(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/)
    if (runLog && opts.rateLimited?.has(runLog[1] ?? "")) {
      return "[FAIL][generation_error] z (turns=2)"
    }
    return undefined
  }

  const routeSsh = (args: string[]): SpawnResult => {
    const command = args[args.length - 1] ?? ""
    return ok(literalSshReply(command) ?? derivedSshReply(command) ?? "")
  }
  const route = (cmd: string, args: string[]): SpawnResult => {
    if (cmd === "curl") return ok("9.9.9.9") // ifconfig.me public-IP probe (SG ingress)
    // aug-22 regression repair (`9d5369d31`): the default AMI is now an `ssm:`
    // reference that `resolveLaunchAmi` dereferences BEFORE RunInstances. Without
    // this branch the stub answered empty stdout ⇒ resolution threw ⇒ the pool
    // aborted at provisioning and the backoff/cooldown teeth below never ran. The
    // resolution contract stays pinned by
    // src/apps/bench/remote/box-session/ami-resolution.test.ts.
    if (args.includes("get-parameter")) return ok(`${RESOLVED_AMI}\n`)
    if (args.includes("run-instances")) return ok("i-box")
    if (args.includes("describe-instances")) return ok("1.2.3.4")
    if (args.includes("terminate-instances")) return ok("")
    if (cmd === "ssh") return routeSsh(args)
    return ok("")
  }
  const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
    calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
    if (cmd === "ssh") emitBenchRunPass(args, o?.onData)
    return route(cmd, [...args])
  }
  return { fn, calls }
}

const BUDGET_DIRS = new Set<string>()
const allocBudgetDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-audit-teeth-"))
  BUDGET_DIRS.add(dir)
  return dir
}
const datasetFor = (runId: string): string => {
  const dir = allocBudgetDir()
  const path = join(dir, `${runId}.jsonl`)
  writeFileSync(path, `${JSON.stringify({ id: `x__${runId}-1` })}\n`)
  return path
}
const chunk = (runId: string): PoolChunk => ({ runId, datasetPath: datasetFor(runId) })
afterAll(() => {
  for (const d of BUDGET_DIRS) rmSync(d, { recursive: true, force: true })
})

const TWO: readonly AuthPoolEntry[] = [
  { label: "acct-a", authFile: "/a.json", maxParallel: 6, cooldownBaseSec: 30 },
  { label: "acct-b", authFile: "/b.json", maxParallel: 6, cooldownBaseSec: 30 },
]

const cfg = (fn: SpawnFn, provider: PoolAuthProvider, over: Record<string, unknown> = {}) => ({
  provision: {
    repoDir: "/r",
    authJson: "{}",
    datasetPath: "/u.jsonl",
    spawn: fn,
    sleep: async () => {},
    maxReadyPolls: 2,
  },
  workers: 1,
  preset: "agentless-v2",
  model: "gpt-5.4",
  concurrency: 8,
  tokenBudgetDir: allocBudgetDir(),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  singleBoxGuardDir: join(allocBudgetDir(), "guard"), // isolate the cross-run box guard per test
  authJsonProvider: () => "{}",
  authProvider: provider,
  ...over,
})

describe("audit: worker threads boxAccountLabel as next-chunk affinity (pool.ts state.boxAccountLabel)", () => {
  test("chunk N+1's acquire is PREFERRED toward chunk N's leased account", async () => {
    const { fn } = mockSpawn()
    const mgr = new AuthLeaseManager(TWO, { now: () => FIXED_NOW })
    const base = createLeasePoolAuthProvider(mgr, () =>
      JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }),
    )
    const preferredSeen: Array<string | undefined> = []
    const recording: PoolAuthProvider = {
      acquire: (req) => {
        preferredSeen.push(req.preferredAccountLabel)
        return base.acquire(req)
      },
      canEventuallySchedule: () => base.canEventuallySchedule(),
      nextReadyAt: () => base.nextReadyAt(),
    }
    const chunks: PoolChunk[] = [chunk("c1"), chunk("c2")]
    await runPool(chunks, cfg(fn, recording))
    // first chunk has no affinity; second is PREFERRED toward the first's account.
    // Deleting `state.boxAccountLabel = leasedAccountLabel` makes [1] undefined ⇒ red.
    expect(preferredSeen[0]).toBeUndefined()
    expect(preferredSeen[1]).toBe("acct-a")
  })
})

describe("audit: budget-timeout abort still returns the account slot (no auth-lease leak)", () => {
  test("when the global budget is exhausted, the abort releases the leased account", async () => {
    const tokenBudgetDir = allocBudgetDir()
    // Hold the ENTIRE budget so the pool's per-chunk budget acquire times out and
    // the run aborts AFTER the auth lease was already acquired.
    const held = await acquirePatchGenBudgetLease({
      label: "block-all-budget",
      requestedUnits: 16,
      minUnits: 16,
      dir: tokenBudgetDir,
      waitMs: 1_000,
      pollMs: 10,
    })
    try {
      const { fn } = mockSpawn()
      const mgr = new AuthLeaseManager(TWO, { now: () => FIXED_NOW })
      const provider = createLeasePoolAuthProvider(mgr, () =>
        JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }),
      )
      await expect(
        runPool(
          [chunk("c1")],
          cfg(fn, provider, {
            concurrency: 16,
            tokenBudgetDir,
            tokenBudgetWaitMs: 100,
            tokenBudgetPollMs: 10,
          }),
        ),
      ).rejects.toThrow(/patch-gen budget|timed out/i)
      // TEETH: the auth lease acquired before the budget wait MUST be returned by
      // the worker's safety-net finally. Removing that finally leaks the slot ⇒ red.
      for (const s of mgr.snapshot()) {
        expect(s.activeSlots).toBe(0)
        expect(s.activeBoxes).toBe(0)
      }
    } finally {
      await held.release()
    }
  })
})

describe("audit: multi-auth has NO global worker-level backoff lane (pool.ts skips maybeBackoffWorker)", () => {
  test("a 429 on acct-a cools that account but never triggers a worker-level sleep", async () => {
    const { fn } = mockSpawn({ rateLimited: new Set(["c1"]) })
    const mgr = new AuthLeaseManager(TWO, { now: () => FIXED_NOW })
    const provider = createLeasePoolAuthProvider(mgr, () =>
      JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }),
    )
    const slept: number[] = []
    await runPool(
      [chunk("c1"), chunk("c2")],
      // backoffBaseMs is large: if a global lane re-appeared, the rate-limited c1
      // would force a sleep(90s). multi-auth must instead cool acct-a and route c2
      // to acct-b with ZERO worker-level sleep.
      cfg(fn, provider, {
        backoffBaseMs: 90_000,
        sleep: async (ms: number) => void slept.push(ms),
      }),
    )
    expect(slept).toEqual([]) // no global backoff lane fired
    // and the isolation actually happened: acct-a cooled, acct-b did not
    const snap = mgr.snapshot()
    expect(snap.find((s) => s.label === "acct-a")?.cooldownUntil).toBeGreaterThan(FIXED_NOW)
    expect(snap.find((s) => s.label === "acct-b")?.cooldownUntil).toBeUndefined()
  })

  test("a SOLE cooling account makes the next chunk wait (sized off cooldown), then resume", async () => {
    // Closes the blind spot: this exercises acquireAuthLeaseWithWait's REAL wait
    // path. c1 429s the only account; c2 must wait ~cooldown (NOT a global lane)
    // before it can lease. Shared clock so the lease-manager cooldown and the
    // pool's wait math agree; the injected sleep advances the clock past it.
    let clock = FIXED_NOW
    const slept: number[] = []
    const mgr = new AuthLeaseManager(
      [{ label: "solo", authFile: "/s.json", maxParallel: 6, cooldownBaseSec: 10 }],
      {
        now: () => clock,
      },
    )
    const provider = createLeasePoolAuthProvider(mgr, () =>
      JSON.stringify({ access_token: "x", expires_at: "2099-01-01T00:00:00.000Z" }),
    )
    const { fn } = mockSpawn({ rateLimited: new Set(["c1"]) })
    const out = await runPool(
      [chunk("c1"), chunk("c2")],
      cfg(fn, provider, {
        now: () => clock,
        sleep: async (ms: number) => {
          slept.push(ms)
          clock += ms
        },
      }),
    )
    expect(slept.some((ms) => ms >= 10_000)).toBe(true) // waited ~cooldown for the sole account
    expect(out.every((r) => !r.lost)).toBe(true) // c2 resumed after the wait
  })
})
