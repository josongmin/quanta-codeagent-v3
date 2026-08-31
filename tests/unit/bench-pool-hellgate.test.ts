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
import {
  createSpawnRecorder,
  fail,
  ok,
  type SpawnHandler,
  when,
  whenArgsInclude,
  whenCmd,
  whenSshRemote,
  whenSshRemoteIncludes,
  whenSshRemoteMatches,
} from "./bench-spawn-testkit"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "REFRESH-super-secret",
  id_token: "IDTOK-secret",
  account_id: "acct-1",
  expires_at: "2099-01-01T00:00:00Z",
})

const TEMP_DIRS = new Set<string>()

const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}

const TS_FIX_PATCH = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1 +1 @@",
  "-export const answer = 0",
  "+export const answer = 42",
].join("\n")

const writeDatasetJsonl = (prefix: string, rows: readonly Record<string, unknown>[]): string => {
  const path = join(allocTempDir(prefix), "instances.jsonl")
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const writeDatasetJsonlAtPath = (path: string, rows: readonly Record<string, unknown>[]): void => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
}

for (const path of [
  "/tmp/unused.jsonl",
  "/tmp/c1.jsonl",
  "/tmp/c2.jsonl",
  "/tmp/c3.jsonl",
  "/tmp/d1.jsonl",
  "/tmp/d2.jsonl",
  "/tmp/d3.jsonl",
  "/tmp/d4.jsonl",
  "/tmp/r1.jsonl",
  "/tmp/a.jsonl",
  "/tmp/b.jsonl",
]) {
  const id =
    path
      .split("/")
      .at(-1)
      ?.replace(/\.jsonl$/, "") ?? "fixture"
  writeDatasetJsonlAtPath(path, [{ instance_id: `fixture__${id}`, patch: TS_FIX_PATCH }])
}

const allocTokenBudgetDir = (): string => allocTempDir("bench-pool-budget-")
const RUN_EXIT_OK = ok("0\n==XQ-RUN-EXIT-XQ==\n")
const defaultPoolResolved = (runId: string): string =>
  JSON.stringify({ resolved_ids: [`x__${runId}-1`] })

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

/** The image id the fake `aws ssm get-parameter` resolves to (see
 *  {@link createPoolSpawnRecorder}). */
const SSM_RESOLVED_AMI = "ami-0123456789abcdef0"

/** Every recorder in this file goes through here, so the two calls the box
 *  lifecycle makes before it can do anything interesting are answered ONCE:
 *   - `curl ifconfig.me` (public IP for the SG ingress rule), and
 *   - `aws ssm get-parameter` — aug-22 regression repair (`9d5369d31`): the
 *     default AMI became an `ssm:` reference that `resolveLaunchAmi`
 *     dereferences BEFORE RunInstances. An unanswered lookup falls through to
 *     the recorder's empty-stdout fallback, the resolver fails loud, and EVERY
 *     worker aborts at provisioning — which is exactly what these teeth were
 *     silently measuring. That the pool's launch actually consumes the resolved
 *     id is pinned by the "resolves the ssm: AMI reference…" test below; the
 *     resolver's own contract is pinned by
 *     src/apps/bench/remote/box-session/ami-resolution.test.ts. */
const createPoolSpawnRecorder = (...handlers: readonly SpawnHandler[]) =>
  createSpawnRecorder(
    whenCmd("curl", ok("9.9.9.9")),
    whenArgsInclude("get-parameter", ok(`${SSM_RESOLVED_AMI}\n`)),
    ...handlers,
  )

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
  let launchIdx = -1
  const reportFor = opts.reportFor ?? ((runId: string) => defaultPoolResolved(runId))
  return createPoolSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenArgsInclude("run-instances", () => {
      launchIdx += 1
      return ok(`i-box${launchIdx}`)
    }),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
    whenArgsInclude("wait", ok("")),
    whenArgsInclude("terminate-instances", () => opts.terminateResult ?? ok("")),
    whenSshRemoteIncludes("READY", ok("READY")),
    whenSshRemoteIncludes("setsid bash -c", ({ remote, onData }) => {
      const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
      if (remote.includes("cli.ts run")) {
        onData?.(`[info] ${runId} started\n`)
        onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
      }
      return ok("LAUNCHED")
    }),
    whenSshRemote(
      (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
      RUN_EXIT_OK,
    ),
    whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
    whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", () => opts.gradeLockReleaseResult ?? ok("")),
    whenSshRemoteIncludes(
      "cat > ~/.quanta/auth/chatgpt.json",
      () => opts.tokenShipResult ?? ok(""),
    ),
    whenSshRemoteMatches(/cat ~\/runs\/([^/]+)\/report\.json/, (match) => {
      opts.beforeReportFetch?.()
      return ok(reportFor(match[1] ?? "", Math.max(0, launchIdx)))
    }),
    whenSshRemoteMatches(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/, (match) =>
      opts.rateLimited?.has(match[1] ?? "")
        ? ok("[FAIL][generation_error] z__z-1 (turns=2)")
        : ok(""),
    ),
  )
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
  singleBoxGuardDir: join(allocTempDir("bench-pool-single-box-root-"), "guard"),
  tokenBudgetDir: allocTokenBudgetDir(),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  authJsonProvider: () => FULL_AUTH,
  ...over,
})

