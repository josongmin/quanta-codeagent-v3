/**
 * RED-first HELLGATE for the full-remote executor (ADR-0536 §6 / P3).
 *
 * Full-remote runs patch-gen AND grading on the box, which means an LLM
 * credential MUST reach the box. The whole risk surface is credential leakage,
 * so the centerpiece is SECURITY TEETH:
 *   - the long-lived `refresh_token` / `id_token` are NEVER shipped (only the
 *     short-lived `access_token` + non-secret account fields);
 *   - the box is hardened (IMDSv2 hop-1, TTL self-terminate) and ALWAYS
 *     terminated (even when the run throws) so a leaked box can't linger;
 *   - everything goes through an injected SpawnFn ⇒ this hellgate proves the
 *     invariants WITHOUT provisioning a box or shipping a real token.
 *
 * Red-on-injection: if someone ships the whole auth json (refresh_token
 * included), or drops IMDSv2/TTL/terminate, a test here fails.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { createFullRemoteBackend, stripToAccessToken } from "../../src/apps/bench/remote/full"
import {
  acquirePatchGenBudgetLease,
  readPatchGenBudgetState,
} from "../../src/apps/bench/remote/token-budget"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "REFRESH-super-secret-long-lived",
  id_token: "IDTOK-secret",
  account_id: "acct-123",
  expires_at: "2026-06-24T00:00:00Z",
})

const TEMP_DIRS = new Set<string>()

const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}

const TOKEN_BUDGET_DIR = allocTempDir("bench-full-budget-")
const DEFAULT_SINGLE_BOX_GUARD_DIR = join(allocTempDir("bench-full-single-box-root-"), "guard")

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

describe("stripToAccessToken (security crux)", () => {
  test("keeps real access_token; REAL refresh_token/id_token never shipped (placeholders only)", () => {
    const out = stripToAccessToken(FULL_AUTH)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.access_token).toBe("ACCESS-xyz")
    expect(parsed.account_id).toBe("acct-123")
    expect(parsed.expires_at).toBe("2026-06-24T00:00:00Z")
    // TEETH: the loader requires refresh_token/id_token fields, so they're present
    // — but as REDACTED placeholders, NEVER the real long-lived secret values.
    expect(parsed.refresh_token).not.toBe("REFRESH-super-secret-long-lived")
    expect(parsed.id_token).not.toBe("IDTOK-secret")
    expect(out).not.toContain("REFRESH-super-secret-long-lived")
    expect(out).not.toContain("IDTOK-secret")
  })

  test("THROWS (fail-fast) when access_token is absent/empty — never ships a useless token", () => {
    // Without this guard the box gets a token with no access_token → 0 turns /
    // empty patch after a full provision cycle (a silent, expensive waste).
    expect(() => stripToAccessToken(JSON.stringify({ refresh_token: "r", id_token: "i" }))).toThrow(
      /access_token/,
    )
    expect(() => stripToAccessToken(JSON.stringify({ access_token: "" }))).toThrow(/access_token/)
  })
})

/** Mock spawn recording every command + its stdin input. With
 *  `{ emptyReport: true }` the report-fetch (and any `.json` ssh) returns empty
 *  stdout — the "box produced no report" scenario. */
