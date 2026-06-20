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
import { describe, expect, test } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { createFullRemoteBackend, stripToAccessToken } from "../../src/apps/bench/remote/full"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "REFRESH-super-secret-long-lived",
  id_token: "IDTOK-secret",
  account_id: "acct-123",
  expires_at: "2026-06-24T00:00:00Z",
})

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
  o: { emptyReport?: boolean } = {},
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
    if (args.some((a) => a.includes("cat ") || a.includes(".json")))
      return ok(o.emptyReport ? "" : JSON.stringify({ resolved_ids: ["psf__requests-5414"] }))
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

describe("full-remote executor (injected spawn — no real box/token)", () => {
  const baseCfg = {
    repoDir: "/tmp/fake-repo",
    authJson: FULL_AUTH,
    datasetPath: "/tmp/ds.jsonl",
    instanceIds: ["psf__requests-5414"],
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