describe("pool fixture isolation", () => {
  test("independent pool configs never share the default single-box guard", () => {
    const first = poolCfg(mockSpawn({}).fn)
    const second = poolCfg(mockSpawn({}).fn)
    expect(first.singleBoxGuardDir).not.toBe(second.singleBoxGuardDir)
  })
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

  // Wiring pin for the stub above: the pool's launch does NOT carry a baked AMI
  // id — it dereferences the `ssm:` default and hands RunInstances whatever came
  // back. Without this, answering `get-parameter` in the recorder would be an
  // unobserved convenience; with it, a launch that stopped consuming the resolved
  // id (or started shipping the raw `ssm:` string) turns this red.
  test("resolves the ssm: AMI reference and launches with exactly that image id", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn))
    const ssmIdx = calls.findIndex((c) => c.args.includes("get-parameter"))
    const runIdx = calls.findIndex((c) => c.args.includes("run-instances"))
    expect(ssmIdx).toBeGreaterThanOrEqual(0)
    expect(ssmIdx).toBeLessThan(runIdx)
    expect(calls[ssmIdx]?.args).toContain(
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
    )
    const launch = calls[runIdx]?.args ?? []
    expect(launch[launch.indexOf("--image-id") + 1]).toBe(SSM_RESOLVED_AMI)
    expect(launch.some((a) => a.startsWith("ssm:"))).toBe(false)
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
      let launchIdx = -1
      let launchedBenchRuns = 0
      const { fn, calls } = createPoolSpawnRecorder(
        whenArgsInclude("describe-security-groups", ok("sg-abc")),
        whenArgsInclude("run-instances", () => {
          launchIdx += 1
          return ok(`i-box${launchIdx}`)
        }),
        whenArgsInclude("describe-instances", ok("1.2.3.4")),
        whenArgsInclude("wait", ok("")),
        whenArgsInclude("terminate-instances", ok("")),
        whenSshRemoteIncludes("READY", ok("READY")),
        whenSshRemoteIncludes("setsid bash -c", ({ remote, onData }) => {
          if (remote.includes("cli.ts run")) {
            launchedBenchRuns += 1
            const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
            onData?.(`[info] ${runId} started\n`)
            onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
          }
          return ok("LAUNCHED")
        }),
        whenSshRemote(
          (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
          async () => {
            if (launchedBenchRuns < 2) {
              await waitForCondition(() => launchedBenchRuns >= 2)
            }
            return RUN_EXIT_OK
          },
        ),
        whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
        whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
        whenSshRemoteMatches(/cat ~\/runs\/([^/]+)\/report\.json/, (match) =>
          ok(defaultPoolResolved(match[1] ?? "")),
        ),
      )
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
    let launched = 0
    let releaseFirstRun: (() => void) | undefined
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    let signalFirstBenchStart: (() => void) | undefined
    const firstBenchStartObserved = new Promise<void>((resolve) => {
      signalFirstBenchStart = resolve
    })
    let firstBenchStarted = false
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", () => {
        launched += 1
        return ok(`i-box${launched - 1}`)
      }),
      whenArgsInclude("wait", ok("")),
      when(
        ({ args }) =>
          args.includes("--filters") && args.includes("Reservations[].Instances[].InstanceId"),
        ok(""),
      ),
      when(
        ({ args }) => args.includes("--filters") && args.includes("InstanceId,PublicIpAddress"),
        ok(""),
      ),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemote(
        (remote) => remote.includes("setsid bash -c") && remote.includes("cli.ts run"),
        ({ remote, onData }) => {
          firstBenchStarted = true
          signalFirstBenchStart?.()
          const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
          onData?.(`[info] ${runId} started\n`)
          onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
          return ok("LAUNCHED")
        },
      ),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        async () => {
          if (firstBenchStarted && launched === 1) await firstRunDone
          return RUN_EXIT_OK
        },
      ),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () => ok(defaultPoolResolved("y"))),
    )

    const first = runPool(
      [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
      poolCfg(fn, {
        tokenBudgetDir,
        singleBoxGuardDir,
      }),
    )
    // The competing run must start only after the first one holds the real
    // single-box guard. Resolve this at the launched-run boundary rather than
    // polling scheduler progress: a loaded CI worker can legitimately delay a
    // 1s poll.
    await firstBenchStartObserved
    expect(firstBenchStarted).toBe(true)
    expect(calls.some((c) => c.args.includes("run-instances"))).toBe(true)

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

  test("RCA jun-20: the bench-run ssh carries keepalive probes (no-keepalive HANG regression)", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn))
    // The bench run is now DETACHED (`setsid … & echo LAUNCHED`), so this ssh
    // returns immediately and the run survives a dropped socket; status comes
    // from SHORT reconnecting polls. Both still carry keepalive probes via the
    // shared makeSsh — ServerAliveInterval=30 + the jun-25 ServerAliveCountMax=4
    // (a hung/partitioned poll errors in ~2min so box-death detection trips fast
    // rather than stranding the run for 10min/poll at the old CountMax=20).
    const benchRuns = calls.filter(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")),
    )
    expect(benchRuns.length).toBeGreaterThan(0)
    for (const c of benchRuns) {
      expect(c.args).toContain("ServerAliveInterval=30")
      expect(c.args).toContain("ServerAliveCountMax=4")
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
    const { fn } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", () => {
        launches += 1
        return launches === 1
          ? ok("i-box0")
          : fail(254, "An error occurred (InsufficientInstanceCapacity)")
      }),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("setsid bash -c", ({ onData }) => {
        onData?.("[FAIL][generation_error] c1__inst-1 (turns=2)\n")
        return ok("LAUNCHED")
      }),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () => ok("")),
    )

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

  test("a partial chunk report is NOT recorded as success; uncovered instanceIds are surfaced", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-partial-", [
      { instance_id: "demo__1", patch: TS_FIX_PATCH },
      { instance_id: "demo__2", patch: TS_FIX_PATCH },
    ])
    const { fn } = mockSpawn({
      reportFor: () => JSON.stringify({ resolved_ids: ["demo__1"] }),
    })
    const out = await runPool(
      [{ runId: "partial", datasetPath, instanceIds: ["demo__1", "demo__2"] }],
      poolCfg(fn, { maxChunkRetries: 1 }),
    )
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.attempts).toBe(2)
    expect(out[0]?.result.resolved).toEqual(["demo__1"])
    expect(out[0]?.missing).toEqual(["demo__2"])
  })

  test("coverage is accumulated across retries for the same chunk", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-accumulate-", [
      { instance_id: "demo__1", patch: TS_FIX_PATCH },
      { instance_id: "demo__2", patch: TS_FIX_PATCH },
    ])
    const { fn } = mockSpawn({
      reportFor: (_runId, launchIdx) =>
        JSON.stringify({ resolved_ids: [launchIdx === 0 ? "demo__1" : "demo__2"] }),
    })
    const out = await runPool(
      [{ runId: "accumulate", datasetPath, instanceIds: ["demo__1", "demo__2"] }],
      poolCfg(fn, { maxChunkRetries: 1 }),
    )
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.attempts).toBe(2)
    expect(out[0]?.missing).toBeUndefined()
    expect(new Set(out[0]?.result.resolved ?? [])).toEqual(new Set(["demo__1", "demo__2"]))
  })

  test("later retry verdict overrides the same instance's earlier bucket instead of leaving split-brain buckets", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-bucket-override-", [
      { instance_id: "demo__1", patch: TS_FIX_PATCH },
      { instance_id: "demo__2", patch: TS_FIX_PATCH },
    ])
    const { fn } = mockSpawn({
      reportFor: (_runId, launchIdx) =>
        JSON.stringify(
          launchIdx === 0
            ? { unresolved_ids: ["demo__1"] }
            : { resolved_ids: ["demo__1", "demo__2"] },
        ),
    })
    const out = await runPool(
      [{ runId: "bucket-override", datasetPath, instanceIds: ["demo__1", "demo__2"] }],
      poolCfg(fn, { maxChunkRetries: 1 }),
    )
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toEqual(["demo__1", "demo__2"])
    expect(out[0]?.result.unresolved).toBeUndefined()
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
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warmbox\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", ok("IDLE")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warmbox\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", ok("IDLE")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", ok("i-fresh")),
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-busy" : "1.2.3.4"),
      ),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("BUSY")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    let launched = false
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", () => {
        launched = true
        return ok("i-fresh")
      }),
      whenArgsInclude("describe-instances", ({ args }) => {
        if (!args.includes("--filters")) return ok("1.2.3.4")
        return args.some((part) => part.includes("Reservations[].Instances[].InstanceId"))
          ? ok(launched ? "i-busy" : "")
          : ok("")
      }),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("BUSY")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    let pgrepCount = 0
    let lockCount = 0
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warm\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", () => {
        pgrepCount += 1
        return ok(pgrepCount <= 2 ? "IDLE" : "BUSY")
      }),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", () => {
        lockCount += 1
        return ok(lockCount === 1 ? "BUSY" : "LOCKED")
      }),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
    await expect(
      runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn, { maxChunkRetries: 1 })),
    ).rejects.toThrow(/refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a mid-run POOL_BUSY warm-box race waits, then REUSES the box once it goes idle", async () => {
    const slept: number[] = []
    let pgrepCount = 0
    let lockCount = 0
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warm\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", () => {
        pgrepCount += 1
        if (pgrepCount <= 2) return ok("IDLE")
        if (pgrepCount <= 4) return ok("BUSY")
        return ok("IDLE")
      }),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", () => {
        lockCount += 1
        return ok(lockCount === 1 ? "BUSY" : "LOCKED")
      }),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", ok("i-owned")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", fail(255, "ssh: connect timeout")),
    )
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
    let authReads = 0
    let launches = 0
    let releaseSecondRun: (() => void) | undefined
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve
    })
    const { fn } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", () => ok(`i-${launches++}`)),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("setsid bash -c", ({ remote, onData }) => {
        const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
        if (remote.includes("cli.ts run")) {
          onData?.(`[info] ${runId} started\n`)
          onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
        }
        return ok("LAUNCHED")
      }),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        async ({ remote }) => {
          if (remote.includes("~/runs/c2/")) await secondRunGate
          return RUN_EXIT_OK
        },
      ),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/([^/]+)\/report\.json/, (match) =>
        ok(defaultPoolResolved(match[1] ?? "")),
      ),
    )
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
    let authReads = 0
    let launches = 0
    let releaseC2Run: (() => void) | undefined
    const c2RunGate = new Promise<void>((resolve) => {
      releaseC2Run = resolve
    })
    let releaseC3Run: (() => void) | undefined
    const c3RunGate = new Promise<void>((resolve) => {
      releaseC3Run = resolve
    })
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", () => ok(`i-${launches++}`)),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("setsid bash -c", ({ remote, onData }) => {
        const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
        if (remote.includes("cli.ts run")) {
          onData?.(`[info] ${runId} started\n`)
          onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
        }
        return ok("LAUNCHED")
      }),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        async ({ remote }) => {
          if (remote.includes("~/runs/c2/")) await c2RunGate
          if (remote.includes("~/runs/c3/")) await c3RunGate
          return RUN_EXIT_OK
        },
      ),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/([^/]+)\/report\.json/, (match) =>
        ok(defaultPoolResolved(match[1] ?? "")),
      ),
    )
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
    const observedRun = runPromise.then(
      () => ({ status: "resolved" as const, error: undefined }),
      (error) => ({ status: "rejected" as const, error }),
    )
    try {
      releaseC2Run?.()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100)
      })
      expect(
        calls.some(
          (c) =>
            c.cmd === "ssh" &&
            c.args.some((arg) => arg.includes("cli.ts run")) &&
            c.args.join(" ").includes("~/runs/c3/instances.jsonl"),
        ),
      ).toBe(false)
      const settled = await observedRun
      expect(settled.status).toBe("rejected")
      expect(String(settled.error)).toMatch(/auth boom/i)
    } finally {
      releaseC2Run?.()
      releaseC3Run?.()
    }
  })

  test("a running BUSY box blocks auto-launch of another box unless explicitly opted in", async () => {
    const { fn, calls } = createPoolSpawnRecorder(
      when(
        ({ args }) => args.includes("describe-instances") && args.includes("--filters"),
        ok("i-busy\t9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("IDLE", ok("BUSY")),
    )
    await expect(
      runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn)),
    ).rejects.toThrow(/refusing to launch another box/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("an idle warm-box hit in the launch window is ATTACHED directly instead of being re-probed into a fresh launch", async () => {
    let idleProbeCount = 0
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warm\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", () => {
        idleProbeCount += 1
        if (idleProbeCount === 1) return ok("IDLE")
        if (idleProbeCount === 2) return fail(255, "ssh probe flake before attach")
        if (idleProbeCount === 3) return ok("IDLE")
        if (idleProbeCount === 4) return fail(255, "ssh reprobe flake after launch window")
        return ok("IDLE")
      }),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
    const out = await runPool([{ runId: "r1", datasetPath: "/tmp/r1.jsonl" }], poolCfg(fn))
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(out[0]?.lost).toBe(false)
    expect(out[0]?.result.resolved).toContain("w__w-1")
  })

  test("the pool's top-level preset authority governs box grounding checks during provision", async () => {
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("run-instances", ok("i-box0")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("command -v pyright-langserver", fail(7, "", "PYRIGHT_MISSING\n")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteIncludes("setsid bash -c", ok("LAUNCHED")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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

  test("thin-strict pool fails closed before launch when a chunk needs non-pyright LSP grounding", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-ts-dataset-", [
      { instance_id: "acme__ts-1", patch: TS_FIX_PATCH },
    ])
    const { fn, calls } = mockSpawn({})
    await expect(
      runPool(
        [{ runId: "ts-1", datasetPath, instanceIds: ["acme__ts-1"] }],
        poolCfg(fn, { preset: "agentless-v3-thin-strict" }),
      ),
    ).rejects.toThrow(/typescript-language-server/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("pool fails closed before launch when a chunk selects missing instanceIds", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-missing-id-", [
      { instance_id: "psf__requests-5414", patch: TS_FIX_PATCH },
    ])
    const { fn, calls } = mockSpawn({})
    await expect(
      runPool(
        [{ runId: "missing-id", datasetPath, instanceIds: ["missing__case-1"] }],
        poolCfg(fn, { preset: "agentless-v2" }),
      ),
    ).rejects.toThrow(/selected instanceIds are missing/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("pool fails closed before launch when a chunk dataset is empty", async () => {
    const datasetPath = writeDatasetJsonl("bench-pool-empty-", [])
    const { fn, calls } = mockSpawn({})
    await expect(
      runPool([{ runId: "empty-dataset", datasetPath }], poolCfg(fn, { preset: "agentless-v2" })),
    ).rejects.toThrow(/contains no parseable task rows/i)
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("waitForIdle parks behind a busy running box, then REUSES it once it goes idle", async () => {
    const slept: number[] = []
    let idleProbeCount = 0
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-warm\t9.9.9.9" : "9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", () => {
        idleProbeCount += 1
        return ok(idleProbeCount >= 2 ? "IDLE" : "BUSY")
      }),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
    const slept: number[] = []
    let nowMs = 0
    const { fn, calls } = createPoolSpawnRecorder(
      when(
        ({ args }) => args.includes("describe-instances") && args.includes("--filters"),
        ok("i-busy\t9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("pgrep", ok("BUSY")),
    )
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
    const { fn, calls } = createPoolSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-busy\t9.9.9.9" : "1.2.3.4"),
      ),
      whenArgsInclude("run-instances", ok("i-fresh")),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("IDLE", ok("BUSY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemoteMatches(/cat ~\/runs\/[^/]+\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["w__w-1"] })),
      ),
    )
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