const mockSpawn = (
  o: { emptyReport?: boolean; reportBody?: string; beforeReportFetch?: () => void } = {},
): { fn: SpawnFn; calls: Array<{ cmd: string; args: string[]; input?: string }> } => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
  // Split ssh routing into a sub-helper so cognitive complexity stays flat.
  const routeSsh = (args: string[]): SpawnResult => {
    if (args.some((a) => a.includes("setsid bash -c"))) return ok("LAUNCHED")
    if (args.some((a) => a.includes("run.exit") || a.includes("XQ-RUN-EXIT-XQ"))) {
      return ok(`0\n==XQ-RUN-EXIT-XQ==\n`)
    }
    if (args.some((a) => a.includes("bun") && a.includes("READY"))) return ok("READY") // readiness
    // atomic grade lock (a fresh box acquires it cleanly ⇒ LOCKED).
    if (args.some((a) => a.includes("mkdir ~/.pool-grade.lock"))) return ok("LOCKED")
    const reportFetch = args.find((a) => /cat ~\/(?:runs\/[^/]+\/)?report\.json/.test(a))
    if (reportFetch !== undefined) {
      o.beforeReportFetch?.()
      return ok(
        o.emptyReport
          ? ""
          : (o.reportBody ?? JSON.stringify({ resolved_ids: ["psf__requests-5414"] })),
      )
    }
    if (args.some((a) => a.includes("cat ") || a.includes(".json"))) return ok("")
    return ok("")
  }
  const route = (cmd: string, args: string[]): SpawnResult => {
    if (args.includes("describe-security-groups")) return ok("sg-abc")
    if (cmd === "curl") return ok("9.9.9.9")
    if (args.includes("run-instances")) return ok("i-deadbeef")
    if (args.includes("describe-instances")) return ok("1.2.3.4")
    if (cmd === "ssh") return routeSsh(args)
    return ok("")
  }
  const fn: SpawnFn = async (cmd, args, opts): Promise<SpawnResult> => {
    calls.push({
      cmd,
      args: [...args],
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    })
    if (cmd === "ssh" && args.some((a) => a.includes("run --swebench"))) {
      opts?.onData?.("[info] bench(swebench): 1 task(s)\n")
      opts?.onData?.("[PASS] psf__requests-5414 (turns=2)\n")
    }
    return route(cmd, [...args])
  }
  return { fn, calls }
}

const everyShippedString = (calls: Array<{ args: string[]; input?: string }>): string =>
  calls.map((c) => `${c.args.join(" ")} ${c.input ?? ""}`).join("\n")
const countCalls = (
  calls: Array<{ cmd: string; args: string[] }>,
  pred: (c: { cmd: string; args: string[] }) => boolean,
): number => calls.filter(pred).length

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

