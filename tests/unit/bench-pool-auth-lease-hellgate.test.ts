/**
 * Hellgate — T-3 pool account-aware scheduler (jun-20 multi-auth fleet).
 *
 * Drives the REAL `runPool` worker loop with a REAL `AuthLeaseManager`-backed
 * provider (over an injected mock spawn ⇒ no box / network). Teeth:
 *  - a chunk acquires its account lease BEFORE the box launch/reuse (ownership),
 *  - leases are released on success AND on requeue ⇒ NO slot leak,
 *  - distinct accounts ship distinct tokens (per-chunk account routing),
 *  - a 429 cools ONLY the rate-limited account, not a single global lane.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthLeaseManager } from "../../src/apps/bench/auth-pool"
import type { AuthPoolEntry } from "../../src/apps/bench/auth-pool"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import { createLeasePoolAuthProvider, type PoolAuthProvider } from "../../src/apps/bench/remote/pool-auth"

const authJsonFor = (label: string): string =>
  JSON.stringify({
    access_token: `ACCESS-${label}`,
    expires_at: "2099-01-01T00:00:00.000Z",
    refresh_token: `REFRESH-${label}-secret`,
    id_token: `IDTOK-${label}-secret`,
    account_id: label,
  })

const BUDGET_DIRS = new Set<string>()
const allocBudgetDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-pool-auth-"))
  BUDGET_DIRS.add(dir)
  return dir
}

/** mock spawn: every box healthy, one resolved verdict per chunk; optional 429
 *  marker per runId. Records every call so we can inspect ship order + tokens. */
