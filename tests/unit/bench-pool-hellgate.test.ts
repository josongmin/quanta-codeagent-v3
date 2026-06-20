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
import { describe, expect, test } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { detectRateLimit } from "../../src/apps/bench/remote/box-session"
import { chunkBoxPaths, type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "REFRESH-super-secret",
  id_token: "IDTOK-secret",
  account_id: "acct-1",
})

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
    if (cmd.includes("rmdir ~/.pool-grade.lock")) return ok("")
    // detached-run launch/poll: the `run.exit` sentinel carries the bench exit
    // code (RCA jun-20 ssh-resilience). Report DONE (exit 0) immediately so the
    // poll loop terminates in one tick; launch ssh ignores the stdout.
    if (cmd.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
    // report fetch: `cat ~/runs/<runId>/report.json 2>/dev/null`
    const m = cmd.match(/cat ~\/runs\/([^/]+)\/report\.json/)
    if (m) return ok(reportFor(m[1] ?? "", Math.max(0, launchIdx)))
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
    if (args.includes("terminate-instances")) return ok("")
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

describe("runPool — persistent box, amortised bootstrap", () => {
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

  test("keepWarm:false terminates the box on clean drain", async () => {
    const { fn, calls } = mockSpawn({})
    await runPool(CHUNKS, poolCfg(fn, { keepWarm: false, reuseWarm: false }))
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(1)
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
      if (a.includes("describe-instances")) return ok("1.2.3.4")
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
      poolCfg(fn, { maxChunkRetries: 1, reuseWarm: false }),
    )
    // CRITICAL TEETH: a box hitting POOL_BUSY is NEVER terminated (don't kill the
    // other run). If the POOL_BUSY branch wrongly called terminate, this is >0.
    expect(count(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
    // It DID launch (and re-launch on requeue) — proving the box was dropped+replaced.
    expect(count(calls, (c) => c.args.includes("run-instances"))).toBeGreaterThan(0)
    // lost:true proves the BUSY path ran — a bypassed lock would RESOLVE (lost:false).
    expect(out[0]?.lost).toBe(true)
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
