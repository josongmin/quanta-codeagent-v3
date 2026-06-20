/**
 * RED-first HELLGATE for the persistent full-remote box pool (jun-20 Phase 2).
 *
 * The pool's whole reason to exist is amortising the EXPENSIVE bootstrap over
 * many chunks instead of re-paying it per wave. So the centerpiece teeth are:
 *   - ONE box bootstrap (run-instances) across N chunks — NOT one per chunk
 *     (red-on-injection: if a worker re-provisions per chunk, the count blows up);
 *   - each chunk re-ships a FRESH token AND writes to a runId-SCOPED box dir
 *     (so two chunks never collide on the shared ~/report.json);
 *   - a chunk whose box produced NO verdict (spot reclaim) is RE-QUEUED on a
 *     fresh box, never silently lost;
 *   - the box is ALWAYS terminated when the worker drains.
 *
 * Everything routes through an injected SpawnFn ⇒ no real box / token / network.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { detectRateLimit } from "../../src/apps/bench/remote/box-session"
import { chunkBoxPaths, type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import { acquirePatchGenBudgetLease } from "../../src/apps/bench/remote/token-budget"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "REFRESH-super-secret",
  id_token: "IDTOK-secret",
  account_id: "acct-1",
  expires_at: "2026-06-24T00:00:00Z",
})

const TEMP_DIRS = new Set<string>()

const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}

const DEFAULT_SINGLE_BOX_GUARD_DIR = join(allocTempDir("bench-pool-single-box-root-"), "guard")

const allocTokenBudgetDir = (): string => allocTempDir("bench-pool-budget-")

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const holdBudgetMutationLock = (dir: string): (() => void) => {
  const lockDir = join(dir, ".lock")
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
  )
  return () => {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

interface Recorder {
  fn: SpawnFn
  calls: Array<{ cmd: string; args: string[]; input?: string }>
}

/** Mock spawn. `reportFor(runId, launchIdx)` decides the report-fetch payload for
 *  a given chunk runId on a given box (launch index, 0-based) — return "" to
 *  simulate a dead box (no report). Default: always a 1-resolved report. */
const mockSpawn = (opts: {
  reportFor?: (runId: string, launchIdx: number) => string
  /** runIds whose run.log tail should carry a generation_error (429 signal). */
  rateLimited?: Set<string>
  beforeReportFetch?: () => void
  terminateResult?: SpawnResult
  tokenShipResult?: SpawnResult
  gradeLockReleaseResult?: SpawnResult
}): Recorder => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
  let launchIdx = -1
  const reportFor = opts.reportFor ?? (() => JSON.stringify({ resolved_ids: ["x__y-1"] }))

  const routeSsh = (args: string[]): SpawnResult => {
    const cmd = args[args.length - 1] ?? ""
    if (cmd.includes("READY")) return ok("READY")
    if (cmd.includes("setsid bash -c")) return ok("LAUNCHED")
    if (cmd.includes("run.exit") || cmd.includes("XQ-RUN-EXIT-XQ")) {
      return ok(`0\n==XQ-RUN-EXIT-XQ==\n`)
    }
    // atomic grade lock: a fresh box acquires it (mkdir succeeds ⇒ LOCKED). Match
    // mkdir/rmdir SPECIFICALLY so the idle probe's `test -d …lock` falls through.
    if (cmd.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
    if (cmd.includes("rmdir ~/.pool-grade.lock")) return opts.gradeLockReleaseResult ?? ok("")
    if (cmd.includes("cat > ~/.quanta/auth/chatgpt.json")) return opts.tokenShipResult ?? ok("")
    // detached-run launch/poll: the `run.exit` sentinel carries the bench exit
    // code (RCA jun-20 ssh-resilience). Report DONE (exit 0) immediately so the
    // poll loop terminates in one tick; launch ssh ignores the stdout.
    if (cmd.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
    // report fetch: `cat ~/runs/<runId>/report.json 2>/dev/null`
    const m = cmd.match(/cat ~\/runs\/([^/]+)\/report\.json/)
    if (m) {
      opts.beforeReportFetch?.()
      return ok(reportFor(m[1] ?? "", Math.max(0, launchIdx)))
    }
    // run.log tail: inject a 429 marker for rate-limited runIds.
    const t = cmd.match(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/)
    if (t && opts.rateLimited?.has(t[1] ?? ""))
      return ok("[FAIL][generation_error] z__z-1 (turns=2)")
    // preds / closure / trajectory / mkdir / token ship / bench run
    return ok("")
  }
  const route = (cmd: string, args: string[]): SpawnResult => {
    if (args.includes("describe-security-groups")) return ok("sg-abc")
    if (args.includes("run-instances")) {
      launchIdx += 1
      return ok(`i-box${launchIdx}`)
    }
    if (args.includes("describe-instances")) return ok("1.2.3.4")
    if (args.includes("wait")) return ok("")
    if (args.includes("terminate-instances")) return opts.terminateResult ?? ok("")
    if (cmd === "ssh") return routeSsh(args)
    return ok("") // scp / rsync / other aws
  }
  const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
    calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
    if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
      const runId =
        (args[args.length - 1] ?? "").match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
      o?.onData?.(`[info] ${runId} started\n`)
      o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
    }
    return route(cmd, [...args])
  }
  return { fn, calls }
}

const baseProvision = (spawn: SpawnFn) => ({
  repoDir: "/tmp/repo",
  authJson: FULL_AUTH,
  datasetPath: "/tmp/unused.jsonl", // pool uses per-chunk datasets
  spawn,
  sleep: async () => {},
  maxReadyPolls: 2,
})

