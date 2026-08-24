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
import { resolveMaxReadyPolls } from "../../src/apps/bench/remote/box-session/ec2-lifecycle"
import {
  attachBox,
  createFullRemoteBackend,
  stripToAccessToken,
} from "../../src/apps/bench/remote/full"
import {
  acquirePatchGenBudgetLease,
  readPatchGenBudgetState,
} from "../../src/apps/bench/remote/token-budget"
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
  refresh_token: "REFRESH-super-secret-long-lived",
  id_token: "IDTOK-secret",
  account_id: "acct-123",
  expires_at: "2099-01-01T00:00:00Z",
})

/** The image id the fake `aws ssm get-parameter` resolves to (see
 *  {@link createFullSpawnRecorder}). */
const SSM_RESOLVED_AMI = "ami-0123456789abcdef0"

/** Every recorder in this file goes through here so the AMI lookup the box
 *  lifecycle makes BEFORE RunInstances is answered exactly once. aug-22
 *  regression repair (`9d5369d31`): the default AMI became an `ssm:` reference
 *  that `resolveLaunchAmi` dereferences at launch time. An unanswered lookup
 *  falls through to the recorder's empty-stdout fallback, the resolver fails
 *  loud, and the run dies at provisioning — so the security/hardening teeth
 *  below were silently measuring a box that never launched. That the launch
 *  actually CONSUMES the resolved id is pinned by the "resolves the ssm: AMI
 *  reference…" test; the resolver's own pass-through / refusal contract is
 *  pinned by src/apps/bench/remote/box-session/ami-resolution.test.ts.
 */
const createFullSpawnRecorder = (...handlers: readonly SpawnHandler[]) =>
  createSpawnRecorder(whenArgsInclude("get-parameter", ok(`${SSM_RESOLVED_AMI}\n`)), ...handlers)

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

const PY_FIX_PATCH = [
  "diff --git a/app.py b/app.py",
  "--- a/app.py",
  "+++ b/app.py",
  "@@ -1 +1 @@",
  "-answer = 0",
  "+answer = 42",
].join("\n")

const writeDatasetJsonl = (prefix: string, rows: readonly Record<string, unknown>[]): string => {
  const path = join(allocTempDir(prefix), "instances.jsonl")
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const writeDatasetJsonlAtPath = (path: string, rows: readonly Record<string, unknown>[]): void => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
}

writeDatasetJsonlAtPath("/tmp/ds.jsonl", [
  { instance_id: "psf__requests-5414", patch: PY_FIX_PATCH },
  { instance_id: "django__django-12345", patch: PY_FIX_PATCH },
])

const TOKEN_BUDGET_DIR = allocTempDir("bench-full-budget-")
const DEFAULT_SINGLE_BOX_GUARD_DIR = join(allocTempDir("bench-full-single-box-root-"), "guard")
const RUN_EXIT_OK = ok("0\n==XQ-RUN-EXIT-XQ==\n")
const DEFAULT_FULL_REPORT = JSON.stringify({ resolved_ids: ["psf__requests-5414"] })

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
    expect(parsed.expires_at).toBe("2099-01-01T00:00:00Z")
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
const isFullSnapshotWrite = (remote: string): boolean =>
  remote.includes("bench-box-status.json") &&
  remote.includes("cat > ~/.quanta/bench-box-status.json.tmp") &&
  remote.includes("mv ~/.quanta/bench-box-status.json.tmp ~/.quanta/bench-box-status.json")

const mockSpawn = (
  o: {
    emptyReport?: boolean
    reportBody?: string
    beforeReportFetch?: () => void
    snapshotWriteResult?: SpawnResult
  } = {},
): { fn: SpawnFn; calls: Array<{ cmd: string; args: string[]; input?: string }> } => {
  return createFullSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenCmd("curl", ok("9.9.9.9")),
    whenArgsInclude("run-instances", ok("i-deadbeef")),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
    whenSshRemoteIncludes("setsid bash -c", ({ onData }) => {
      onData?.("[info] bench(swebench): 1 task(s)\n")
      onData?.("[PASS] psf__requests-5414 (turns=2)\n")
      return ok("LAUNCHED")
    }),
    whenSshRemote(
      (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
      RUN_EXIT_OK,
    ),
    whenSshRemote((remote) => remote.includes("bun") && remote.includes("READY"), ok("READY")),
    whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
    whenSshRemote(isFullSnapshotWrite, () => o.snapshotWriteResult ?? ok("")),
    whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
    whenSshRemoteMatches(/cat ~\/(?:runs\/[^/]+\/)?report\.json/, () => {
      o.beforeReportFetch?.()
      return ok(o.emptyReport ? "" : (o.reportBody ?? DEFAULT_FULL_REPORT))
    }),
    whenSshRemote((remote) => remote.includes("cat ") || remote.includes(".json"), ok("")),
  )
}

