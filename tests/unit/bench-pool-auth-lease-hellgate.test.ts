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
import type { AuthPoolEntry } from "../../src/apps/bench/auth-pool"
import { AuthLeaseManager } from "../../src/apps/bench/auth-pool"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import {
  createLeasePoolAuthProvider,
  type PoolAuthProvider,
} from "../../src/apps/bench/remote/pool-auth"

const authJsonFor = (label: string): string =>
  JSON.stringify({
    access_token: `ACCESS-${label}`,
    expires_at: "2099-01-01T00:00:00.000Z",
    refresh_token: `REFRESH-${label}-secret`,
    id_token: `IDTOK-${label}-secret`,
    account_id: label,
  })

/** The AMI id the fake `aws ssm get-parameter` resolves to. aug-22 regression
 *  repair (`9d5369d31`): the default AMI became an `ssm:` reference that
 *  `resolveLaunchAmi` dereferences BEFORE RunInstances, so every mock spawn here
 *  must answer that lookup — otherwise it falls through to empty stdout, the
 *  resolver throws, and the worker aborts before a single lease/launch teeth
 *  assertion is reachable. The resolution contract itself stays pinned by
 *  src/apps/bench/remote/box-session/ami-resolution.test.ts. */
const RESOLVED_AMI = "ami-0123456789abcdef0"

const BUDGET_DIRS = new Set<string>()
const allocBudgetDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-pool-auth-"))
  BUDGET_DIRS.add(dir)
  return dir
}

const spawnOk = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
const lastArg = (args: readonly string[]): string => args[args.length - 1] ?? ""

const sshControlResponse = (command: string): SpawnResult | undefined => {
  if (command.includes("READY")) return spawnOk("READY")
  if (command.includes("run.exit") || command.includes("XQ-RUN-EXIT-XQ")) {
    return spawnOk("0\n==XQ-RUN-EXIT-XQ==\n")
  }
  if (command.includes("mkdir ~/.pool-grade.lock")) return spawnOk("LOCKED")
  if (command.includes("rmdir ~/.pool-grade.lock")) return spawnOk("")
  return undefined
}

const sshReportResponse = (command: string): SpawnResult | undefined => {
  const report = command.match(/cat ~\/runs\/([^/]+)\/report\.json/)
  return report === null
    ? undefined
    : spawnOk(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
}

const sshTailResponse = (
  command: string,
  rateLimited: ReadonlySet<string> | undefined,
): SpawnResult | undefined => {
  const tail = command.match(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/)
  return tail !== null && rateLimited?.has(tail[1] ?? "")
    ? spawnOk("[FAIL][generation_error] z__z-1 (turns=2)")
    : undefined
}

const defaultSshResponse = (
  args: readonly string[],
  rateLimited: ReadonlySet<string> | undefined,
): SpawnResult => {
  const command = lastArg(args)
  return (
    sshControlResponse(command) ??
    sshReportResponse(command) ??
    sshTailResponse(command, rateLimited) ??
    spawnOk("")
  )
}

const infrastructureResponse = (args: readonly string[]): SpawnResult | undefined => {
  if (args.includes("get-parameter")) return spawnOk(`${RESOLVED_AMI}\n`)
  if (args.includes("run-instances")) return spawnOk("i-box")
  if (args.includes("describe-instances")) return spawnOk("1.2.3.4")
  return undefined
}

const runIdFromArgs = (args: readonly string[]): string =>
  lastArg(args).match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"

const emitPassingRun = (
  args: readonly string[],
  onData: ((data: string) => void) | undefined,
): void => {
  if (args.some((arg) => arg.includes("cli.ts run"))) {
    const runId = runIdFromArgs(args)
    onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
  }
}

const requeueSpawn = (): SpawnFn => {
  let c1Seen = 0
  return async (cmd, args, options) => {
    if (cmd === "curl") return spawnOk("9.9.9.9")
    emitPassingRun(args, options?.onData)
    const infrastructure = infrastructureResponse(args)
    if (infrastructure !== undefined) return infrastructure
    if (cmd !== "ssh") return spawnOk("")
    const command = lastArg(args)
    const control = sshControlResponse(command)
    if (control !== undefined) return control
    const report = command.match(/cat ~\/runs\/([^/]+)\/report\.json/)
    if (report === null) return spawnOk("")
    if (report[1] !== "c1") return spawnOk(JSON.stringify({ resolved_ids: [`x__${report[1]}-1`] }))
    c1Seen += 1
    return spawnOk(c1Seen === 1 ? "" : JSON.stringify({ resolved_ids: ["x__c1-1"] }))
  }
}

/** mock spawn: every box healthy, one resolved verdict per chunk; optional 429
 *  marker per runId. Records every call so we can inspect ship order + tokens. */
const mockSpawn = (opts: { rateLimited?: Set<string>; eventLog?: string[] } = {}) => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const fn: SpawnFn = async (cmd, args, o): Promise<SpawnResult> => {
    calls.push({ cmd, args: [...args], ...(o?.input !== undefined ? { input: o.input } : {}) })
    if (cmd === "curl") return spawnOk("9.9.9.9")
    if (cmd === "ssh" && args.some((a) => a.includes("cli.ts run"))) {
      const runId = lastArg(args).match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
      o?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
    }
    const infrastructure = infrastructureResponse(args)
    if (infrastructure !== undefined) {
      if (args.includes("run-instances")) opts.eventLog?.push("launch")
      return infrastructure
    }
    return cmd === "ssh" ? defaultSshResponse(args, opts.rateLimited) : spawnOk("")
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

type Deferred<T> = {
  readonly promise: Promise<T>
  resolve(value: T): void
}

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred resolver was not initialized")
      resolvePromise(value)
    },
  }
}