const mockSpawn = (opts: { rateLimited?: Set<string>; eventLog?: string[] } = {}) => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
  const routeSsh = (args: string[]): SpawnResult => {
    const cmd = args[args.length - 1] ?? ""
    if (cmd.includes("READY")) return ok("READY")
    if (cmd.includes("run.exit") || cmd.includes("XQ-RUN-EXIT-XQ")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
    if (cmd.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
    if (cmd.includes("rmdir ~/.pool-grade.lock")) return ok("")
    const r = cmd.match(/cat ~\/runs\/([^/]+)\/report\.json/)
    if (r) return ok(JSON.stringify({ resolved_ids: [`x__${r[1]}-1`] }))
    const t = cmd.match(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/)
    if (t && opts.rateLimited?.has(t[1] ?? "")) return ok("[FAIL][generation_error] z__z-1 (turns=2)")
    return ok("")
  }
  const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
    calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
    if (cmd === "curl") return ok("9.9.9.9")
    if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
      const runId =
        (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
      o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
    }
    if (args.includes("run-instances")) opts.eventLog?.push("launch")
    return cmd === "ssh"
      ? routeSsh([...args])
      : args.includes("run-instances")
        ? ok("i-box")
        : args.includes("describe-instances")
          ? ok("1.2.3.4")
          : ok("")
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

const poolCfg = (
  spawn: SpawnFn,
  authProvider: PoolAuthProvider,
  over: Record<string, unknown> = {},
) => ({
  provision: provision(spawn),
  workers: 1,
  preset: "agentless-v2",
  model: "gpt-5.4",
  concurrency: 8,
  tokenBudgetDir: allocBudgetDir(),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  singleBoxGuardDir: join(allocBudgetDir(), "guard"), // isolate the cross-run box guard per test
  // single-auth fallback is present but must NOT be used in pool mode.
  authJsonProvider: () => {
    throw new Error("single authJsonProvider must NOT be called when authProvider is set")
  },
  authProvider,
  ...over,
})

const TWO_ACCOUNTS: readonly AuthPoolEntry[] = [
  { label: "acct-a", authFile: "/a.json", maxParallel: 6, cooldownBaseSec: 30 },
  { label: "acct-b", authFile: "/b.json", maxParallel: 6, cooldownBaseSec: 30 },
]

const tokenShips = (calls: Array<{ cmd: string; input?: string }>): string[] =>
  calls
    .filter((c) => c.cmd === "ssh" && c.input !== undefined && c.input.includes("ACCESS-"))
    .map((c) => c.input ?? "")

describe("T-3 pool account-aware scheduler", () => {
  test("a chunk acquires its account lease BEFORE the box launches", () => {
    // event ordering: provider.acquire pushes "acquire"; run-instances pushes "launch".
    const events: string[] = []
    const { fn } = mockSpawn({ eventLog: events })
    const mgr = new AuthLeaseManager(TWO_ACCOUNTS, { now: () => 1_000_000 })
    const base = createLeasePoolAuthProvider(mgr, (p) =>
      authJsonFor(p === "/a.json" ? "a" : "b"),
    )
    const recording: PoolAuthProvider = {
      acquire: (req) => {
        events.push("acquire")
        return base.acquire(req)
      },
      canEventuallySchedule: () => base.canEventuallySchedule(),
      nextReadyAt: () => base.nextReadyAt(),
    }
    return runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, recording)).then(() => {
      expect(events[0]).toBe("acquire") // lease first…
      expect(events).toContain("launch") // …then the box launched
      expect(events.indexOf("acquire")).toBeLessThan(events.indexOf("launch"))
    })
  })

  test("clean run leaks no slots (every lease released on success)", async () => {
    const { fn } = mockSpawn({})
    const mgr = new AuthLeaseManager(TWO_ACCOUNTS, { now: () => 1_000_000 })
    const provider = createLeasePoolAuthProvider(mgr, (p) => authJsonFor(p === "/a.json" ? "a" : "b"))
    const chunks: PoolChunk[] = [
      { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
      { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      { runId: "c3", datasetPath: "/tmp/c3.jsonl" },
    ]
    const out = await runPool(chunks, poolCfg(fn, provider))
    expect(out.every((r) => !r.lost)).toBe(true)
    for (const s of mgr.snapshot()) {
      expect(s.activeSlots).toBe(0)
      expect(s.activeBoxes).toBe(0)
    }
  })

  test("a requeued (dead-box) chunk still releases its lease — no leak", async () => {
    // c1's box produces no report on the first attempt ⇒ requeue, then succeeds.
    let c1Seen = 0
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      if (cmd === "curl") return ok("9.9.9.9")
      if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
        const runId =
          (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"
        o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
      }
      const a = [...args]
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
        if (r) {
          if (r[1] === "c1") {
            c1Seen += 1
            return ok(c1Seen === 1 ? "" : JSON.stringify({ resolved_ids: ["x__c1-1"] }))
          }
          return ok(JSON.stringify({ resolved_ids: [`x__${r[1]}-1`] }))
        }
        return ok("")
      }
      return ok("")
    }
    const mgr = new AuthLeaseManager([{ label: "solo", authFile: "/s.json", maxParallel: 6, maxBoxes: 1 }], {
      now: () => 1_000_000,
    })
    const provider = createLeasePoolAuthProvider(mgr, () => authJsonFor("solo"))
    const out = await runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, provider, {
      maxChunkRetries: 2,
      reuseWarm: false,
    }))
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.attempts).toBe(2)
    // CRITICAL: the failed-then-retried chunk must not have leaked the account's slot/box.
    expect(mgr.snapshot()[0]?.activeSlots).toBe(0)
    expect(mgr.snapshot()[0]?.activeBoxes).toBe(0)
  })

  test("a 429 cools ONLY the rate-limited account; the other ships next chunk", async () => {
    // 1 worker, 2 accounts, c1 rate-limited. c1 leases acct-a (manifest order),
    // a cools, so c2 routes to acct-b. Teeth: a.cooldownUntil set, b's NOT.
    const { fn, calls } = mockSpawn({ rateLimited: new Set(["c1"]) })
    const mgr = new AuthLeaseManager(TWO_ACCOUNTS, { now: () => 1_000_000 })
    const provider = createLeasePoolAuthProvider(mgr, (p) => authJsonFor(p === "/a.json" ? "a" : "b"))
    await runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      ],
      poolCfg(fn, provider, { backoffBaseMs: 0 }),
    )
    const snap = mgr.snapshot()
    const a = snap.find((s) => s.label === "acct-a")
    const b = snap.find((s) => s.label === "acct-b")
    expect(a?.cooldownUntil).toBeGreaterThan(1_000_000) // acct-a cooling
    expect(a?.consecutiveRateLimited).toBe(1)
    expect(b?.cooldownUntil).toBeUndefined() // acct-b NEVER cooled (no global lane)
    expect(b?.consecutiveRateLimited).toBe(0)
    // Per-chunk routing actually shipped BOTH accounts' tokens.
    const ships = tokenShips(calls).join("\n")
    expect(ships).toContain("ACCESS-a")
    expect(ships).toContain("ACCESS-b")
    // …and never the long-lived secrets.
    expect(ships).not.toContain("REFRESH-a-secret")
    expect(ships).not.toContain("IDTOK-b-secret")
  })

  test("the single-auth provider is NOT invoked in pool mode (authProvider wins)", async () => {
    // poolCfg.authJsonProvider throws if called; a clean run proves it isn't.
    const { fn } = mockSpawn({})
    const mgr = new AuthLeaseManager(TWO_ACCOUNTS, { now: () => 1_000_000 })
    const provider = createLeasePoolAuthProvider(mgr, (p) => authJsonFor(p === "/a.json" ? "a" : "b"))
    const out = await runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, provider))
    expect(out[0]?.lost).toBe(false)
  })

  test("all-disabled auth pools ABORT the run instead of silently marking chunks lost", async () => {
    const { fn } = mockSpawn({})
    const mgr = new AuthLeaseManager(
      [{ label: "disabled", authFile: "/d.json", maxParallel: 6, disabled: true }],
      { now: () => 1_000_000 },
    )
    const provider = createLeasePoolAuthProvider(mgr, () => authJsonFor("disabled"))
    await expect(
      runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, provider)),
    ).rejects.toThrow(/no enabled account|auth pool/i)
  })

  test("auth file read failure releases the acquired lease instead of leaking account capacity", async () => {
    const { fn } = mockSpawn({})
    const mgr = new AuthLeaseManager([{ label: "solo", authFile: "/missing.json", maxParallel: 6, maxBoxes: 1 }], {
      now: () => 1_000_000,
    })
    const provider = createLeasePoolAuthProvider(mgr, () => {
      throw new Error("ENOENT: missing auth file")
    })
    await expect(
      runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, provider)),
    ).rejects.toThrow(/missing auth file/i)
    expect(mgr.snapshot()[0]?.activeSlots).toBe(0)
    expect(mgr.snapshot()[0]?.activeBoxes).toBe(0)
  })

  test("maxBoxes holds until the prior live box terminates; a second launch must not race ahead", async () => {
    const events: string[] = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let launches = 0
    let releaseTerminate!: () => void
    const terminateBlocked = new Promise<void>((resolve) => {
      releaseTerminate = resolve
    })
    let resolveTerminateStarted!: () => void
    const terminateStarted = new Promise<void>((resolve) => {
      resolveTerminateStarted = resolve
    })
    const fn: SpawnFn = async (cmd, args, o) => {
      if (cmd === "curl") return ok("9.9.9.9")
      if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
        const runId =
          (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"
        o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
      }
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("READY")) return ok("READY")
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        const r = c.match(/cat ~\/runs\/([^/]+)\/report\.json/)
        if (r) return ok(JSON.stringify({ resolved_ids: [`x__${r[1]}-1`] }))
        return ok("")
      }
      if (args.includes("run-instances")) {
        launches += 1
        events.push(`launch:${launches}`)
        return ok(`i-box-${launches}`)
      }
      if (args.includes("describe-instances")) return ok("1.2.3.4")
      if (args.includes("terminate-instances")) {
        events.push("terminate:start")
        resolveTerminateStarted()
        await terminateBlocked
        events.push("terminate:done")
        return ok("")
      }
      return ok("")
    }
    const mgr = new AuthLeaseManager([{ label: "solo", authFile: "/s.json", maxParallel: 6, maxBoxes: 1 }], {
      now: () => 1_000_000,
    })
    const provider = createLeasePoolAuthProvider(mgr, () => authJsonFor("solo"))
    const runPromise = runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      ],
      poolCfg(fn, provider, {
        workers: 2,
        allowExtraWorkers: true,
        allowExtraBoxes: true,
        keepWarm: false,
        reuseWarm: false,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        },
      }),
    )
    await Promise.race([
      terminateStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for first terminate: ${events.join(" | ")}`)), 2_000),
      ),
    ])
    await Promise.resolve()
    await Promise.resolve()
    expect(events.filter((e) => e.startsWith("launch:"))).toEqual(["launch:1"])
    releaseTerminate()
    const out = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for run completion: ${events.join(" | ")}`)), 2_000),
      ),
    ])
    expect(out.every((r) => !r.lost)).toBe(true)
  })
})

// cleanup
import { afterAll } from "bun:test"
afterAll(() => {
  for (const d of BUDGET_DIRS) rmSync(d, { recursive: true, force: true })
})