const everyShippedString = (calls: Array<{ args: string[]; input?: string }>): string =>
  calls.map((c) => `${c.args.join(" ")} ${c.input ?? ""}`).join("\n")
const countCalls = (
  calls: Array<{ cmd: string; args: string[] }>,
  pred: (c: { cmd: string; args: string[] }) => boolean,
): number => calls.filter(pred).length

/** Default full-remote cassettes are per-instance files under the parent of
 * `$HOME/quanta/bench-trajectory.jsonl`, fetched as one tar/base64 archive. */
const isTrajectoryArchiveFetch = (c: { cmd: string; args: string[] }): boolean =>
  c.cmd === "ssh" && c.args.some((arg) => arg.includes("tar -C $HOME/quanta/trajectories -cf - ."))

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

  // Wiring pin for the recorder's SSM responder: the launch carries NO baked AMI
  // id — it dereferences the `ssm:` default and hands RunInstances exactly what
  // came back. Without this the responder would be an unobserved convenience; a
  // launch that stopped consuming the resolved id (or shipped the raw `ssm:`
  // string, which RunInstances rejects as InvalidAMIID) turns this red.
  test("resolves the ssm: AMI reference and launches with exactly that image id", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const ssmIdx = calls.findIndex((c) => c.args.includes("get-parameter"))
    const runIdx = calls.findIndex((c) => c.args.includes("run-instances"))
    expect(ssmIdx).toBeGreaterThanOrEqual(0) // the lookup HAPPENED …
    expect(ssmIdx).toBeLessThan(runIdx) // … and BEFORE the launch it feeds
    expect(calls[ssmIdx]?.args).toContain(
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
    )
    const launch = calls[runIdx]?.args ?? []
    expect(launch[launch.indexOf("--image-id") + 1]).toBe(SSM_RESOLVED_AMI)
    expect(launch.some((a) => a.startsWith("ssm:"))).toBe(false)
  })

  // …and the refusal half, through the REAL executor (not the isolated resolver
  // unit): a lookup that answers something that is not an ami id must abort
  // BEFORE RunInstances rather than launch with junk.
  test("a malformed SSM answer refuses the launch (no RunInstances with junk)", async () => {
    // raw recorder, NOT createFullSpawnRecorder: this test owns the SSM answer.
    const { fn, calls } = createSpawnRecorder(
      whenArgsInclude("get-parameter", ok("not-an-ami\n")),
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /AMI SSM resolution failed/,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
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

  test("ALWAYS fetches the box run.log back before terminating (failure forensics)", async () => {
    // The box is destroyed at end-of-run, so its run.log — the ONLY on-box record
    // of LSP server-exit WARNs (crash/OOM), throttle/429, warm-up exhaustion — is
    // gone unless pulled here. Before the fix it was never fetched: every death
    // had to be chased by live ssh-babysitting against a box racing termination.
    // Red-on-injection: drop the runLog fetchOptionalArtifact and this fails.
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const fetchedRunLog = calls.some(
      (c) => c.cmd === "ssh" && c.args.some((a) => /cat ~\/(?:runs\/[^/]+\/)?run\.log\b/.test(a)),
    )
    expect(fetchedRunLog).toBe(true)
  })

  test("ALWAYS fetches the observe archive before terminating (trajectory forensics)", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const fetchedObserve = calls.some(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("tar -C ~/observe -cf - .")),
    )
    expect(fetchedObserve).toBe(true)
  })

  test("DEFAULT-ON: box bench-run sets QUANTA_BENCH_RECORD_TRAJECTORY (no env needed)", async () => {
    // Industry-SOTA: record the full agent conversation by default (opt-OUT, not
    // opt-in). The box gets the explicit record-env so it writes to the known
    // path the host then fetches back. Red-on-injection: regress
    // fullRemoteRecordTrajectoryEnabled to default-OFF and this fails.
    const savedRec = process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    try {
      const { fn, calls } = mockSpawn()
      await createFullRemoteBackend({ ...baseCfg, spawn: fn })
        .run()
        .catch(() => undefined)
      const benchRun = calls.find(
        (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
      )
      const cmd = benchRun?.args.join(" ") ?? ""
      expect(cmd).toContain("QUANTA_BENCH_RECORD_TRAJECTORY=")
    } finally {
      if (savedRec === undefined) delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
      else process.env.QUANTA_BENCH_RECORD_TRAJECTORY = savedRec
    }
  })

  test("DEFAULT-ON: trajectory cassette is fetched back before terminating", async () => {
    // With default-on recording EVERY full-remote run must leave a readable
    // trajectory locally — so the box's per-instance cassettes are archived
    // back before terminate (mirrors the observe/report fetch). Red-on-
    // injection: drop fetchTrajectoryFiles (or its default-on gate) and this
    // fails; changing it to a stale flat-cassette fetch also fails.
    const savedRec = process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    try {
      const { fn, calls } = mockSpawn()
      await createFullRemoteBackend({ ...baseCfg, spawn: fn })
        .run()
        .catch(() => undefined)
      const trajectoryFetchIndex = calls.findIndex(isTrajectoryArchiveFetch)
      const terminateIndex = calls.findIndex(
        (c) => c.cmd === "aws" && c.args.includes("terminate-instances"),
      )
      expect(trajectoryFetchIndex).toBeGreaterThanOrEqual(0)
      expect(terminateIndex).toBeGreaterThan(trajectoryFetchIndex)
    } finally {
      if (savedRec === undefined) delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
      else process.env.QUANTA_BENCH_RECORD_TRAJECTORY = savedRec
    }
  })

  test("OPT-OUT: QUANTA_BENCH_RECORD_TRAJECTORY=0 ⇒ box gets NO record-env, no fetch", async () => {
    const savedRec = process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    process.env.QUANTA_BENCH_RECORD_TRAJECTORY = "0"
    try {
      const { fn, calls } = mockSpawn()
      await createFullRemoteBackend({ ...baseCfg, spawn: fn })
        .run()
        .catch(() => undefined)
      const benchRun = calls.find(
        (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
      )
      const cmd = benchRun?.args.join(" ") ?? ""
      expect(cmd).not.toContain("QUANTA_BENCH_RECORD_TRAJECTORY=")
      expect(calls.some(isTrajectoryArchiveFetch)).toBe(false)
    } finally {
      if (savedRec === undefined) delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
      else process.env.QUANTA_BENCH_RECORD_TRAJECTORY = savedRec
    }
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

  test("remote bench-run pins QUANTA_PREFS_HOME to the shipped token root", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const benchRun = calls.find(
      (c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench")),
    )
    expect(benchRun).toBeDefined()
    const cmd = benchRun?.args.join(" ") ?? ""
    expect(cmd).toContain('QUANTA_PREFS_HOME="$HOME/.quanta"')
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
    let launched = 0
    let releaseFirstRun: (() => void) | undefined
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    let firstBenchStarted = false
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
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
      whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemote(
        (remote) => remote.includes("setsid bash -c") && remote.includes("run --swebench"),
        () => {
          firstBenchStarted = true
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
      whenSshRemoteMatches(/cat ~\/report\.json/, () => ok(DEFAULT_FULL_REPORT)),
    )

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

      const mod = await import(pathToFileURL(${JSON.stringify(join(import.meta.dir, "..", "..", "src/apps/bench/remote/full.ts"))}).href)
      const { createFullRemoteBackend } = mod
      const realSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((fn, _ms, ...args) => realSetTimeout(fn, 5, ...args)) as typeof setTimeout

      const spawn = async (cmd, args) => {
        const ok = (stdout) => ({ code: 0, stdout, stderr: "" })
        if (args.includes("describe-security-groups")) return ok("sg-abc")
        if (cmd === "curl") return ok("9.9.9.9")
        if (args.includes("get-parameter")) return ok(${JSON.stringify(SSM_RESOLVED_AMI)})
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
          tokenBudgetDir: ${JSON.stringify(allocTempDir("bench-full-ownerproc-budget-"))},
          tokenBudgetWaitMs: 100,
          tokenBudgetPollMs: 5,
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
    expect(
      statusWriteCmds.every(
        (cmd) =>
          cmd.includes("cat > ~/.quanta/bench-box-status.json.tmp") &&
          cmd.includes("mv ~/.quanta/bench-box-status.json.tmp ~/.quanta/bench-box-status.json"),
      ),
    ).toBe(true)
  })

  test("snapshot publish failures are logged explicitly instead of being swallowed silently", async () => {
    const logs: string[] = []
    const { fn } = mockSpawn({
      snapshotWriteResult: { code: 255, stdout: "", stderr: "ssh write failed" },
    })
    await createFullRemoteBackend({
      ...baseCfg,
      spawn: fn,
      onLog: (line) => logs.push(line),
    })
      .run()
      .catch(() => undefined)
    expect(logs.some((line) => line.includes("snapshot publish failed"))).toBe(true)
    expect(logs.some((line) => line.includes("snapshot=write-failed"))).toBe(true)
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
    expect(cmd).toContain("agentless-v3-thin-strict")
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

  test("thin-strict family fails closed when pyright grounding is inert on a fresh box", async () => {
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-strict")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote((remote) => remote.includes("bun") && remote.includes("READY"), ok("READY")),
      whenSshRemoteIncludes("command -v pyright-langserver", fail(7, "", "PYRIGHT_MISSING\n")),
    )
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        preset: "agentless-v3-thin-strict",
      }).run(),
    ).rejects.toThrow(/requires live LSP grounding/i)
    expect(
      calls.some((c) => c.args.includes("terminate-instances") && c.args.includes("i-strict")),
    ).toBe(true)
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("run --swebench"))),
    ).toBe(false)
  })

  test("thin-strict family fails closed before launch when selected tasks need non-pyright LSP grounding", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-ts-dataset-", [
      { instance_id: "acme__ts-1", patch: TS_FIX_PATCH },
    ])
    const { fn, calls } = mockSpawn()
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        datasetPath,
        instanceIds: ["acme__ts-1"],
        preset: "agentless-v3-thin-strict",
      }).run(),
    ).rejects.toThrow(/typescript-language-server/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("thin-strict family classifies pure rename gold patches before launch", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-ts-rename-dataset-", [
      {
        instance_id: "acme__ts-rename-1",
        patch: [
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
        ].join("\n"),
      },
    ])
    const { fn, calls } = mockSpawn()
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        datasetPath,
        instanceIds: ["acme__ts-rename-1"],
        preset: "agentless-v3-thin-strict",
      }).run(),
    ).rejects.toThrow(/typescript-language-server/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("thin-strict family surfaces the touched unmapped file when grounding cannot classify the task", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-unmapped-dataset-", [
      {
        instance_id: "acme__docs-1",
        patch: [
          "diff --git a/docs/readme.md b/docs/readme.md",
          "--- a/docs/readme.md",
          "+++ b/docs/readme.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      },
    ])
    const { fn, calls } = mockSpawn()
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        datasetPath,
        instanceIds: ["acme__docs-1"],
        preset: "agentless-v3-thin-strict",
      }).run(),
    ).rejects.toThrow(/docs\/readme\.md/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("thin-strict family says when a gold patch exposes no parseable diff file headers", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-noheaders-dataset-", [
      {
        instance_id: "acme__badpatch-1",
        patch: "this is not a unified diff",
      },
    ])
    const { fn, calls } = mockSpawn()
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        datasetPath,
        instanceIds: ["acme__badpatch-1"],
        preset: "agentless-v3-thin-strict",
      }).run(),
    ).rejects.toThrow(/no parseable diff file headers/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("selected instanceIds fail closed before launch when the local dataset does not contain them", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-missing-id-", [
      { instance_id: "psf__requests-5414", patch: PY_FIX_PATCH },
    ])
    const { fn, calls } = mockSpawn()
    await expect(
      createFullRemoteBackend({
        ...baseCfg,
        spawn: fn,
        datasetPath,
        instanceIds: ["missing__case-1"],
        preset: "agentless-v2",
      }).run(),
    ).rejects.toThrow(/selected instanceIds are missing/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("unreadable local dataset fails closed before launch", async () => {
    const datasetPath = join(allocTempDir("bench-full-unreadable-"), "missing.jsonl")
    const { fn, calls } = mockSpawn()
    const { instanceIds: _omitInstanceIds, ...cfgWithoutInstanceIds } = baseCfg
    await expect(
      createFullRemoteBackend({
        ...cfgWithoutInstanceIds,
        spawn: fn,
        datasetPath,
        preset: "agentless-v2",
      }).run(),
    ).rejects.toThrow(/could not be read before launch/i)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(calls.some((c) => c.cmd === "ssh")).toBe(false)
  })

  test("warm thin-strict boxes re-prove LSP grounding instead of bypassing on attach", async () => {
    let pyrightProbeCount = 0
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenSshRemoteIncludes("test -x ~/.bun/bin/bun", ok("OK\n")),
      whenSshRemoteIncludes("command -v pyright-langserver", () => {
        pyrightProbeCount += 1
        return pyrightProbeCount === 1 ? fail(7, "", "PYRIGHT_MISSING\n") : ok("pyright 1.1.350\n")
      }),
      whenSshRemote((remote) => remote.includes("bun") && remote.includes("READY"), ok("READY")),
      whenSshRemoteIncludes("~/swebench-python -c", ok("2.0.0\n")),
    )
    await attachBox(
      {
        ...baseCfg,
        spawn: fn,
        preset: "agentless-v3-thin-strict",
      },
      "i-warm",
    )
    expect(pyrightProbeCount).toBe(2)
    expect(calls.some((c) => c.cmd === "rsync")).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.cmd === "ssh" &&
          c.args.some((a) => a.includes("cd ~/quanta && ~/.bun/bin/bun install")),
      ),
    ).toBe(true)
  })

  test("warm bootstrapped box self-heals src via a CHECKSUM rsync on reuse (stale-code guard)", async () => {
    // jun-28: a reused box keeps the src rsynced at its ORIGINAL bootstrap, so a
    // code change after provision graded with STALE src (a committed grader fix
    // looked inert). attachBox must now run a checksum-mode self-heal rsync on
    // every clean reuse. Preset agentless-v2 does NOT require LSP grounding, so
    // the path is: bootstrapped-OK → (no re-bootstrap) → self-heal.
    const logs: string[] = []
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenSshRemoteIncludes("test -x ~/.bun/bin/bun", ok("OK\n")),
      // the self-heal rsync reports the box was STALE (one drifted file).
      whenCmd("rsync", ok(">f.st...... apps/bench/python-swebench.ts\n")),
    )
    await attachBox(
      { ...baseCfg, spawn: fn, preset: "agentless-v2", onLog: (m: string) => logs.push(m) },
      "i-warm",
    )
    // a CHECKSUM + itemize rsync of src/ fired — distinguishes the self-heal from
    // bootstrapBox's plain seed rsync (which carries neither flag).
    const srcHeal = calls.find(
      (c) =>
        c.cmd === "rsync" &&
        c.args.includes("--checksum") &&
        c.args.some((a) => a.endsWith("/src/")),
    )
    expect(srcHeal).toBeDefined()
    expect(srcHeal?.args).toContain("--itemize-changes")
    expect(srcHeal?.args).toContain("--delete") // orphans removed too
    // the CONFIG self-heal also fired (package.json/bun.lock/tsconfig drift class).
    const cfgHeal = calls.find(
      (c) =>
        c.cmd === "rsync" &&
        c.args.includes("--checksum") &&
        c.args.some((a) => a.endsWith("/package.json")),
    )
    expect(cfgHeal).toBeDefined()
    // a HEALTHY bootstrapped box is NOT re-bootstrapped (no bun install; the mock
    // drift is python-swebench.ts, not a dep-graph file, so no reinstall either).
    expect(
      calls.some((c) => c.cmd === "ssh" && c.args.some((a) => a.includes("bun install"))),
    ).toBe(false)
    // the stale drift surfaced to the operator (not a silent stale-code run).
    expect(logs.some((l) => l.includes("STALE") && l.includes("python-swebench.ts"))).toBe(true)
  })

  test("UNBOOTSTRAPPED box re-bootstraps (seed rsync) and SKIPS the checksum self-heal", async () => {
    // The reBootstrapped guard: when isBootstrapped is false, attachBox calls
    // bootstrapBox (which seed-syncs fresh src+config), so the reuse self-heal
    // must NOT additionally fire — that would be a redundant double-rsync. The
    // isBootstrapped probe is left unmocked → defaults to ok("") (no "OK") → false.
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
    )
    await attachBox({ ...baseCfg, spawn: fn, preset: "agentless-v2" }, "i-cold")
    // bootstrapBox ran its SEED rsync (byte-identical historical args — NO checksum).
    expect(calls.some((c) => c.cmd === "rsync" && !c.args.includes("--checksum"))).toBe(true)
    // ...and the reuse self-heal (a --checksum rsync) was SKIPPED.
    expect(calls.some((c) => c.cmd === "rsync" && c.args.includes("--checksum"))).toBe(false)
  })

  test("ALWAYS terminates the box — even when the remote run throws", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      calls.push({ cmd, args: [...args] })
      if (args.includes("describe-security-groups"))
        return { code: 0, stdout: "sg-abc", stderr: "" }
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
      if (args.includes("get-parameter"))
        return { code: 0, stdout: `${SSM_RESOLVED_AMI}\n`, stderr: "" }
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

  test("readiness poll surfaces the REAL ssh exit/stderr instead of swallowing it", async () => {
    // RCA jun-25: waitForBoxReady DISCARDED probe.code/stderr every poll and threw
    // a hardcoded "(check SG :22 / cloud-init)" guess. So a box that was provably
    // reachable + ready + world-open-SG looked IDENTICAL to a dead one — a run
    // burned ~15min × 2 retries blind-polling, and the on-call had to hand-forensic
    // (ssh + auth.log + AWS state, ~25min) to learn the readiness ssh simply never
    // connected. Now the real exit/stderr is logged per failed poll AND carried in
    // the throw. Red-on-injection: drop the stderr capture and both halves fail.
    const TIMEOUT_STDERR = "ssh: connect to host 1.2.3.4 port 22: Operation timed out"
    const logs: string[] = []
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-stuck")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("bun") && remote.includes("READY"),
        fail(255, TIMEOUT_STDERR),
      ),
    )
    let thrown: unknown
    await createFullRemoteBackend({ ...baseCfg, spawn: fn, onLog: (line) => logs.push(line) })
      .run()
      .catch((err) => {
        thrown = err
      })
    // (1) per-poll surfacing: the real ssh exit code + stderr reaches the log.
    expect(
      logs.some(
        (l) => l.includes("readiness poll") && l.includes("255") && l.includes(TIMEOUT_STDERR),
      ),
    ).toBe(true)
    // (2) the throw carries the real reason, not just the generic prefix.
    const msg = String(thrown)
    expect(msg).toContain("box never became ssh-reachable + bun-ready")
    expect(msg).toContain("255")
    expect(msg).toContain(TIMEOUT_STDERR)
  })

  test("bench-box ssh/scp/rsync DISABLE host-key checking (ephemeral recycled-IP boxes) — never accept-new", async () => {
    // RCA jun-25 (the ROOT cause): `StrictHostKeyChecking=accept-new` REFUSES a
    // fresh box that landed on a RECYCLED public IP already in ~/.ssh/known_hosts
    // with a stale key — instant exit 255 BEFORE auth, no TCP retry — which showed
    // up as "box never became ssh-reachable" on a box that was in fact fully up
    // (reachable via `ssh -o StrictHostKeyChecking=no`). Bench boxes are identified
    // by the AWS instance API, not a host key, so the check is pure liability + it
    // POLLUTES the real known_hosts (1400+ stale entries — what seeds the recycling
    // collisions). All three transports must connect the SAME safe way. Red-on-
    // injection: revert to accept-new or drop /dev/null and this fails. (The
    // sibling ec2.ts readiness path already does exactly this.)
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const sshCall = calls.find((c) => c.cmd === "ssh")
    expect(sshCall).toBeDefined()
    expect(sshCall?.args).toContain("StrictHostKeyChecking=no")
    expect(sshCall?.args).toContain("UserKnownHostsFile=/dev/null")
    expect(sshCall?.args).toContain("BatchMode=yes")
    expect(sshCall?.args).not.toContain("StrictHostKeyChecking=accept-new")
    // The rsync transport + scp must match — else a recycled-IP stale key refuses
    // the bootstrap copy AFTER readiness already succeeded.
    expect(calls.find((c) => c.cmd === "rsync")?.args.join(" ")).toContain(
      "UserKnownHostsFile=/dev/null",
    )
    expect(calls.find((c) => c.cmd === "scp")?.args).toContain("UserKnownHostsFile=/dev/null")
  })

  test("readiness FAILS FAST on a LOCAL-misconfig ssh error instead of polling the full window", async () => {
    // RCA jun-25: a box doomed by LOCAL misconfig (wrong/unreadable key path, bad
    // ssh option) fails INSTANTLY + identically every poll — yet the loop polled
    // the full window (~15min) × 2 retries (~30min wasted) before giving up. Abort
    // after a few consecutive hits. Red-on-injection: drop the terminal
    // classification and this exhausts the 30 polls instead of bailing after ~3.
    let probes = 0
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-doomed")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("bun") && remote.includes("READY"),
        () => {
          probes += 1
          return fail(
            255,
            "Warning: Identity file ~/Downloads/key.pem not accessible: No such file or directory.",
          )
        },
      ),
    )
    await expect(
      createFullRemoteBackend({ ...baseCfg, spawn: fn, maxReadyPolls: 30 }).run(),
    ).rejects.toThrow(/NON-RECOVERABLE|not accessible/i)
    expect(probes).toBeGreaterThanOrEqual(3) // gave it a few tries (not a one-off fluke)
    expect(probes).toBeLessThan(30) // ...but did NOT exhaust the full readiness window
  })

  test("a transient AUTH error (Permission denied) keeps polling — cloud-init key-injection window", async () => {
    // Audit catch: "Permission denied" is NOT terminal. There is a real window
    // where sshd is up but cloud-init hasn't yet written the launch key into the
    // ubuntu user's authorized_keys, so a HEALTHY box transiently rejects auth.
    // Classifying it terminal would kill boxes mid-bootstrap (the exact early-boot
    // transient the 90-poll window exists to tolerate). Red-on-injection: add
    // "Permission denied" back to SSH_TERMINAL_ERROR and `probes` drops below 5.
    let probes = 0
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-keyinject")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("bun") && remote.includes("READY"),
        () => {
          probes += 1
          return fail(255, "ubuntu@1.2.3.4: Permission denied (publickey).")
        },
      ),
    )
    let thrown: unknown
    await createFullRemoteBackend({ ...baseCfg, spawn: fn, maxReadyPolls: 5 })
      .run()
      .catch((err) => {
        thrown = err
      })
    expect(probes).toBe(5) // polled the FULL window — auth error is NOT fast-failed
    expect(String(thrown)).not.toContain("NON-RECOVERABLE")
  })

  test("a TRANSIENT connect error keeps polling the full window (slow boot is not aborted)", async () => {
    // The flip side of fail-fast: "Connection refused" during a slow cloud-init
    // MUST NOT be misclassified as terminal, else a healthy-but-slow box gets
    // killed mid-boot. Polls the full (small) window, then gives the generic
    // not-ready error — never the NON-RECOVERABLE one.
    let probes = 0
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-slowboot")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemote(
        (remote) => remote.includes("bun") && remote.includes("READY"),
        () => {
          probes += 1
          return fail(255, "ssh: connect to host 1.2.3.4 port 22: Connection refused")
        },
      ),
    )
    let thrown: unknown
    await createFullRemoteBackend({ ...baseCfg, spawn: fn, maxReadyPolls: 5 })
      .run()
      .catch((err) => {
        thrown = err
      })
    expect(probes).toBe(5) // polled the FULL window — not aborted as terminal
    const msg = String(thrown)
    expect(msg).toContain("box never became ssh-reachable + bun-ready")
    expect(msg).not.toContain("NON-RECOVERABLE")
  })

  test("a grade-phase termination failure preserves BOTH the primary run error and cleanup error", async () => {
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-xyz")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", fail(254, "terminate denied")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("chmod 600 ~/.quanta/auth/chatgpt.json", fail(1, "ship boom")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /primary=.*ship boom.*cleanup=.*terminate denied|cleanup=.*terminate denied.*primary=.*ship boom/i,
    )
  })

  test("a bootstrap cleanup termination failure surfaces explicitly instead of silently succeeding", async () => {
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ok("i-xyz")),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenArgsInclude("terminate-instances", fail(254, "terminate denied")),
      whenSshRemote(() => true, fail(1, "boom")),
    )
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
    const { fn, calls } = createFullSpawnRecorder(
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
      whenSshRemoteIncludes("IDLE", ok("IDLE")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemote(
        (remote) => remote.includes("cat ") || remote.includes(".json"),
        ok(DEFAULT_FULL_REPORT),
      ),
    )
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a warm-box lock race ABORTS instead of auto-launching a second box", async () => {
    const { fn, calls } = createFullSpawnRecorder(
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
      whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
      whenSshRemoteIncludes("IDLE", ok("IDLE")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("BUSY")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemote(
        (remote) => remote.includes("cat ") || remote.includes(".json"),
        ok(DEFAULT_FULL_REPORT),
      ),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /POOL_BOX_BUSY|grading another run|box busy/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("a warm-box grade-lock release failure ABORTS instead of silently leaving the box busy", async () => {
    const { fn, calls } = createFullSpawnRecorder(
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
      whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
      whenSshRemoteIncludes("IDLE", ok("IDLE")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", fail(1, "lock release denied")),
      whenSshRemote(
        (remote) => remote.includes("cat ") || remote.includes(".json"),
        ok(DEFAULT_FULL_REPORT),
      ),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /GRADE_LOCK_RELEASE_FAILED|lock release denied/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
    expect(countCalls(calls, (c) => c.args.includes("terminate-instances"))).toBe(0)
  })

  test("refuses to auto-launch a second box while another quanta-bench box is already running", async () => {
    const { fn, calls } = createFullSpawnRecorder(
      when(
        ({ args }) => args.includes("describe-instances") && args.includes("--filters"),
        ok("i-busy\t9.9.9.9"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("IDLE", ok("BUSY")),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /refusing to launch another box/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("refuses to auto-launch while another quanta-bench box is still pending", async () => {
    const { fn, calls } = createFullSpawnRecorder(
      when(
        ({ args }) => args.includes("describe-instances") && args.includes("--filters"),
        ok("i-pending"),
      ),
      whenArgsInclude("run-instances", ok("i-SHOULD-NOT-LAUNCH")),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("IDLE", ok("BUSY")),
    )
    await expect(createFullRemoteBackend({ ...baseCfg, spawn: fn }).run()).rejects.toThrow(
      /already live \(running\/pending\)/i,
    )
    expect(countCalls(calls, (c) => c.args.includes("run-instances"))).toBe(0)
  })

  test("explicit extra-box opt-in can launch past the single-box guard", async () => {
    const { fn, calls } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("describe-instances", ({ args }) =>
        ok(args.includes("--filters") ? "i-busy\t9.9.9.9" : "1.2.3.4"),
      ),
      whenArgsInclude("run-instances", ok("i-fresh")),
      whenSshRemote(
        (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
        RUN_EXIT_OK,
      ),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("echo OK", ok("OK")),
      whenSshRemoteIncludes("IDLE", ok("BUSY")),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", ok("")),
      whenSshRemote(
        (remote) => remote.includes("cat ") || remote.includes(".json"),
        ok(DEFAULT_FULL_REPORT),
      ),
    )
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
    const { fn } = createFullSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("9.9.9.9")),
      whenArgsInclude("run-instances", ({ args }) => {
        const instanceType = args[args.indexOf("--instance-type") + 1] ?? ""
        launchedTypes.push(instanceType)
        return instanceType === "c7i.8xlarge"
          ? fail(254, "An error occurred (InsufficientInstanceCapacity)")
          : ok("i-fallback")
      }),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenSshRemoteIncludes("run.exit", RUN_EXIT_OK),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemote((remote) => remote.includes(".json"), ok("{}")),
    )
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

  test("launch tags derive selection from custom-corpus `id` rows when no explicit instanceIds are passed", async () => {
    const datasetPath = writeDatasetJsonl("bench-full-custom-id-", [
      { id: "custom__case-1", goldPatch: PY_FIX_PATCH },
    ])
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({
      repoDir: baseCfg.repoDir,
      authJson: baseCfg.authJson,
      datasetPath,
      spawn: fn,
      tokenBudgetDir: baseCfg.tokenBudgetDir,
      tokenBudgetWaitMs: baseCfg.tokenBudgetWaitMs,
      tokenBudgetPollMs: baseCfg.tokenBudgetPollMs,
      sleep: baseCfg.sleep,
      maxReadyPolls: baseCfg.maxReadyPolls,
      singleBoxGuardDir: baseCfg.singleBoxGuardDir,
    })
      .run()
      .catch(() => undefined)
    const launch = calls.find((c) => c.args.includes("run-instances"))
    expect(launch).toBeDefined()
    expect(launch?.args.join(" ")).toContain("Key=QuantaSelection,Value=custom__case-1")
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
    const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
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

// jun-26 (absorbed from salvage/a81b-bench-boxloss): the readiness window is now
// operator-tunable WITHOUT a code edit. Precedence: test-seam cfg.maxReadyPolls >
// QUANTA_FULL_REMOTE_READY_POLLS env > default(90). Default-safe: garbage / 0 /
// negative ⇒ default (a bad value must never shorten the window to 0 or throw).
describe("resolveMaxReadyPolls — operator-tunable readiness window", () => {
  const KEY = "QUANTA_FULL_REMOTE_READY_POLLS"
  const withEnv = (val: string | undefined, run: () => void): void => {
    const prev = process.env[KEY]
    if (val === undefined) delete process.env[KEY]
    else process.env[KEY] = val
    try {
      run()
    } finally {
      if (prev === undefined) delete process.env[KEY]
      else process.env[KEY] = prev
    }
  }
  const cfg = (over: { maxReadyPolls?: number }) =>
    over as Parameters<typeof resolveMaxReadyPolls>[0]

  test("unset env ⇒ default 90", () => {
    withEnv(undefined, () => expect(resolveMaxReadyPolls(cfg({}))).toBe(90))
  })

  test("env knob widens the window", () => {
    withEnv("180", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(180))
  })

  test("test-seam cfg.maxReadyPolls WINS over the env knob (deterministic tests)", () => {
    withEnv("180", () => expect(resolveMaxReadyPolls(cfg({ maxReadyPolls: 3 }))).toBe(3))
  })

  test("garbage / zero / negative ⇒ default (never 0, never throws)", () => {
    withEnv("abc", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(90))
    withEnv("0", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(90))
    withEnv("-5", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(90))
    withEnv("", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(90))
  })

  test("fractional ⇒ floored", () => {
    withEnv("120.9", () => expect(resolveMaxReadyPolls(cfg({}))).toBe(120))
  })
})