type MaxBoxesSignals = {
  readonly events: string[]
  readonly gradeBlocked: Deferred<void>
  readonly gradeInFlight: Deferred<void>
  readonly capRefusedWhileGrading: Deferred<string>
  readonly secondBoxLaunched: Deferred<string>
  gradeIsInFlight: boolean
  launches: number
}

const runIdFromGradeArgs = (args: readonly string[]): string =>
  lastArg(args).match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "x"

const blockFirstGrade = async (
  args: readonly string[],
  options: Parameters<SpawnFn>[2],
  signals: MaxBoxesSignals,
): Promise<void> => {
  if (!args.some((arg) => arg.includes("cli.ts run"))) return
  const runId = runIdFromGradeArgs(args)
  if (runId === "c1") {
    signals.events.push("grade:c1:start")
    signals.gradeIsInFlight = true
    signals.gradeInFlight.resolve()
    await signals.gradeBlocked.promise
    signals.events.push("grade:c1:done")
  }
  options?.onData?.(`[PASS] ${runId}__inst-1 (turns=2)\n`)
}

const maxBoxesInfrastructureResponse = (
  args: readonly string[],
  signals: MaxBoxesSignals,
): SpawnResult | undefined => {
  if (args.includes("get-parameter")) return spawnOk(`${RESOLVED_AMI}\n`)
  if (args.includes("run-instances")) {
    signals.launches += 1
    signals.events.push(`launch:${signals.launches}`)
    if (signals.launches > 1) signals.secondBoxLaunched.resolve("second-box-launched")
    return spawnOk(`i-box-${signals.launches}`)
  }
  if (args.includes("describe-instances")) return spawnOk("1.2.3.4")
  if (args.includes("terminate-instances")) {
    signals.events.push("terminate")
    return spawnOk("")
  }
  return undefined
}

/** Scripted pool responder. It never invokes Docker, AWS, or a network socket:
 * every reachable command gets a local deterministic result. */
const maxBoxesSpawn =
  (signals: MaxBoxesSignals): SpawnFn =>
  async (cmd, args, options) => {
    if (cmd === "curl") return spawnOk("9.9.9.9")
    if (cmd === "ssh") {
      await blockFirstGrade(args, options, signals)
      return defaultSshResponse(args, undefined)
    }
    return maxBoxesInfrastructureResponse(args, signals) ?? spawnOk("")
  }

const recordingMaxBoxesProvider = (
  manager: AuthLeaseManager,
  signals: MaxBoxesSignals,
): PoolAuthProvider => {
  const base = createLeasePoolAuthProvider(manager, () => authJsonFor("solo"))
  return {
    acquire: (request) => {
      const lease = base.acquire(request)
      if (lease === null) {
        signals.events.push(`lease:refused:${request.runId}`)
        if (signals.gradeIsInFlight) {
          signals.capRefusedWhileGrading.resolve("cap-refused-while-c1-grades")
        }
        return null
      }
      signals.events.push(`lease:granted:${request.runId}`)
      return {
        accountLabel: lease.accountLabel,
        readAuthJson: () => lease.readAuthJson(),
        release: (result) => {
          signals.events.push(`lease:released:${request.runId}`)
          lease.release(result)
        },
      }
    },
    canEventuallySchedule: () => base.canEventuallySchedule(),
    nextReadyAt: () => base.nextReadyAt(),
  }
}