const poolCfg = (spawn: SpawnFn, over: Record<string, unknown> = {}) => ({
  provision: baseProvision(spawn),
  workers: 1,
  preset: "agentless-v2",
  model: "gpt-5.4",
  concurrency: 8,
  singleBoxGuardDir: DEFAULT_SINGLE_BOX_GUARD_DIR,
  tokenBudgetDir: allocTokenBudgetDir(),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  authJsonProvider: () => FULL_AUTH,
  ...over,
})

const CHUNKS: PoolChunk[] = [
  { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
  { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
  { runId: "c3", datasetPath: "/tmp/c3.jsonl" },
]

const count = (calls: Recorder["calls"], pred: (c: Recorder["calls"][number]) => boolean): number =>
  calls.filter(pred).length

const waitForCondition = async (
  pred: () => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 250
  const pollMs = opts.pollMs ?? 5
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs)
    })
  }
  return pred()
}

describe("runPool — persistent box, amortised bootstrap", () => {
  test("an empty chunk set returns immediately without spawn, guards, or worker opt-in", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      throw new Error("empty pool must not touch remote control plane")
    }
    await expect(runPool([], poolCfg(fn, { workers: 2 }))).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  test("bootstraps ONE box across N chunks (not one per chunk)", async () => {
    const { fn, calls } = mockSpawn({})
    const out = await runPool(CHUNKS, poolCfg(fn))
    // TEETH: 3 chunks, 1 worker, all boxes healthy ⇒ EXACTLY ONE run-instances.
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
    // Warm default: a healthy box is LEFT ALIVE at clean drain (reused next run /
    // reaped by TTL), so NO terminate.
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
    expect(out.every((r) => !r.lost)).toBe(true)
    expect(out.map((r) => r.chunk.runId)).toEqual(["c1", "c2", "c3"]) // input order preserved
  })

  test("each chunk re-ships a token AND writes to a runId-scoped box dir", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn))
    // Token shipped once PER CHUNK (fresh access_token each time), never the
    // long-lived secret.
    const tokenShips = calls.filter(
      (c) => c.cmd === "ssh" && c.input !== undefined && c.input.includes("ACCESS-xyz"),
    )
    expect(tokenShips.length).toBe(3) // one per chunk
    const shippedBlob = calls.map((c) => c.input ?? "").join("\n")
    expect(shippedBlob).not.toContain("REFRESH-super-secret")
    expect(shippedBlob).not.toContain("IDTOK-secret")
    // runId-scoped report paths: each chunk's bench-run targets its OWN dir.
    const benchRuns = calls.filter(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")),
    )
    expect(benchRuns.length).toBe(3)
    expect(benchRuns.some((c) => c.args.join(" ").includes("~/runs/c1/report.json"))).toBe(true)
    expect(benchRuns.some((c) => c.args.join(" ").includes("~/runs/c2/report.json"))).toBe(true)
    expect(benchRuns.some((c) => c.args.join(" ").includes("~/runs/c3/report.json"))).toBe(true)
  })

  test("writes box-status snapshots so operators can see the current chunk + phase", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn))
    const statusWriteCmds = calls
      .filter((c) => c.cmd === "ssh" && c.args.join(" ").includes("bench-box-status.json"))
      .map((c) => c.args.join(" "))
    const statusWrites = calls
      .filter(
        (c) =>
          c.cmd === "ssh" &&
          c.input !== undefined &&
          c.args.join(" ").includes("bench-box-status.json"),
      )
      .map((c) => c.input ?? "")
    expect(
      statusWrites.some(
        (s) =>
          s.includes('"phase":"running"') &&
          s.includes('"runId":"c1"') &&
          s.includes('"runLogPath":"~/runs/c1/run.log"') &&
          s.includes('"observeDir":"~/runs/c1/observe"'),
      ),
    ).toBe(true)
    expect(
      statusWrites.some(
        (s) =>
          s.includes('"phase":"fetching"') &&
          s.includes('"runId":"c1"') &&
          s.includes('"predictionsPath":"~/runs/c1/preds.jsonl"'),
      ),
    ).toBe(true)
    expect(
      statusWrites.some(
        (s) =>
          s.includes('"phase":"idle"') &&
          s.includes('"runId":"c3"') &&
          s.includes('"reportPath":"~/runs/c3/report.json"') &&
          s.includes('"resolvedCount":1'),
      ),
    ).toBe(true)
    expect(
      statusWriteCmds.every(
        (cmd) =>
          cmd.includes("cat > ~/.quanta/bench-box-status.json.tmp") &&
          cmd.includes("mv ~/.quanta/bench-box-status.json.tmp ~/.quanta/bench-box-status.json"),
      ),
    ).toBe(true)
  })

  test("global patch-gen budget caps concurrently active workers against the remaining tokens", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    const held = await acquirePatchGenBudgetLease({
      label: "other-run",
      requestedUnits: 4,
      dir: tokenBudgetDir,
      waitMs: 1_000,
      pollMs: 10,
    })
    try {
      const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
      const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
      let launchIdx = -1
      let launchedBenchRuns = 0
      let releaseRunExit: (() => void) | undefined
      const runExitGate = new Promise<void>((resolve) => {
        releaseRunExit = resolve
      })
      const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
        calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
        if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
          launchedBenchRuns += 1
          if (launchedBenchRuns >= 2) releaseRunExit?.()
        }
        const a = [...args]
        if (a.includes("describe-security-groups")) return ok("sg-abc")
        if (a.includes("run-instances")) {
          launchIdx += 1
          return ok(`i-box${launchIdx}`)
        }
        if (a.includes("describe-instances")) return ok("1.2.3.4")
        if (a.includes("wait")) return ok("")
        if (a.includes("terminate-instances")) return ok("")
        if (cmd === "ssh") {
          const remote = a[a.length - 1] ?? ""
          if (remote.includes("READY")) return ok("READY")
          if (remote.includes("setsid bash -c")) return ok("LAUNCHED")
          if (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ")) {
            if (launchedBenchRuns < 2) await runExitGate
            return ok("0\n==XQ-RUN-EXIT-XQ==\n")
          }
          if (remote.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
          if (remote.includes("rmdir ~/.pool-grade.lock")) return ok("")
          const report = remote.match(/cat ~\/runs\/([^/]+)\/report\.json/)
          if (report) return ok(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
          return ok("")
        }
        return ok("")
      }
      await runPool(
        CHUNKS.slice(0, 2),
        poolCfg(fn, {
          workers: 2,
          allowExtraWorkers: true,
          allowExtraBoxes: true,
          concurrency: 8,
          tokenBudgetDir,
        }),
      )
      const launchedConcurrency = calls
        .filter((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")))
        .map((c) => Number(c.args.join(" ").match(/QUANTA_BENCH_CONCURRENCY=(\d+)/)?.[1] ?? "0"))
        .sort((a, b) => a - b)
      expect(launchedConcurrency).toEqual([4, 8])
      const benchRuns = calls.filter(
        (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")),
      )
      expect(benchRuns.length).toBe(2)
    } finally {
      await held.release()
    }
  })

  test("waits on the chunk patch-gen budget BEFORE provisioning a box", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    const held = await acquirePatchGenBudgetLease({
      label: "block-pool-budget",
      requestedUnits: 16,
      minUnits: 16,
      dir: tokenBudgetDir,
      waitMs: 1_000,
      pollMs: 10,
    })
    const { fn, calls } = mockSpawn({})
    const runPromise = runPool(
      [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
      poolCfg(fn, {
        concurrency: 16,
        tokenBudgetDir,
        tokenBudgetWaitMs: 1_000,
        tokenBudgetPollMs: 10,
      }),
    )
    let failure: unknown
    try {
      expect(
        await waitForCondition(() => calls.some((c) => c.args.includes("run-instances")), {
          timeoutMs: 200,
        }),
      ).toBe(false)
      expect(
        calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run"))),
      ).toBe(false)
    } catch (err) {
      failure = err
    } finally {
      await held.release()
    }
    await runPromise
    if (failure !== undefined) throw failure
    expect(calls.some((c) => c.args.includes("run-instances"))).toBe(true)
    expect(calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")))).toBe(
      true,
    )
  })

  test("releases chunk-scoped budget BEFORE 429 backoff sleep", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    const { fn } = mockSpawn({ rateLimited: new Set(["c1"]) })
    let probeUnits = 0
    await runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      ],
      poolCfg(fn, {
        concurrency: 16,
        tokenBudgetDir,
        backoffBaseMs: 50,
        sleep: async () => {
          const probe = await acquirePatchGenBudgetLease({
            label: "sleep-probe",
            requestedUnits: 16,
            minUnits: 16,
            dir: tokenBudgetDir,
            waitMs: 100,
            pollMs: 10,
          })
          probeUnits = probe.units
          await probe.release()
        },
      }),
    )
    expect(probeUnits).toBe(16)
  })

  test("a chunk patch-gen budget release failure ABORTS the run instead of silently succeeding", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    let releaseLock: (() => void) | undefined
    try {
      const { fn } = mockSpawn({
        beforeReportFetch: () => {
          releaseLock ??= holdBudgetMutationLock(tokenBudgetDir)
        },
      })
      await expect(
        runPool(
          [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
          poolCfg(fn, {
            concurrency: 16,
            tokenBudgetDir,
            tokenBudgetWaitMs: 100,
            tokenBudgetPollMs: 10,
          }),
        ),
      ).rejects.toThrow(/global patch-gen budget lock|timed out waiting/i)
    } finally {
      releaseLock?.()
    }
  })

  test("a chunk budget-release failure preserves the earlier primary abort", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    let releaseLock: (() => void) | undefined
    const { fn } = mockSpawn({})
    const authProvider = {
      acquire: () => ({
        accountLabel: "acct-a",
        readAuthJson: () => {
          releaseLock ??= holdBudgetMutationLock(tokenBudgetDir)
          throw new Error("auth boom")
        },
        release: () => {},
      }),
      canEventuallySchedule: () => true,
      nextReadyAt: () => undefined,
    }
    try {
      await expect(
        runPool(
          [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
          poolCfg(fn, {
            concurrency: 16,
            tokenBudgetDir,
            tokenBudgetWaitMs: 100,
            tokenBudgetPollMs: 10,
            authProvider,
          }),
        ),
      ).rejects.toThrow(/auth boom.*timed out waiting|timed out waiting.*auth boom/i)
    } finally {
      releaseLock?.()
    }
  })

  test("a patch-gen budget timeout ABORTS the run instead of silently marking the chunk lost", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    const held = await acquirePatchGenBudgetLease({
      label: "block-pool-budget",
      requestedUnits: 16,
      minUnits: 16,
      dir: tokenBudgetDir,
      waitMs: 1_000,
      pollMs: 10,
    })
    try {
      const { fn } = mockSpawn({})
      await expect(
        runPool(
          [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
          poolCfg(fn, {
            concurrency: 16,
            tokenBudgetDir,
            tokenBudgetWaitMs: 100,
            tokenBudgetPollMs: 10,
          }),
        ),
      ).rejects.toThrow(/patch-gen budget|timed out waiting/i)
    } finally {
      await held.release()
    }
  })

  test("a final cleanup termination failure preserves BOTH the primary abort and cleanup error", async () => {
    const { fn } = mockSpawn({
      terminateResult: { code: 254, stdout: "", stderr: "terminate denied" },
    })
    let authReads = 0
    await expect(
      runPool(
        [
          { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
          { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
        ],
        poolCfg(fn, {
          keepWarm: false,
          reuseWarm: false,
          authJsonProvider: () => {
            authReads += 1
            if (authReads === 2) throw new Error("auth boom")
            return FULL_AUTH
          },
        }),
      ),
    ).rejects.toThrow(/auth boom.*terminate denied|terminate denied.*auth boom/i)
  })

  test("a top-level single-box guard release failure preserves the primary abort", async () => {
    const singleBoxRoot = allocTempDir("bench-pool-guard-release-root-")
    const singleBoxGuardDir = join(singleBoxRoot, "guard")
    const { fn } = mockSpawn({})
    try {
      await expect(
        runPool(
          [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
          poolCfg(fn, {
            singleBoxGuardDir,
            authJsonProvider: () => {
              chmodSync(singleBoxRoot, 0o555)
              throw new Error("auth boom")
            },
          }),
        ),
      ).rejects.toThrow(
        /auth boom.*permission|permission.*auth boom|auth boom.*EACCES|EACCES.*auth boom/i,
      )
    } finally {
      chmodSync(singleBoxRoot, 0o755)
    }
  })

  test("concurrent single-box pool runs FAIL-CLOSED instead of launching a second box", async () => {
    const tokenBudgetDir = allocTokenBudgetDir()
    const singleBoxGuardDir = join(allocTempDir("bench-pool-single-box-root-"), "guard")
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    let launched = 0
    let releaseFirstRun: (() => void) | undefined
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    let firstBenchStarted = false
    const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
      const a = [...args]
      calls.push({ cmd, args: a, ...(o?.input !== undefined ? { input: o.input } : {}) })
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) {
        launched += 1
        return ok(`i-box${launched - 1}`)
      }
      if (a.includes("wait")) return ok("")
      if (a.includes("--filters") && a.includes("Reservations[].Instances[].InstanceId"))
        return ok("")
      if (a.includes("--filters") && a.includes("InstanceId,PublicIpAddress")) return ok("")
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const remote = a[a.length - 1] ?? ""
        if (remote.includes("READY")) return ok("READY")
        if (remote.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (remote.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (remote.includes("setsid bash -c") && remote.includes("cli.ts run")) {
          firstBenchStarted = true
          return ok("LAUNCHED")
        }
        if (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ")) {
          if (firstBenchStarted && launched === 1) await firstRunDone
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(remote))
          return ok(JSON.stringify({ resolved_ids: ["x__y-1"] }))
        return ok("")
      }
      return ok("")
    }

    const first = runPool(
      [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
      poolCfg(fn, {
        tokenBudgetDir,
        singleBoxGuardDir,
      }),
    )
    expect(
      await waitForCondition(
        () => firstBenchStarted && calls.some((c) => c.args.includes("run-instances")),
        { timeoutMs: 250 },
      ),
    ).toBe(true)

    await expect(
      runPool(
        [{ runId: "c2", datasetPath: "/tmp/c2.jsonl" }],
        poolCfg(fn, {
          tokenBudgetDir,
          singleBoxGuardDir,
        }),
      ),
    ).rejects.toThrow(/single-box|owner/i)

    releaseFirstRun?.()
    await first
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
  })

  test("RCA jun-20: the long bench-run ssh carries keepalive (no-keepalive HANG regression)", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn))
    // The long foreground `ssh '… cli.ts run … | tee run.log'` MUST keep the idle
    // TCP alive through patch-gen silence — with NO probes ssh hangs on a NAT-
    // dropped socket forever and the box is orphaned (observed on 2/2 long runs).
    // Probes every 30s + 600s grace (30×20) tolerate a busy-but-alive box.
    const benchRuns = calls.filter(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")),
    )
    expect(benchRuns.length).toBeGreaterThan(0)
    for (const c of benchRuns) {
      expect(c.args).toContain("ServerAliveInterval=30")
      expect(c.args).toContain("ServerAliveCountMax=20")
    }
  })

  test("a dead box (no verdict) RE-QUEUES the chunk on a FRESH box", async () => {
    // c2 produces NO report on the FIRST box (launchIdx 0) → dead box. The pool
    // must terminate that box, provision a fresh one, and retry c2 (where it
    // succeeds). Net: 2 boxes, and c2 not lost.
    let c2Seen = 0
    const { fn, calls } = mockSpawn({
      reportFor: (runId) => {
        if (runId === "c2") {
          c2Seen += 1
          return c2Seen === 1 ? "" : JSON.stringify({ resolved_ids: ["x__y-2"] })
        }
        return JSON.stringify({ resolved_ids: [`x__y-${runId}`] })
      },
    })
    const out = await runPool(CHUNKS, poolCfg(fn, { maxChunkRetries: 2 }))
    // TEETH: the requeue forced a SECOND box (bootstrap re-paid only for the loss).
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(2)
    const c2 = out.find((r) => r.chunk.runId === "c2")
    expect(c2?.lost).toBe(false)
    expect(c2?.attempts).toBe(2) // first box died, second succeeded
    expect(c2?.result.resolved).toContain("x__y-2")
    // The DEAD box was terminated (1); the survivor is left WARM at drain.
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(1)
  })

  test("a reprovision failure ABORTS the run instead of silently surfacing a lost chunk", async () => {
    let launches = 0
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) {
        launches += 1
        return launches === 1
          ? ok("i-box0")
          : {
              code: 254,
              stdout: "",
              stderr: "An error occurred (InsufficientInstanceCapacity)",
            }
      }
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const remote = a[a.length - 1] ?? ""
        if (remote.includes("READY")) return ok("READY")
        if (remote.includes("setsid bash -c")) return ok("LAUNCHED")
        if (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"))
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (remote.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (remote.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(remote)) return ok("")
        o?.onData?.("[FAIL][generation_error] c1__inst-1 (turns=2)\n")
        return ok("")
      }
      return ok("")
    }

    await expect(
      runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, { maxChunkRetries: 1 })),
    ).rejects.toThrow(/InsufficientInstanceCapacity|provision failed|no spot capacity/i)
  })

  test("a chunk that never produces a verdict is surfaced as lost, not silently 0", async () => {
    const { fn } = mockSpawn({
      reportFor: (runId) => (runId === "c2" ? "" : JSON.stringify({ resolved_ids: ["ok"] })),
    })
    const out = await runPool(CHUNKS, poolCfg(fn, { maxChunkRetries: 1 }))
    const c2 = out.find((r) => r.chunk.runId === "c2")
    expect(c2?.lost).toBe(true)
    expect(c2?.attempts).toBe(2) // initial + 1 retry, both empty
    // the OTHER chunks still resolved.
    expect(out.filter((r) => r.lost).length).toBe(1)
  })

  test("PROACTIVE rotation retires a TTL-aged box WITHOUT counting a chunk failure", async () => {
    const { fn, calls } = mockSpawn({})
    // Clock advances hugely on each read ⇒ every rotation check sees the box as
    // past its wall budget ⇒ the worker rotates before chunks 2 and 3.
    let t = 0
    const out = await runPool(
      CHUNKS,
      poolCfg(fn, { maxBoxWallMs: 1, now: () => (t += 1_000_000_000) }),
    )
    // TEETH: rotation provisioned EXTRA boxes (more than the single happy-path box)…
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBeGreaterThan(1)
    // …but every chunk still graded, and rotation is NOT a retry (attempts stay 1).
    expect(out.every((r) => !r.lost)).toBe(true)
    expect(out.every((r) => r.attempts === 1)).toBe(true)
  })

  test("a rotation termination failure ABORTS before provisioning a replacement box", async () => {
    const { fn, calls } = mockSpawn({
      terminateResult: { code: 254, stdout: "", stderr: "terminate denied" },
    })
    let t = 0
    await expect(
      runPool(
        CHUNKS,
        poolCfg(fn, { reuseWarm: false, maxBoxWallMs: 1, now: () => (t += 1_000_000_000) }),
      ),
    ).rejects.toThrow(/terminate denied|terminate/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
  })

  test("REUSES a warm idle box (no launch) instead of provisioning", async () => {
    // findIdleBox's tag-filtered describe returns a running box; its bootstrap
    // probe says OK and its idle probe says IDLE ⇒ the pool ATTACHES, never
    // launching. attachBox's --instance-ids describe resolves the ip.
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string) => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances")) {
        // findIdleBox (tag filter) ⇒ id+ip row; attachBox (--instance-ids) ⇒ ip.
        return a.includes("--filters") ? ok("i-warmbox\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n") // detached-run sentinel
        if (c.includes("echo OK")) return ok("OK") // bootstrap probe
        // idle probe (uniquely contains `pgrep`) — checked BEFORE the lock matchers
        // because the stale-lock-reclaim probe also contains `rmdir …lock`.
        if (c.includes("pgrep")) return ok("IDLE") // warm box is idle
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn))
    // TEETH: a warm box was reused ⇒ ZERO launches.
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    // ...the chunk still graded on the attached box.
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toContain("w__w-1")
    // ...and a reused box is NEVER terminated (left warm).
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("an idle live box still blocks a fresh launch when reuseWarm=false unless explicitly opted in", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string) => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-warmbox\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) return ok("IDLE")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    await expect(
      runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn, { reuseWarm: false })),
    ).rejects.toThrow(/refusing to launch a fresh box|refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("keepWarm:false terminates the box on clean drain", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn, { keepWarm: false, reuseWarm: false }))
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(1)
  })

  test("a clean-drain termination failure ABORTS the run instead of silently succeeding", async () => {
    const { fn } = mockSpawn({
      terminateResult: { code: 254, stdout: "", stderr: "terminate denied" },
    })
    await expect(
      runPool(
        [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
        poolCfg(fn, { keepWarm: false, reuseWarm: false }),
      ),
    ).rejects.toThrow(/terminate denied|terminate/i)
  })

  test("a grade-lock release failure ABORTS instead of being retried as a dead box", async () => {
    const { fn } = mockSpawn({
      gradeLockReleaseResult: { code: 1, stdout: "", stderr: "lock release denied" },
    })
    await expect(
      runPool(
        [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
        poolCfg(fn, { maxChunkRetries: 2, reuseWarm: false }),
      ),
    ).rejects.toThrow(/GRADE_LOCK_RELEASE_FAILED|lock release denied/i)
  })

  test("a cleanup termination failure after a chunk throw ABORTS instead of silently resolving lost", async () => {
    const { fn } = mockSpawn({
      tokenShipResult: { code: 1, stdout: "", stderr: "ship boom" },
      terminateResult: { code: 254, stdout: "", stderr: "terminate denied" },
    })
    await expect(
      runPool(
        [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
        poolCfg(fn, { maxChunkRetries: 1, reuseWarm: false }),
      ),
    ).rejects.toThrow(
      /failed to terminate box after chunk c1 threw .*ship boom.*terminate denied|failed to terminate box after chunk c1 threw .*terminate denied.*ship boom/i,
    )
  })

  test("429 BACKOFF: a rate-limited chunk pauses before the next, exponentially; clean resets", async () => {
    // c1 + c2 rate-limited (consecutive ⇒ base, then 2×base); c3 clean.
    const { fn } = mockSpawn({ rateLimited: new Set(["c1", "c2"]) })
    const slept: number[] = []
    await runPool(
      CHUNKS,
      poolCfg(fn, { backoffBaseMs: 1000, sleep: async (ms: number) => void slept.push(ms) }),
    )
    // TEETH: two backoffs (after c1, after c2), exponential; none after the clean c3.
    expect(slept).toEqual([1000, 2000])
  })

  test("429 BACKOFF: no rate-limit ⇒ never sleeps; backoffBaseMs=0 disables", async () => {
    const noLimit = mockSpawn({})
    const sleptA: number[] = []
    await runPool(
      CHUNKS,
      poolCfg(noLimit.fn, {
        backoffBaseMs: 1000,
        sleep: async (ms: number) => void sleptA.push(ms),
      }),
    )
    expect(sleptA).toEqual([]) // clean run never backs off

    const limited = mockSpawn({ rateLimited: new Set(["c1", "c2", "c3"]) })
    const sleptB: number[] = []
    await runPool(
      CHUNKS,
      poolCfg(limited.fn, { backoffBaseMs: 0, sleep: async (ms: number) => void sleptB.push(ms) }),
    )
    expect(sleptB).toEqual([]) // disabled
  })

  test("429 BACKOFF: a CLEAN chunk resets the exponential ladder (d1 rl / d2 clean / d3 rl)", async () => {
    // Pattern proves the RESET specifically: d1 rate-limited ⇒ base; d2 clean ⇒
    // ladder resets; d3 rate-limited ⇒ base AGAIN (not 2×base); d4 present so d3's
    // backoff fires (queue not empty). Without the reset, d3 would back off 2×base.
    const four = [
      { runId: "d1", datasetPath: "/tmp/d1.jsonl" },
      { runId: "d2", datasetPath: "/tmp/d2.jsonl" },
      { runId: "d3", datasetPath: "/tmp/d3.jsonl" },
      { runId: "d4", datasetPath: "/tmp/d4.jsonl" },
    ]
    const { fn } = mockSpawn({ rateLimited: new Set(["d1", "d3"]) })
    const slept: number[] = []
    await runPool(
      four,
      poolCfg(fn, { backoffBaseMs: 1000, sleep: async (ms: number) => void slept.push(ms) }),
    )
    // d1→base, (d2 clean: no sleep + reset), d3→base again (RESET teeth), d4 clean.
    expect(slept).toEqual([1000, 1000])
  })

  test("429 BACKOFF: a throttled-but-NO-VERDICT chunk backs off on the REQUEUE attempt too", async () => {
    // THE bug H3 guards. Throttling yields an empty report ⇒ the chunk is REQUEUED,
    // and the requeue branch writes NOTHING to `out`. Reading the backoff signal
    // from `out.get(runId)` (the OLD code) therefore SKIPS the backoff on the
    // requeue attempt and keeps hammering the throttled login. Reading it from THIS
    // attempt's result (the fix) backs off every throttled attempt.
    //   c1: rate-limited + NO verdict (requeues once, then lost); c2: clean+valid.
    //   maxChunkRetries:1 ⇒ c1 gets TWO attempts, BOTH throttled.
    // FIX  ⇒ backs off after BOTH c1 attempts ⇒ slept == [base, 2×base].
    // OLD  ⇒ requeue attempt records no `out` ⇒ no backoff ⇒ slept == [base] (RED).
    const { fn } = mockSpawn({
      reportFor: (runId) => (runId === "c1" ? "" : JSON.stringify({ resolved_ids: ["ok"] })),
      rateLimited: new Set(["c1"]),
    })
    const slept: number[] = []
    await runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      ],
      poolCfg(fn, {
        backoffBaseMs: 1000,
        maxChunkRetries: 1,
        reuseWarm: false, // dead-box requeue launches fresh; keep it deterministic
        sleep: async (ms: number) => void slept.push(ms),
      }),
    )
    expect(slept).toEqual([1000, 2000]) // both throttled c1 attempts backed off
  })

  test("detectRateLimit fires on the canonical markers, NOT on a bare 429 in an id/turns", () => {
    expect(detectRateLimit("[FAIL][generation_error] x (turns=2)")).toBe(true)
    expect(detectRateLimit("hit too many requests")).toBe(true)
    expect(detectRateLimit("HTTP 429 throttled")).toBe(true)
    expect(detectRateLimit("[PASS] x (turns=5)\nInstances completed: 1")).toBe(false)
    expect(detectRateLimit("")).toBe(false)
    // RED-on-injection: a bare 429 in an instance id / turn count must NOT trip a
    // backoff (the false-positive the loose `\b429\b` caused).
    expect(detectRateLimit("[PASS] psf__requests-429 (turns=429)")).toBe(false)
  })

  test("a BUSY box (lock held) is dropped WITHOUT terminating it (POOL_BUSY ≠ dead box)", async () => {
    // The lock mkdir always returns BUSY ⇒ gradeChunkOnBox throws POOL_BUSY. The
    // pool must DROP the box WITHOUT terminating (it could be another run's box).
    // TEETH design:
    //   - reuseWarm:false forces a real LAUNCH, so the box's terminate is a REAL
    //     aws `terminate-instances` (an ATTACHED box's terminate is a no-op, which
    //     would make the "not terminated" assertion vacuous — the prior bug).
    //   - the report fetch returns a VALID resolved report, so if the lock check
    //     were bypassed the chunk would RESOLVE (lost:false) — `lost===true` then
    //     proves the POOL_BUSY path was actually taken, not a no-verdict masquerade.
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) return ok("i-fresh")
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-busy") : ok("1.2.3.4")
      }
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n") // detached-run sentinel
        if (c.includes("READY")) return ok("READY")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("BUSY") // lock held by another run
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        // a VALID report — only reachable if the lock check is (wrongly) bypassed.
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, { maxChunkRetries: 1, reuseWarm: false, allowExtraBoxes: true }),
    )
    // CRITICAL TEETH: a box hitting POOL_BUSY is NEVER terminated (don't kill the
    // other run). If the POOL_BUSY branch wrongly called terminate, this is >0.
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
    // It DID launch (and re-launch on requeue) — proving the box was dropped+replaced.
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBeGreaterThan(0)
    // lost:true proves the BUSY path ran — a bypassed lock would RESOLVE (lost:false).
    expect(out[0]?.lost).toBe(true)
  })

  test("a mid-run POOL_BUSY box FAIL-CLOSED unless explicit extra-box opt-in is set", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let launched = false
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) {
        launched = true
        return ok("i-fresh")
      }
      if (a.includes("describe-instances")) {
        if (a.includes("--filters")) {
          return a.some((part) => part.includes("Reservations[].Instances[].InstanceId"))
            ? ok(launched ? "i-busy" : "")
            : ok("")
        }
        return ok("1.2.3.4")
      }
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("READY")) return ok("READY")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("BUSY")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    await expect(
      runPool(
        [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
        poolCfg(fn, { maxChunkRetries: 1, reuseWarm: false }),
      ),
    ).rejects.toThrow(/refusing to launch a fresh box|refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a mid-run POOL_BUSY warm-box race ABORTS by default instead of auto-launching another box", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let pgrepCount = 0
    let lockCount = 0
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) {
          pgrepCount += 1
          return ok(pgrepCount <= 2 ? "IDLE" : "BUSY")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) {
          lockCount += 1
          return ok(lockCount === 1 ? "BUSY" : "LOCKED")
        }
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    await expect(
      runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn, { maxChunkRetries: 1 })),
    ).rejects.toThrow(/refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a mid-run POOL_BUSY warm-box race waits, then REUSES the box once it goes idle", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const slept: number[] = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let pgrepCount = 0
    let lockCount = 0
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) {
          pgrepCount += 1
          if (pgrepCount <= 2) return ok("IDLE")
          if (pgrepCount <= 4) return ok("BUSY")
          return ok("IDLE")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) {
          lockCount += 1
          return ok(lockCount === 1 ? "BUSY" : "LOCKED")
        }
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, {
        maxChunkRetries: 1,
        waitForIdle: true,
        waitForIdlePollMs: 1234,
        sleep: async (ms: number) => void slept.push(ms),
      }),
    )
    expect(slept).toEqual([1234])
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.attempts).toBe(2)
    expect(out[0]?.result.resolved).toContain("w__w-1")
  })

  test("a lock-probe ssh failure on an OWNED box is a hard failure, not BUSY (terminate it)", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) return ok("i-owned")
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n") // detached-run sentinel
        if (c.includes("READY")) return ok("READY")
        if (c.includes("mkdir ~/.pool-grade.lock"))
          return { code: 255, stdout: "", stderr: "ssh: connect timeout" }
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, { maxChunkRetries: 0, reuseWarm: false }),
    )
    // TEETH: a lock-probe transport failure means the OWNED box is bad and MUST
    // be terminated; classifying it as BUSY would leak the box here.
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(1)
    expect(out[0]?.lost).toBe(true)
  })

  test("duplicate chunk runIds are rejected (never silently merge results)", async () => {
    const { fn } = mockSpawn({})
    await expect(
      runPool(
        [
          { runId: "dup", datasetPath: "/tmp/a.jsonl" },
          { runId: "dup", datasetPath: "/tmp/b.jsonl" },
        ],
        poolCfg(fn),
      ),
    ).rejects.toThrow(/duplicate chunk runId/i)
  })

  test("workers > 1 is fail-closed unless the caller opts in explicitly", async () => {
    const { fn, calls } = mockSpawn({})
    await expect(runPool(CHUNKS, poolCfg(fn, { workers: 2 }))).rejects.toThrow(
      /explicit opt-in|allowExtraWorkers/i,
    )
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("workers > 1 still fail-closes when extra workers are allowed but extra boxes are not", async () => {
    const { fn, calls } = mockSpawn({})
    await expect(
      runPool(CHUNKS, poolCfg(fn, { workers: 2, allowExtraWorkers: true })),
    ).rejects.toThrow(/allowExtraBoxes|extra-box opt-in/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("with explicit multi-worker opt-in, the pool waits for sibling workers to settle before surfacing the first failure", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let authReads = 0
    let releaseSecondRun: (() => void) | undefined
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve
    })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances"))
        return ok(`i-${calls.filter((c) => c.args.includes("run-instances")).length}`)
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("READY")) return ok("READY")
        if (c.includes("setsid bash -c")) return ok("LAUNCHED")
        if (c.includes("run.exit") || c.includes("XQ-RUN-EXIT-XQ")) {
          if (c.includes("~/runs/c2/")) await secondRunGate
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        const report = c.match(/cat ~\/runs\/([^/]+)\/report\.json/)
        if (report) return ok(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
        return ok("")
      }
      return ok("")
    }
    const runPromise = runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
      ],
      poolCfg(fn, {
        workers: 2,
        allowExtraWorkers: true,
        allowExtraBoxes: true,
        keepWarm: false,
        reuseWarm: false,
        authJsonProvider: () => {
          authReads += 1
          if (authReads === 1) throw new Error("auth boom")
          return FULL_AUTH
        },
      }),
    )
    const early = await Promise.race([
      runPromise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("pending"), 100)
      }),
    ])
    expect(early).toBe("pending")
    releaseSecondRun?.()
    await expect(runPromise).rejects.toThrow(/auth boom/i)
  })

  test("after a fatal worker abort, sibling workers do NOT start fresh chunks from the shared queue", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let authReads = 0
    let releaseC2Run: (() => void) | undefined
    const c2RunGate = new Promise<void>((resolve) => {
      releaseC2Run = resolve
    })
    let releaseC3Run: (() => void) | undefined
    const c3RunGate = new Promise<void>((resolve) => {
      releaseC3Run = resolve
    })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances"))
        return ok(`i-${calls.filter((c) => c.args.includes("run-instances")).length}`)
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("READY")) return ok("READY")
        if (c.includes("setsid bash -c")) return ok("LAUNCHED")
        if (c.includes("run.exit") || c.includes("XQ-RUN-EXIT-XQ")) {
          if (c.includes("~/runs/c2/")) await c2RunGate
          if (c.includes("~/runs/c3/")) await c3RunGate
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        const report = c.match(/cat ~\/runs\/([^/]+)\/report\.json/)
        if (report) return ok(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
        return ok("")
      }
      return ok("")
    }
    const runPromise = runPool(
      [
        { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
        { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
        { runId: "c3", datasetPath: "/tmp/c3.jsonl" },
      ],
      poolCfg(fn, {
        workers: 2,
        allowExtraWorkers: true,
        allowExtraBoxes: true,
        keepWarm: false,
        reuseWarm: false,
        authJsonProvider: () => {
          authReads += 1
          if (authReads === 1) throw new Error("auth boom")
          return FULL_AUTH
        },
      }),
    )
    try {
      releaseC2Run?.()
      const afterC2 = await Promise.race([
        runPromise.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("pending"), 100)
        }),
      ])
      expect(afterC2).toBe("rejected")
      expect(
        calls.some(
          (c) =>
            c.cmd === "ssh" &&
            c.args.some((arg) => arg.includes("cli.ts run")) &&
            c.args.join(" ").includes("~/runs/c3/instances.jsonl"),
        ),
      ).toBe(false)
      await expect(runPromise).rejects.toThrow(/auth boom/i)
    } finally {
      releaseC2Run?.()
      releaseC3Run?.()
    }
  })

  test("a running BUSY box blocks auto-launch of another box unless explicitly opted in", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances") && a.includes("--filters")) return ok("i-busy\t9.9.9.9")
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n") // detached-run sentinel
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("BUSY")
        return ok("")
      }
      return ok("")
    }
    await expect(
      runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn)),
    ).rejects.toThrow(/refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("an idle warm-box hit in the launch window is ATTACHED directly instead of being re-probed into a fresh launch", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let idleProbeCount = 0
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) {
          idleProbeCount += 1
          if (idleProbeCount === 1) return ok("IDLE") // preflight launch-window hit
          if (idleProbeCount === 2)
            return { code: 255, stdout: "", stderr: "ssh probe flake before attach" }
          if (idleProbeCount === 3) return ok("IDLE") // worker launch-window hit
          if (idleProbeCount === 4)
            return { code: 255, stdout: "", stderr: "ssh reprobe flake after launch window" }
          return ok("IDLE")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn))
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toContain("w__w-1")
  })

  test("the pool's top-level preset authority governs box grounding checks during provision", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("run-instances")) return ok("i-box0")
      if (a.includes("describe-instances")) return ok("1.2.3.4")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("READY")) return ok("READY")
        if (c.includes("command -v pyright-langserver")) {
          return { code: 7, stdout: "PYRIGHT_MISSING\n", stderr: "" }
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (c.includes("setsid bash -c")) return ok("LAUNCHED")
        if (c.includes("run.exit") || c.includes("XQ-RUN-EXIT-XQ")) {
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c)) {
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        }
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, {
        reuseWarm: false,
        preset: "agentless-v2",
      }),
    )
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toContain("w__w-1")
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
  })

  test("waitForIdle parks behind a busy running box, then REUSES it once it goes idle", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const slept: number[] = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let idleProbeCount = 0
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) {
          idleProbeCount += 1
          return ok(idleProbeCount >= 2 ? "IDLE" : "BUSY")
        }
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, {
        waitForIdle: true,
        waitForIdlePollMs: 1234,
        sleep: async (ms: number) => void slept.push(ms),
      }),
    )
    expect(slept).toEqual([1234])
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toContain("w__w-1")
  })

  test("waitForIdle times out instead of launching past a forever-busy box", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const slept: number[] = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    let nowMs = 0
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-instances") && a.includes("--filters")) return ok("i-busy\t9.9.9.9")
      if (a.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("pgrep")) return ok("BUSY")
      }
      return ok("")
    }
    await expect(
      runPool(
        [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
        poolCfg(fn, {
          waitForIdle: true,
          waitForIdlePollMs: 1000,
          waitForIdleTimeoutMs: 2500,
          now: () => nowMs,
          sleep: async (ms: number) => {
            slept.push(ms)
            nowMs += ms
          },
        }),
      ),
    ).rejects.toThrow(/timed out waiting/i)
    expect(slept).toEqual([1000, 1000, 1000])
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("explicit extra-box opt-in can launch past a running BUSY box", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const ok = (s: string): SpawnResult => ({ code: 0, stdout: s, stderr: "" })
    const fn: SpawnFn = async (cmd, args, o) => {
      calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
      const a = [...args]
      if (a.includes("describe-security-groups")) return ok("sg-abc")
      if (a.includes("describe-instances")) {
        return a.includes("--filters") ? ok("i-busy\t9.9.9.9") : ok("1.2.3.4")
      }
      if (a.includes("run-instances")) return ok("i-fresh")
      if (a.includes("wait")) return ok("")
      if (a.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = a[a.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n") // detached-run sentinel
        if (c.includes("READY")) return ok("READY")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("BUSY")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (/cat ~\/runs\/[^/]+\/report\.json/.test(c))
          return ok(JSON.stringify({ resolved_ids: ["w__w-1"] }))
        return ok("")
      }
      return ok("")
    }
    const out = await runPool(
      [{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }],
      poolCfg(fn, { allowExtraBoxes: true, reuseWarm: false }),
    )
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(1)
    expect(out[0]?.lost).toBe(false)
  })

  test("chunkBoxPaths isolates every chunk + trajectory uses $HOME (double-quote safe)", () => {
    const p = chunkBoxPaths("abc")
    expect(p.report).toBe("~/runs/abc/report.json")
    expect(p.dataset).toBe("~/runs/abc/instances.jsonl")
    expect(p.observeDir).toBe("~/runs/abc/observe")
    // trajectory is placed inside double quotes in the record env → MUST be $HOME
    // (bash does not expand ~ inside double quotes).
    expect(p.trajectory.startsWith("$HOME/")).toBe(true)
    expect(p.trajectory).not.toContain("~")
  })
})