describe("full-remote executor (injected spawn — no real box/token)", () => {
  const baseCfg = {
    repoDir: "/tmp/fake-repo",
    authJson: FULL_AUTH,
    datasetPath: "/tmp/ds.jsonl",
    instanceIds: ["psf__requests-5414"],
    singleBoxGuardDir: DEFAULT_SINGLE_BOX_GUARD_DIR,
    tokenBudgetDir: TOKEN_BUDGET_DIR,
    tokenBudgetWaitMs: 5_000,
    tokenBudgetPollMs: 10,
    sleep: async () => {}, // no real waiting in tests
    maxReadyPolls: 2,
  }

  test("NEVER ships refresh_token/id_token to the box (only the stripped token)", async () => {
    const { fn, calls } = mockSpawn()
    const backend = createFullRemoteBackend({ ...baseCfg, spawn: fn })
    await backend.run().catch(() => undefined)
    const shipped = everyShippedString(calls)
    // TEETH — the long-lived secrets must not appear in ANY command/stdin.
    expect(shipped).not.toContain("REFRESH-super-secret-long-lived")
    expect(shipped).not.toContain("IDTOK-secret")
    // ...but the access token IS shipped (full mode needs it to run the agent).
    expect(shipped).toContain("ACCESS-xyz")
  })

  test("box is hardened: IMDSv2 hop-1 + TTL self-terminate on launch", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const launch = calls.find((c) => c.args.includes("run-instances"))
    expect(launch).toBeDefined()
    const argstr = launch?.args.join(" ") ?? ""
    expect(argstr).toContain("HttpTokens=required")
    expect(argstr).toContain("HttpPutResponseHopLimit=1")
    const ud = everyShippedString(calls)
    expect(ud).toMatch(/shutdown -h \+\d+/) // TTL backstop
    // R3 teeth (the SSH-timeout bug): launch MUST attach a security group, else
    // the box lands in the default SG with no inbound :22 ⇒ ssh times out.
    expect(argstr).toContain("--security-group-ids")
  })

  test("launch tags expose preset/model/dataset/selection before box-side snapshots exist", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({
      ...baseCfg,
      spawn: fn,
      preset: "agentless-v2",
      model: "gpt-5.4",
    })
      .run()
      .catch(() => undefined)
    const launch = calls.find((c) => c.args.includes("run-instances"))
    const argstr = launch?.args.join(" ") ?? ""
    expect(argstr).toContain("Key=QuantaMode,Value=full-remote")
    expect(argstr).toContain("Key=QuantaPreset,Value=agentless-v2")
    expect(argstr).toContain("Key=QuantaModel,Value=gpt-5.4")
    expect(argstr).toContain("Key=QuantaDataset,Value=ds.jsonl")
    expect(argstr).toContain("Key=QuantaSelection,Value=psf__requests-5414")
  })

  test("market: default is SPOT; onDemand:true drops the spot market option", async () => {
    const launchArgs = async (cfg: Parameters<typeof createFullRemoteBackend>[0]) => {
      const { fn, calls } = mockSpawn()
      await createFullRemoteBackend({ ...cfg, spawn: fn })
        .run()
        .catch(() => undefined)
      return calls.find((c) => c.args.includes("run-instances"))?.args.join(" ") ?? ""
    }
    // Default ⇒ spot (cheap, reclaimable).
    expect(await launchArgs(baseCfg)).toContain('{"MarketType":"spot"}')
    // On-demand ⇒ NO market option (AWS default = on-demand = no reclaim). This
    // is the capacity-crunch escape hatch (spot reclaimed c7i in 4–17 min).
    const onDemandArgs = await launchArgs({ ...baseCfg, onDemand: true })
    expect(onDemandArgs).not.toContain("MarketType")
    expect(onDemandArgs).not.toContain("instance-market-options")
    // ...but the rest of the hardening is unchanged.
    expect(onDemandArgs).toContain("HttpTokens=required")
  })

  test("grading STAYS SERIAL: remote bench-run sets NO QUANTA_SWEBENCH_GRADE_CONCURRENCY", async () => {
    // RCA 2026-06-19: concurrent on-box grading (GRADE_CONCURRENCY=6) FALSE-
    // NEGATIVED correct patches — a box scored 0/5 while the SAME predictions
    // re-graded serially scored 4/5 (gold-identical, git-apply-clean patches
    // wrongly marked unresolved; concurrent run_evaluation races the shared
    // run_id image cache/cleanup). Grading must stay serial; patch-gen stays
    // concurrent. Red-on-injection: re-add the env and this fails.
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const benchRun = calls.find(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
    )
    expect(benchRun).toBeDefined()
    const cmd = benchRun?.args.join(" ") ?? ""
    expect(cmd).not.toContain("QUANTA_SWEBENCH_GRADE_CONCURRENCY") // serial grading
    expect(cmd).toContain("QUANTA_BENCH_CONCURRENCY=") // ...but patch-gen stays parallel
  })

  test("global patch-gen budget DOWN-SCALES full-remote concurrency when another run already holds tokens", async () => {
    const held = await acquirePatchGenBudgetLease({
      label: "other-run",
      requestedUnits: 12,
      dir: TOKEN_BUDGET_DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    try {
      const { fn, calls } = mockSpawn()
      await createFullRemoteBackend({ ...baseCfg, spawn: fn })
        .run()
        .catch(() => undefined)
      const benchRun = calls.find(
        (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
      )
      expect(benchRun).toBeDefined()
      expect(benchRun?.args.join(" ") ?? "").toContain("QUANTA_BENCH_CONCURRENCY=4")
      const state = await readPatchGenBudgetState({ dir: TOKEN_BUDGET_DIR })
      expect(state.inUse).toBe(12)
      expect(state.leases.map((lease) => lease.label)).toEqual(["other-run"])
    } finally {
      await held.release()
    }
  })

  test("waits on the global patch-gen budget BEFORE provisioning the box", async () => {
    const held = await acquirePatchGenBudgetLease({
      label: "block-full-budget",
      requestedUnits: 16,
      minUnits: 16,
      dir: TOKEN_BUDGET_DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    const { fn, calls } = mockSpawn()
    const runPromise = createFullRemoteBackend({
      ...baseCfg,
      spawn: fn,
      tokenBudgetWaitMs: 1_000,
      tokenBudgetPollMs: 10,
    }).run()
    let failure: unknown
    try {
      expect(
        await waitForCondition(() => calls.some((c) => c.args.includes("run-instances")), {
          timeoutMs: 200,
        }),
      ).toBe(false)
      expect(
        calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench"))),
      ).toBe(false)
    } catch (err) {
      failure = err
    } finally {
      await held.release()
    }
    await runPromise.catch(() => undefined)
    if (failure !== undefined) throw failure
    expect(calls.some((c) => c.args.includes("run-instances"))).toBe(true)
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench"))),
    ).toBe(true)
  })

  test("a global patch-gen budget release failure ABORTS the run instead of silently succeeding", async () => {
    const tokenBudgetDir = mkdtempSync(join(tmpdir(), "bench-full-budget-release-"))
    let releaseLock: (() => void) | undefined
    try {
      const { fn } = mockSpawn({
        beforeReportFetch: () => {
          releaseLock ??= holdBudgetMutationLock(tokenBudgetDir)
        },
      })
      await expect(
        createFullRemoteBackend({
          ...baseCfg,
          spawn: fn,
          tokenBudgetDir,
          tokenBudgetWaitMs: 100,
          tokenBudgetPollMs: 10,
        }).run(),
      ).rejects.toThrow(/global patch-gen budget lock|timed out waiting/i)
    } finally {
      releaseLock?.()
      rmSync(tokenBudgetDir, { recursive: true, force: true })
    }
  })

  test("a single-box guard release failure preserves the earlier budget-release failure", async () => {
    const tokenBudgetDir = mkdtempSync(join(tmpdir(), "bench-full-budget-guard-release-"))
    const singleBoxRoot = allocTempDir("bench-full-guard-release-root-")
    const singleBoxGuardDir = join(singleBoxRoot, "guard")
    let releaseLock: (() => void) | undefined
    try {
      const { fn } = mockSpawn({
        beforeReportFetch: () => {
          releaseLock ??= holdBudgetMutationLock(tokenBudgetDir)
          chmodSync(singleBoxRoot, 0o555)
        },
      })
      await expect(
        createFullRemoteBackend({
          ...baseCfg,
          spawn: fn,
          tokenBudgetDir,
          tokenBudgetWaitMs: 100,
          tokenBudgetPollMs: 10,
          singleBoxGuardDir,
        }).run(),
      ).rejects.toThrow(
        /timed out waiting.*permission|permission.*timed out waiting|timed out waiting.*EACCES|EACCES.*timed out waiting/i,
      )
    } finally {
      chmodSync(singleBoxRoot, 0o755)
      releaseLock?.()
      rmSync(tokenBudgetDir, { recursive: true, force: true })
    }
  })

  test("concurrent single-box full-remote runs FAIL-CLOSED instead of launching a second box", async () => {
    const tokenBudgetDir = allocTempDir("bench-full-concurrent-budget-")
    const singleBoxGuardDir = join(allocTempDir("bench-full-single-box-root-"), "guard")
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    let launched = 0
    let releaseFirstRun: (() => void) | undefined
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    let firstBenchStarted = false
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      const a = [...args]
      calls.push({ cmd, args: a })
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
        if (remote.includes("setsid bash -c") && remote.includes("run --swebench")) {
          firstBenchStarted = true
          return ok("LAUNCHED")
        }
        if (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ")) {
          if (firstBenchStarted && launched === 1) await firstRunDone
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (/cat ~\/report\.json/.test(remote))
          return ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
        return ok("")
      }
      if (cmd === "curl") return ok("9.9.9.9")
      return ok("")
    }

    const prevConcurrency = process.env.QUANTA_FULL_REMOTE_CONCURRENCY
    process.env.QUANTA_FULL_REMOTE_CONCURRENCY = "8"
    try {
      const first = createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        tokenBudgetDir,
        singleBoxGuardDir,
      }).run()
      expect(
        await waitForCondition(
          () => firstBenchStarted && calls.some((c) => c.args.includes("run-instances")),
          { timeoutMs: 250 },
        ),
      ).toBe(true)

      await expect(
        createFullRemoteBackend({
          ...baseCfg,
          spawn: fn,
          tokenBudgetDir,
          singleBoxGuardDir,
        }).run(),
      ).rejects.toThrow(/single-box|owner/i)

      releaseFirstRun?.()
      await first
      expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(1)
    } finally {
      if (prevConcurrency === undefined) delete process.env.QUANTA_FULL_REMOTE_CONCURRENCY
      else process.env.QUANTA_FULL_REMOTE_CONCURRENCY = prevConcurrency
    }
  })

  test("owner process stays alive through cloud-init wait; it fails EXPLICITLY instead of exiting cleanly", () => {
    const script = `
      import { pathToFileURL } from "node:url"

      const mod = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), "src/apps/bench/remote/full.ts"))}).href)
      const { createFullRemoteBackend } = mod
      const realSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((fn, _ms, ...args) => realSetTimeout(fn, 5, ...args)) as typeof setTimeout

      const spawn = async (cmd, args) => {
        const ok = (stdout) => ({ code: 0, stdout, stderr: "" })
        if (args.includes("describe-security-groups")) return ok("sg-abc")
        if (cmd === "curl") return ok("9.9.9.9")
        if (args.includes("run-instances")) return ok("i-deadbeef")
        if (args.includes("wait")) return ok("")
        if (args.includes("describe-instances")) return ok("1.2.3.4")
        if (cmd === "ssh") return ok("")
        return ok("")
      }

      try {
        await createFullRemoteBackend({
          repoDir: "/tmp/fake-repo",
          authJson: ${JSON.stringify(FULL_AUTH)},
          datasetPath: "/tmp/ds.jsonl",
          instanceIds: ["psf__requests-5414"],
          spawn,
          onDemand: true,
          maxReadyPolls: 1,
          singleBoxGuardDir: ${JSON.stringify(join(allocTempDir("bench-full-single-box-root-"), "guard"))},
          onLog: () => {},
        }).run()
        console.error("UNEXPECTED_OK")
        process.exit(99)
      } catch (err) {
        console.error(String(err))
        process.exit(17)
      }
    `
    const r = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
    })
    expect(r.status).toBe(17)
    expect(r.stderr).toContain("box never became ssh-reachable + bun-ready")
    expect(r.stderr).not.toContain("UNEXPECTED_OK")
  })

  test("writes a box-status snapshot so `box ls` can show the current phase", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
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
          s.includes('"mode":"full-remote"') &&
          s.includes('"runLogPath":"~/run.log"') &&
          s.includes('"observeDir":"~/observe"') &&
          s.includes('"instancePreview":["psf__requests-5414"]'),
      ),
    ).toBe(true)
    expect(
      statusWrites.some(
        (s) =>
          s.includes('"phase":"idle"') &&
          s.includes('"mode":"full-remote"') &&
          s.includes('"reportPath":"~/report.json"') &&
          s.includes('"predictionsPath":"~/preds.jsonl"') &&
          s.includes('"resolvedCount":1'),
      ),
    ).toBe(true)
  })

  test("generation_error report rows count as errored in the idle box snapshot, not empty", async () => {
    const { fn, calls } = mockSpawn({
      reportBody: JSON.stringify({
        perInstance: [
          {
            id: "psf__requests-5414",
            passed: false,
            turns: 0,
            patchBytes: 0,
            failure: { termination: "generation_error", signals: ["empty_patch"] },
          },
        ],
      }),
    })
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
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
          s.includes('"phase":"idle"') &&
          s.includes('"erroredCount":1') &&
          s.includes('"emptyPatchCount":0'),
      ),
    ).toBe(true)
  })

  test("default full-remote posture is the current base preset", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const benchRun = calls.find(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
    )
    expect(benchRun).toBeDefined()
    const cmd = benchRun?.args.join(" ") ?? ""
    expect(cmd).toContain("QUANTA_BENCH_PRESET=")
    expect(cmd).toContain("agentless-v3-thin")
  })

  test("box bootstrap installs pyright so LSP nav-grounding is not inert by missing binary", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const shipped = everyShippedString(calls)
    expect(shipped).toContain("uv tool install pyright")
    expect(shipped).toContain("pyright --version")
  })

  test("ALWAYS terminates the box — even when the remote run throws", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-security-groups"))
        return { code: 0, stdout: "sg-abc", stderr: "" }
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
      if (args.includes("run-instances")) return { code: 0, stdout: "i-xyz", stderr: "" }
      if (args.includes("describe-instances")) return { code: 0, stdout: "1.2.3.4", stderr: "" }
      // make every ssh FAIL (incl. the readiness probe) — the run never gets going,
      // but the box must STILL be terminated.
      if (cmd === "ssh") return { code: 1, stdout: "", stderr: "boom" }
      return { code: 0, stdout: "", stderr: "" }
    }
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const terminated = calls.some(
      (c) => c.args.includes("terminate-instances") && c.args.includes("i-xyz"),
    )
    expect(terminated).toBe(true)
  })

  test("a grade-phase termination failure preserves BOTH the primary run error and cleanup error", async () => {
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      if (args.includes("describe-security-groups"))
        return { code: 0, stdout: "sg-abc", stderr: "" }
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
      if (args.includes("run-instances")) return { code: 0, stdout: "i-xyz", stderr: "" }
      if (args.includes("describe-instances")) return { code: 0, stdout: "1.2.3.4", stderr: "" }
      if (args.includes("terminate-instances")) {
        return { code: 254, stdout: "", stderr: "terminate denied" }
      }
      if (cmd === "ssh") {
        const remote = args[args.length - 1] ?? ""
        if (remote.includes("READY")) return { code: 0, stdout: "READY", stderr: "" }
        if (remote.includes("mkdir ~/.pool-grade.lock")) {
          return { code: 0, stdout: "LOCKED", stderr: "" }
        }
        if (remote.includes("chmod 600 ~/.quanta/auth/chatgpt.json")) {
          return { code: 1, stdout: "", stderr: "ship boom" }
        }
        if (remote.includes("rmdir ~/.pool-grade.lock")) {
          return { code: 0, stdout: "", stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /primary=.*ship boom.*cleanup=.*terminate denied|cleanup=.*terminate denied.*primary=.*ship boom/i,
    )
  })

  test("a bootstrap cleanup termination failure surfaces explicitly instead of silently succeeding", async () => {
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      if (args.includes("describe-security-groups"))
        return { code: 0, stdout: "sg-abc", stderr: "" }
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
      if (args.includes("run-instances")) return { code: 0, stdout: "i-xyz", stderr: "" }
      if (args.includes("describe-instances")) return { code: 0, stdout: "1.2.3.4", stderr: "" }
      if (args.includes("terminate-instances")) {
        return { code: 254, stdout: "", stderr: "terminate denied" }
      }
      if (cmd === "ssh") return { code: 1, stdout: "", stderr: "boom" }
      return { code: 0, stdout: "", stderr: "" }
    }
    try {
      await createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()
      throw new Error("UNEXPECTED_OK")
    } catch (err) {
      const msg = String(err)
      expect(msg).toContain("box never became ssh-reachable + bun-ready")
      expect(msg).toContain("terminate")
      expect(msg).toContain("terminate denied")
      expect(msg).not.toContain("UNEXPECTED_OK")
    }
  })

  test("ssh/scp/rsync target the RESOLVED ip, never a placeholder", async () => {
    const { fn, calls } = mockSpawn() // describe-instances ⇒ 1.2.3.4
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const remoteCalls = calls.filter((c) => ["ssh", "scp", "rsync"].includes(c.cmd))
    expect(remoteCalls.length).toBeGreaterThan(0)
    const allArgs = remoteCalls.map((c) => c.args.join(" ")).join("\n")
    // R2 teeth: the literal placeholder must never reach a real command.
    expect(allArgs).not.toContain("__HOST__")
    expect(allArgs).toContain("ubuntu@1.2.3.4")
  })

  test("rsync excludes local secret stores (.env / .quanta)", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const rsync = calls.find((c) => c.cmd === "rsync")
    const a = rsync?.args.join(" ") ?? ""
    // teeth (the "Connection reset" bug): ship ONLY src/ (the monorepo's
    // top-level apps/crates/native are GBs the bench never needs), minus stale
    // *.js build mirrors — NOT the whole repo root.
    expect(a).toContain("/src/")
    expect(a).toContain("*.js")
    expect(a).toContain("node_modules")
    // .quanta (local secret store) is never shipped.
    expect(a).toContain(".quanta")
    // root config (package.json/tsconfig) goes via scp for bun install + @/* aliases.
    const scp = calls.find((c) => c.cmd === "scp" && c.args.some((x) => x.includes("package.json")))
    expect(scp).toBeDefined()
  })

  test("does NOT pin a subnet/AZ by default (capacity resilience)", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const launch = calls.find((c) => c.args.includes("run-instances"))
    expect(launch?.args.includes("--subnet-id")).toBe(false)
  })

  test("reuses a warm idle box instead of auto-launching a fresh one", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-instances")) {
        return args.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (args.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (args.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("IDLE")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (c.includes("cat ") || c.includes(".json"))
          return ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
        return ok("")
      }
      return ok("")
    }
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a warm-box lock race ABORTS instead of auto-launching a second box", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-instances")) {
        return args.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (args.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (args.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("IDLE")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("BUSY")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (c.includes("cat ") || c.includes(".json"))
          return ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
        return ok("")
      }
      return ok("")
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /POOL_BOX_BUSY|grading another run|box busy/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a warm-box grade-lock release failure ABORTS instead of silently leaving the box busy", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-instances")) {
        return args.includes("--filters") ? ok("i-warm\t9.9.9.9") : ok("9.9.9.9")
      }
      if (args.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (args.includes("terminate-instances")) return ok("")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("IDLE")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) {
          return { code: 1, stdout: "", stderr: "lock release denied" }
        }
        if (c.includes("cat ") || c.includes(".json")) {
          return ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
        }
        return ok("")
      }
      return ok("")
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /GRADE_LOCK_RELEASE_FAILED|lock release denied/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("refuses to auto-launch a second box while another quanta-bench box is already running", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-instances") && args.includes("--filters"))
        return ok("i-busy\t9.9.9.9")
      if (args.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("BUSY")
        return ok("")
      }
      return ok("")
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /refusing to launch another box/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("refuses to auto-launch while another quanta-bench box is still pending", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-instances") && args.includes("--filters")) return ok("i-pending")
      if (args.includes("run-instances")) return ok("i-SHOULD-NOT-LAUNCH")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("BUSY")
      }
      return ok("")
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /already live \(running\/pending\)/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("explicit extra-box opt-in can launch past the single-box guard", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-security-groups")) return ok("sg-abc")
      if (args.includes("describe-instances")) {
        return args.includes("--filters") ? ok("i-busy\t9.9.9.9") : ok("1.2.3.4")
      }
      if (args.includes("run-instances")) return ok("i-fresh")
      if (cmd === "ssh") {
        const c = args[args.length - 1] ?? ""
        if (c.includes("run.exit")) return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        if (c.includes("READY")) return ok("READY")
        if (c.includes("echo OK")) return ok("OK")
        if (c.includes("IDLE")) return ok("BUSY")
        if (c.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (c.includes("rmdir ~/.pool-grade.lock")) return ok("")
        if (c.includes("cat ") || c.includes(".json"))
          return ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
        return ok("")
      }
      return ok("")
    }
    await createFullRemoteBackend({ ...baseCfg, spawn: fn, allowExtraBoxes: true })
      .run()
      .catch(() => undefined)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(1)
  })

  test("dry-run exposes the single-box default patch-gen concurrency 16", async () => {
    const prevFull = process.env.QUANTA_FULL_REMOTE_CONCURRENCY
    const prevBench = process.env.QUANTA_BENCH_CONCURRENCY
    delete process.env.QUANTA_FULL_REMOTE_CONCURRENCY
    delete process.env.QUANTA_BENCH_CONCURRENCY
    try {
      const plan = await createFullRemoteBackend({ ...baseCfg, dryRun: true }).run()
      expect((plan.plan ?? []).join("\n")).toContain("patch-gen concurrency=16")
    } finally {
      if (prevFull === undefined) delete process.env.QUANTA_FULL_REMOTE_CONCURRENCY
      else process.env.QUANTA_FULL_REMOTE_CONCURRENCY = prevFull
      if (prevBench === undefined) delete process.env.QUANTA_BENCH_CONCURRENCY
      else process.env.QUANTA_BENCH_CONCURRENCY = prevBench
    }
  })

  test("falls back to the next instance type on InsufficientInstanceCapacity", async () => {
    const launchedTypes: string[] = []
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      if (args.includes("describe-security-groups"))
        return { code: 0, stdout: "sg-abc", stderr: "" }
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
      if (args.includes("run-instances")) {
        const it = args[args.indexOf("--instance-type") + 1] ?? ""
        launchedTypes.push(it)
        // first type out of capacity; second type succeeds
        if (it === "c7i.8xlarge")
          return {
            code: 254,
            stdout: "",
            stderr: "An error occurred (InsufficientInstanceCapacity)",
          }
        return { code: 0, stdout: "i-fallback", stderr: "" }
      }
      if (args.includes("describe-instances")) return { code: 0, stdout: "1.2.3.4", stderr: "" }
      if (cmd === "ssh" && args.some((a) => a.includes("run.exit")))
        return { code: 0, stdout: "0\n==XQ-RUN-EXIT-XQ==\n", stderr: "" }
      if (cmd === "ssh" && args.some((a) => a.includes("READY")))
        return { code: 0, stdout: "READY", stderr: "" }
      if (cmd === "ssh" && args.some((a) => a.includes(".json")))
        return { code: 0, stdout: "{}", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    await createFullRemoteBackend({ ...baseCfg, spawn: fn, instanceType: "c7i.8xlarge" })
      .run()
      .catch(() => undefined)
    expect(launchedTypes[0]).toBe("c7i.8xlarge") // tried requested first
    expect(launchedTypes.length).toBeGreaterThan(1) // fell back after capacity error
  })

  test("dry-run plans WITHOUT spawning anything", async () => {
    const { fn, calls } = mockSpawn()
    const plan = await createFullRemoteBackend({ ...baseCfg, spawn: fn, dryRun: true }).run()
    expect(calls.length).toBe(0) // nothing executed
    expect(JSON.stringify(plan)).toMatch(/dry|plan/i)
  })

  // The on-box `bench run` reads `--instance` as a comma-OR filter
  // (see bench-instance-filter.test.ts), so multi-instance MUST pass ALL ids.
  const runCmd = (calls: Array<{ cmd: string; args: string[] }>): string =>
    calls
      .find((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("cli.ts run")))
      ?.args.join(" ") ?? ""

  test("multi-instance subset ships ALL ids to --instance (not just the first)", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({
      ...baseCfg,
      instanceIds: ["psf__requests-5414", "django__django-12345"],
      spawn: fn,
    })
      .run()
      .catch(() => undefined)
    const cmd = runCmd(calls)
    // TEETH: regressing to a single id (or dropping the join) fails here.
    expect(cmd).toContain("psf__requests-5414")
    expect(cmd).toContain("django__django-12345")
  })

  test("shell-quotes preset/model so a crafted value can't break out of the remote command", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({
      ...baseCfg,
      preset: "evil; touch /pwned",
      model: "m`whoami`",
      spawn: fn,
    })
      .run()
      .catch(() => undefined)
    const cmd = runCmd(calls)
    // TEETH (shell injection): the metacharacters must be inside single quotes,
    // NOT bare in the command. A bare `=evil; touch` would execute the injection.
    expect(cmd).not.toContain("=evil; touch /pwned") // bare (would execute) — absent
    expect(cmd).toContain("QUANTA_BENCH_PRESET='\\''evil; touch /pwned'\\''")
    expect(cmd).not.toContain("--model m`whoami`") // bare (would execute) — absent
    expect(cmd).toContain("--model '\\''m`whoami`'\\''") // nested shell-quoted — inert
  })

  test("authorize-ingress REAL failure fails fast (not a misleading downstream error)", async () => {
    // Self-audit R2: a real authorize failure used to be swallowed → box with no
    // :22 → misleading ssh/cloud-init timeout. Fail fast at the SG stage.
    const fn: SpawnFn = async (_cmd, args): Promise<SpawnResult> => {
      if (args.includes("describe-security-groups")) return { code: 0, stdout: "sg", stderr: "" }
      if (args.includes("authorize-security-group-ingress"))
        return { code: 255, stdout: "", stderr: "An error occurred (UnauthorizedOperation)" }
      return { code: 0, stdout: "", stderr: "" }
    }
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /authoriz|ingress/i,
    )
  })

  test("does NOT return a reportPath when the box produced no report file", async () => {
    // empty report stdout ⇒ nothing saved locally; a returned path would be a
    // dangling ENOENT for the caller.
    const { fn } = mockSpawn({ emptyReport: true })
    const res = await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => ({ reportPath: "SHOULD-NOT-HAPPEN" }) as { reportPath?: string })
    expect(res.reportPath).toBeUndefined()
  })
})