const createMaxBoxesScenario = () => {
  const signals: MaxBoxesSignals = {
    events: [],
    gradeBlocked: deferred<void>(),
    gradeInFlight: deferred<void>(),
    capRefusedWhileGrading: deferred<string>(),
    secondBoxLaunched: deferred<string>(),
    gradeIsInFlight: false,
    launches: 0,
  }
  const manager = new AuthLeaseManager(
    [{ label: "solo", authFile: "/s.json", maxParallel: 24, maxBoxes: 1 }],
    { now: () => 1_000_000 },
  )
  const provider = recordingMaxBoxesProvider(manager, signals)
  const runPromise = runPool(
    [
      { runId: "c1", datasetPath: "/tmp/c1.jsonl" },
      { runId: "c2", datasetPath: "/tmp/c2.jsonl" },
    ],
    poolCfg(maxBoxesSpawn(signals), provider, {
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
  return { manager, signals, runPromise }
}

/** Await `p`, but fail LOUDLY (with the event trace) instead of hanging if the
 *  awaited signal never arrives. The timer is cleared on settle so a passing
 *  test never leaves a pending timer behind. The bound is generous on purpose:
 *  it is a deadlock backstop, NOT the thing that decides the verdict — every
 *  assertion below hangs off an explicit event, so CPU load cannot flip it. */
const withTestDeadline = async <T>(
  p: Promise<T>,
  label: string,
  events: readonly string[],
  ms = 15_000,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}: ${events.join(" | ")}`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

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
    const base = createLeasePoolAuthProvider(mgr, (p) => authJsonFor(p === "/a.json" ? "a" : "b"))
    const recording: PoolAuthProvider = {
      acquire: (req) => {
        events.push("acquire")
        return base.acquire(req)
      },
      canEventuallySchedule: () => base.canEventuallySchedule(),
      nextReadyAt: () => base.nextReadyAt(),
    }
    return runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, recording)).then(
      () => {
        expect(events[0]).toBe("acquire") // lease first…
        expect(events).toContain("launch") // …then the box launched
        expect(events.indexOf("acquire")).toBeLessThan(events.indexOf("launch"))
      },
    )
  })

  test("clean run leaks no slots (every lease released on success)", async () => {
    const { fn } = mockSpawn({})
    const mgr = new AuthLeaseManager(TWO_ACCOUNTS, { now: () => 1_000_000 })
    const provider = createLeasePoolAuthProvider(mgr, (p) =>
      authJsonFor(p === "/a.json" ? "a" : "b"),
    )
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
    const fn = requeueSpawn()
    const mgr = new AuthLeaseManager(
      [{ label: "solo", authFile: "/s.json", maxParallel: 6, maxBoxes: 1 }],
      {
        now: () => 1_000_000,
      },
    )
    const provider = createLeasePoolAuthProvider(mgr, () => authJsonFor("solo"))
    const out = await runPool(
      [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
      poolCfg(fn, provider, {
        maxChunkRetries: 2,
        reuseWarm: false,
      }),
    )
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
    const provider = createLeasePoolAuthProvider(mgr, (p) =>
      authJsonFor(p === "/a.json" ? "a" : "b"),
    )
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
    const provider = createLeasePoolAuthProvider(mgr, (p) =>
      authJsonFor(p === "/a.json" ? "a" : "b"),
    )
    const out = await runPool(
      [{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }],
      poolCfg(fn, provider),
    )
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
    const mgr = new AuthLeaseManager(
      [{ label: "solo", authFile: "/missing.json", maxParallel: 6, maxBoxes: 1 }],
      {
        now: () => 1_000_000,
      },
    )
    const provider = createLeasePoolAuthProvider(mgr, () => {
      throw new Error("ENOENT: missing auth file")
    })
    await expect(
      runPool([{ runId: "c1", datasetPath: "/tmp/c1.jsonl" }], poolCfg(fn, provider)),
    ).rejects.toThrow(/missing auth file/i)
    expect(mgr.snapshot()[0]?.activeSlots).toBe(0)
    expect(mgr.snapshot()[0]?.activeBoxes).toBe(0)
  })

  /**
   * `maxBoxes` = cap on boxes SIMULTANEOUSLY DRAWING ON one account's OAuth
   * budget (i.e. concurrent chunk leases) — NOT a cap on how many EC2 boxes are
   * alive. Sources for that reading:
   *  - jun-20 README §2 Decision: "routing unit = chunk", "allocation = per-chunk
   *    AuthLease", "execution = box-sticky preference, not hard pin"; per-box
   *    fixed account pinning was explicitly REJECTED.
   *  - T-3 acceptance criteria: "worker releases the lease on success, requeue,
   *    and throw" — the lease is chunk-scoped by contract.
   *  - T-2 hellgate pins the core as "maxBoxes caps concurrent leases even when
   *    slots remain" (tests/unit/bench-auth-lease-manager-hellgate.test.ts).
   *  - The sibling "clean run leaks no slots" test above runs with the DEFAULT
   *    keepWarm=true — every worker box is deliberately left ALIVE for reuse —
   *    and still asserts `activeBoxes === 0`. A live-box reading of the counter
   *    would make these two tests contradict each other.
   * Live-box count has its OWN governor: the launch-window gate ("refusing to
   * launch a fresh box while N quanta-bench box(es) are already live"), pinned in
   * tests/unit/bench-pool-hellgate.test.ts. This test opts OUT of it
   * (allowExtraBoxes) precisely so ONLY the auth cap is under test.
   *
   * NON-VACUITY: `maxParallel` is set well ABOVE the granted slot count
   * (requestedSlots = clampPatchGenConcurrency(concurrency=8) = 8), so the slot
   * cap CANNOT refuse c2 and `maxBoxes` is the only thing that can. With the old
   * `maxParallel: 6`, the 8-slot request saturated the account outright and the
   * maxBoxes teeth were inert (verified: the whole file stayed green with the
   * `maxBoxes` check deleted from `isReady`).
   *
   * DETERMINISM: the verdict hangs off OBSERVABLE events raced against each
   * other — "the account refused a lease while c1 is mid-grade" vs "a second box
   * launched" — never on counting microtasks, so CPU load cannot flip it.
   */
  test("maxBoxes caps CONCURRENT account leases: no second box launches while the account's only box-lease is grading", async () => {
    const { manager, signals, runPromise } = createMaxBoxesScenario()
    // If runPool blows up early, surface THAT error rather than a timeout.
    const runFinishedEarly = runPromise.then(() => "run-finished-before-c1-graded")
    await withTestDeadline(signals.gradeInFlight.promise, "c1's grade to start", signals.events)
    const verdict = await withTestDeadline(
      Promise.race([
        signals.capRefusedWhileGrading.promise,
        signals.secondBoxLaunched.promise,
        runFinishedEarly,
      ]),
      "the account cap to refuse worker 2 (or a second box to race past it)",
      signals.events,
    )
    // Snapshot the observations BEFORE unblocking, then always unblock — a red
    // assertion must never wedge the still-running pool.
    const launchesWhileHeld = signals.events.filter((event) => event.startsWith("launch:"))
    const boxesWhileHeld = manager.snapshot()[0]?.activeBoxes
    const slotsWhileHeld = manager.snapshot()[0]?.activeSlots
    signals.gradeBlocked.resolve()
    const out = await withTestDeadline(runPromise, "run completion", signals.events)

    // TEETH 1 — the cap actually refused, and it refused BECAUSE of maxBoxes:
    // slots were still available (8 of 24 used) yet the box budget was spent.
    expect(verdict).toBe("cap-refused-while-c1-grades")
    expect(boxesWhileHeld).toBe(1)
    expect(slotsWhileHeld).toBe(8)
    // TEETH 2 — exactly ONE box existed while the account's lease was held.
    expect(launchesWhileHeld).toEqual(["launch:1"])
    // TEETH 3 — the lease RELEASE is what opens the cap (T-3: released on
    // success), so the second launch may only follow c1's release.
    expect(signals.events.indexOf("lease:released:c1")).toBeGreaterThanOrEqual(0)
    expect(signals.events.indexOf("launch:2")).toBeGreaterThan(
      signals.events.indexOf("lease:released:c1"),
    )
    // TEETH 4 — and the run still completes with no chunk lost and no leak.
    expect(out.every((r) => !r.lost)).toBe(true)
    expect(manager.snapshot()[0]?.activeSlots).toBe(0)
    expect(manager.snapshot()[0]?.activeBoxes).toBe(0)
  }, 30_000)
})

// cleanup
import { afterAll } from "bun:test"

afterAll(() => {
  for (const d of BUDGET_DIRS) rmSync(d, { recursive: true, force: true })
})
