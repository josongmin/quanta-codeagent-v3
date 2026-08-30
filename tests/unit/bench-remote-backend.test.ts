/**
 * Remote grading backend tests (ADR-0536 P0).
 *
 * Hellgate-style: every external effect (ssh/scp/aws/curl) is the injected
 * `SpawnFn`. A recording mock captures the exact argv issued and returns canned
 * outputs, so we assert the WIRING (which commands, with which flags) and the
 * REPORT-PARSE mapping without touching the network.
 *
 * Red-on-injection teeth: the EC2 assertions pin the spot-market, IMDSv2
 * (HttpTokens=required), and the `shutdown -h +<ttl>` backstop — if a careless
 * edit drops any of them, these tests fail (a box that can't self-terminate or
 * runs on-demand is a real-money regression).
 */
import { describe, expect, test } from "bun:test"
import {
  parseSwebenchReport,
  type SpawnedProc,
  type SpawnFn,
  type SpawnProcFactory,
  type SpawnResult,
  spawnWithProc,
} from "../../src/apps/bench/remote/backend"
import { createEc2Backend } from "../../src/apps/bench/remote/ec2"
import { createSshBackend } from "../../src/apps/bench/remote/ssh"

interface Issued {
  readonly cmd: string
  readonly args: readonly string[]
  readonly input?: string
}

/** A canned-response recording SpawnFn. `respond` maps (cmd,args)→result. */
const makeMockSpawn = (
  respond: (cmd: string, args: readonly string[]) => SpawnResult,
): { spawn: SpawnFn; issued: Issued[] } => {
  const issued: Issued[] = []
  const spawn: SpawnFn = async (cmd, args, opts) => {
    issued.push({ cmd, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) })
    return respond(cmd, args)
  }
  return { spawn, issued }
}

const SAMPLE_REPORT = {
  total_instances: 4,
  submitted_instances: 4,
  resolved_instances: 2,
  unresolved_instances: 1,
  error_instances: 1,
  empty_patch_instances: 0,
  resolved_ids: ["repo__a-1", "repo__b-2"],
  unresolved_ids: ["repo__c-3"],
  error_ids: ["repo__d-4"],
  empty_patch_ids: [],
}

const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

/** aug-22 regression repair (`9d5369d31`): the ec2 backend's DEFAULT ami is an
 *  `ssm:` reference that `resolveLaunchAmi` dereferences into a real image id
 *  BEFORE RunInstances. Every ec2 mock below must answer that lookup — a mock
 *  that falls through to empty stdout makes the resolver throw and the launch
 *  assertions measure a box that never launched. `ssmAmi` is what the fake
 *  lookup returns; the launch argv is asserted to carry exactly this id, so the
 *  stub is wired, not decorative. The resolver's own contract (pass-through of
 *  an explicit `ami-*`, refusal on a malformed/failed lookup) is pinned by
 *  src/apps/bench/remote/box-session/ami-resolution.test.ts. */
const ssmAmi = "ami-0123456789abcdef0"
const ssmAmiLookup = (cmd: string, args: readonly string[]): boolean =>
  cmd === "aws" && args.includes("get-parameter")

const isSshReadinessProbe = (cmd: string, args: readonly string[]): boolean =>
  cmd === "ssh" && args.some((arg) => arg.includes("echo READY") || arg.includes("test -f"))

type SpawnRule = {
  readonly matches: (cmd: string, args: readonly string[]) => boolean
  readonly result: () => SpawnResult
}

const commandWith = (command: string, argument: string) => (cmd: string, args: readonly string[]) =>
  cmd === command && args.includes(argument)

/** The normal EC2 world used by launch-path tests. Exceptional provider states
 * stay in the individual tests; this fixture owns only the successful wire. */
const successfulEc2Response =
  (reportPath: string) =>
  (cmd: string, args: readonly string[]): SpawnResult => {
    const rules: readonly SpawnRule[] = [
      { matches: commandWith("curl", "ifconfig.me"), result: () => ok("203.0.113.7") },
      { matches: commandWith("aws", "describe-security-groups"), result: () => ok("None") },
      { matches: commandWith("aws", "create-security-group"), result: () => ok("sg-abc123") },
      { matches: ssmAmiLookup, result: () => ok(`${ssmAmi}\n`) },
      { matches: commandWith("aws", "run-instances"), result: () => ok("i-0deadbeef") },
      { matches: commandWith("aws", "describe-instances"), result: () => ok("1.2.3.4") },
      { matches: isSshReadinessProbe, result: () => ok("READY") },
      {
        matches: commandWith("scp", reportPath),
        result: () => {
          require("node:fs").writeFileSync(reportPath, JSON.stringify(SAMPLE_REPORT))
          return ok()
        },
      },
    ]
    return rules.find((rule) => rule.matches(cmd, args))?.result() ?? ok()
  }

// ── spawnWithProc leak-safety (FIX A) ───────────────────────────────────────

/** A fake proc whose streams/exit are controllable, recording kill + exit-await. */
interface FakeProc extends SpawnedProc {
  readonly killed: () => boolean
  readonly exitedAwaited: () => boolean
}

const makeFakeProc = (opts: {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr?: ReadableStream<Uint8Array>
  readonly exitCode?: number
}): FakeProc => {
  let killed = false
  let exitedAwaited = false
  const okStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  return {
    stdout: opts.stdout,
    stderr: opts.stderr ?? okStream(),
    get exited(): Promise<number> {
      exitedAwaited = true
      return Promise.resolve(opts.exitCode ?? 0)
    },
    kill() {
      killed = true
    },
    killed: () => killed,
    exitedAwaited: () => exitedAwaited,
  }
}

/** A stdout stream that errors mid-read (simulates a broken pipe / stream error). */
const throwingStdout = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"))
      controller.error(new Error("stdout boom"))
    },
  })

describe("spawnWithProc — leak-safe reaping on stdout-read throw (FIX A)", () => {
  test("a stdout reader throw STILL kills the child and awaits proc.exited before rethrow", async () => {
    let captured: FakeProc | undefined
    const factory: SpawnProcFactory = () => {
      captured = makeFakeProc({ stdout: throwingStdout() })
      return captured
    }
    const spawn = spawnWithProc(factory)
    await expect(
      // onData forces the streaming `for await` path, which surfaces the stream error.
      spawn("ssh", ["host", "cmd"], { onData: () => {} }),
    ).rejects.toThrow(/stdout boom/)
    expect(captured?.killed()).toBe(true) // child was reaped (no zombie)
    expect(captured?.exitedAwaited()).toBe(true) // exit was awaited (fully reaped)
  })

  test("an onData callback that throws still kills + reaps the child", async () => {
    const oneChunk = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"))
          controller.close()
        },
      })
    let captured: FakeProc | undefined
    const factory: SpawnProcFactory = () => {
      captured = makeFakeProc({ stdout: oneChunk() })
      return captured
    }
    const spawn = spawnWithProc(factory)
    await expect(
      spawn("ssh", ["host", "cmd"], {
        onData: () => {
          throw new Error("callback boom")
        },
      }),
    ).rejects.toThrow(/callback boom/)
    expect(captured?.killed()).toBe(true)
    expect(captured?.exitedAwaited()).toBe(true)
  })

  test("happy path: NO kill is issued, exit code + stdout returned (byte-identical)", async () => {
    const fullStdout = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello\nworld\n"))
          controller.close()
        },
      })
    let captured: FakeProc | undefined
    const factory: SpawnProcFactory = () => {
      captured = makeFakeProc({ stdout: fullStdout(), exitCode: 0 })
      return captured
    }
    const spawn = spawnWithProc(factory)
    const res = await spawn("ssh", ["host", "cmd"])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("hello\nworld\n")
    expect(captured?.killed()).toBe(false) // success path must NOT kill
  })
})

// ── parseSwebenchReport ────────────────────────────────────────────────────

describe("parseSwebenchReport", () => {
  test("maps a real harness report → correct id arrays", () => {
    const r = parseSwebenchReport(SAMPLE_REPORT)
    expect(r.resolved).toEqual(["repo__a-1", "repo__b-2"])
    expect(r.unresolved).toEqual(["repo__c-3"])
    expect(r.errored).toEqual(["repo__d-4"])
    expect(r.emptyPatch).toEqual([])
  })

  test("empty object → all-empty arrays (no throw)", () => {
    const r = parseSwebenchReport({})
    expect(r.resolved).toEqual([])
    expect(r.unresolved).toEqual([])
    expect(r.errored).toEqual([])
    expect(r.emptyPatch).toEqual([])
  })

  test("garbage / null / non-object → all-empty arrays (no throw)", () => {
    for (const junk of [null, undefined, 42, "nope", [], { resolved_ids: "not-an-array" }]) {
      const r = parseSwebenchReport(junk)
      expect(r.resolved).toEqual([])
      expect(r.unresolved).toEqual([])
      expect(r.errored).toEqual([])
      expect(r.emptyPatch).toEqual([])
    }
  })

  test("filters non-string entries out of id arrays (defensive)", () => {
    const r = parseSwebenchReport({ resolved_ids: ["ok", 1, null, "ok2"] })
    expect(r.resolved).toEqual(["ok", "ok2"])
  })
})

// ── ssh backend ────────────────────────────────────────────────────────────

describe("ssh backend", () => {
  /** Build an ssh backend whose remote report file is "present" + readable. */
  const setup = async () => {
    const outDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssh-test-"),
    )
    const reportName = "quanta.run-xyz.json"
    const reportPath = require("node:path").join(outDir, reportName)
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("READY")
      if (cmd === "scp" && args.some((a) => a === reportPath)) {
        // emulate the report landing locally after scp-back
        require("node:fs").writeFileSync(reportPath, JSON.stringify(SAMPLE_REPORT))
        return ok()
      }
      return ok()
    })
    const backend = createSshBackend({
      host: "ubuntu@1.2.3.4",
      keyPath: "/tmp/key.pem",
      spawn,
      sleep: async () => {},
    })
    const outcome = await backend.grade("/tmp/preds.jsonl", {
      datasetPath: "/tmp/instances.jsonl",
      runId: "run-xyz",
      outDir,
    })
    return { issued, outcome, reportPath }
  }

  test("name reflects host", () => {
    const b = createSshBackend({
      host: "ubuntu@9.9.9.9",
      keyPath: "/k",
      spawn: makeMockSpawn(() => ok()).spawn,
    })
    expect(b.name).toBe("ssh:ubuntu@9.9.9.9")
  })

  test("issues scp(preds) → scp(dataset) → ssh(run_evaluation) → scp(report back)", async () => {
    const { issued } = await setup()
    // scp preds to ~/preds.jsonl
    const scpPreds = issued.find(
      (i) =>
        i.cmd === "scp" &&
        i.args.includes("/tmp/preds.jsonl") &&
        i.args.includes("ubuntu@1.2.3.4:~/preds.jsonl"),
    )
    expect(scpPreds).toBeDefined()
    // scp dataset to ~/instances.jsonl
    const scpData = issued.find(
      (i) =>
        i.cmd === "scp" &&
        i.args.includes("/tmp/instances.jsonl") &&
        i.args.includes("ubuntu@1.2.3.4:~/instances.jsonl"),
    )
    expect(scpData).toBeDefined()
    // ssh run_evaluation streamed via bash -s; the script is in stdin
    // The run command's body is the grade script piped via `bash -s`. Since the
    // sphinx -rA fix the python entrypoint is `python ~/ra_shim.py` (run_evaluation
    // lives base64-encoded inside the shipped shim), so locate it by the stable
    // `--predictions_path` flag rather than the literal "run_evaluation".
    const sshRun = issued.find(
      (i) => i.cmd === "ssh" && i.args.includes("bash") && i.input?.includes("--predictions_path"),
    )
    expect(sshRun).toBeDefined()
    // scp report back happens last among scps
    const scpBack = issued.find(
      (i) => i.cmd === "scp" && i.args.some((a) => a.includes("quanta.run-xyz.json")),
    )
    expect(scpBack).toBeDefined()
  })

  test("run_evaluation command carries default --max_workers 4, --namespace swebench, --cache_level instance", async () => {
    const { issued } = await setup()
    const script = issued.find((i) => i.input?.includes("--predictions_path"))?.input ?? ""
    expect(script).toContain("--max_workers 4")
    expect(script).toContain("--namespace swebench")
    expect(script).toContain("--cache_level instance")
    expect(script).toContain("--run_id run-xyz")
    expect(script).toContain("--predictions_path ~/preds.jsonl")
    expect(script).toContain("--dataset_name ~/instances.jsonl")
  })

  test("run_id with `$` is substituted LITERALLY (no replace-pattern corruption)", async () => {
    // A string `.replace("RUNID", id)` interprets `$&`/`$1` in `id` as patterns;
    // the fix uses a function replacer. fanout appends `-s${i}`, so a `$`-bearing
    // run_id is plausible. TEETH: regressing to a string replacer corrupts this.
    const outDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssh-dollar-"),
    )
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("READY")
      return ok()
    })
    const backend = createSshBackend({ host: "u@h", keyPath: "/k", spawn, sleep: async () => {} })
    await backend
      .grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "run-$&-$1", outDir })
      .catch(() => undefined)
    const script = issued.find((i) => i.input?.includes("--predictions_path"))?.input ?? ""
    expect(script).toContain("--run_id run-$&-$1")
  })

  test("opts.maxWorkers overrides the default in the remote command", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("READY")
      return ok()
    })
    const outDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssh-mw-"),
    )
    require("node:fs").writeFileSync(
      require("node:path").join(outDir, "quanta.r.json"),
      JSON.stringify(SAMPLE_REPORT),
    )
    const backend = createSshBackend({ host: "u@h", keyPath: "/k", spawn, sleep: async () => {} })
    await backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r", outDir, maxWorkers: 16 })
    const script = issued.find((i) => i.input?.includes("--predictions_path"))?.input ?? ""
    expect(script).toContain("--max_workers 16")
  })

  test("ssh/scp invocations carry -i <key>, accept-new, and the fail-fast timeout triad", async () => {
    const { issued } = await setup()
    for (const i of issued.filter((x) => x.cmd === "ssh" || x.cmd === "scp")) {
      expect(i.args).toContain("-i")
      expect(i.args).toContain("/tmp/key.pem")
      expect(i.args).toContain("StrictHostKeyChecking=accept-new")
      // TEETH: without these a flaky box hangs scp/ssh indefinitely — and the
      // report-back + error-log fetch run AFTER the grade succeeded, so a hang
      // there strands a completed grade forever.
      expect(i.args).toContain("BatchMode=yes")
      expect(i.args).toContain("ConnectTimeout=15")
      expect(i.args).toContain("ServerAliveInterval=15")
    }
  })

  test("parses the retrieved report → GradeOutcome arrays", async () => {
    const { outcome, reportPath } = await setup()
    expect(outcome.reportPath).toBe(reportPath)
    expect(outcome.resolved).toEqual(["repo__a-1", "repo__b-2"])
    expect(outcome.unresolved).toEqual(["repo__c-3"])
    expect(outcome.errored).toEqual(["repo__d-4"])
    expect(outcome.emptyPatch).toEqual([])
  })

  test("throws if the report never appears (bounded polls)", async () => {
    const { spawn } = makeMockSpawn(() => ok("WAIT"))
    const backend = createSshBackend({
      host: "u@h",
      keyPath: "/k",
      spawn,
      sleep: async () => {},
      maxPolls: 3,
      pollIntervalMs: 1,
    })
    await expect(
      backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }),
    ).rejects.toThrow(/did not appear/)
  })
})

// ── ec2 backend ────────────────────────────────────────────────────────────

describe("ec2 backend", () => {
  const setup = async (overrides?: { keep?: boolean; onDemand?: boolean }) => {
    const outDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ec2-test-"),
    )
    const reportPath = require("node:path").join(outDir, "quanta.run-ec2.json")
    const { spawn, issued } = makeMockSpawn(successfulEc2Response(reportPath))
    const backend = createEc2Backend({
      spawn,
      sleep: async () => {},
      ...(overrides?.keep ? { keep: true } : {}),
      ...(overrides?.onDemand ? { onDemand: true } : {}),
    })
    const outcome = await backend.grade("/tmp/preds.jsonl", {
      datasetPath: "/tmp/instances.jsonl",
      runId: "run-ec2",
      outDir,
    })
    return { issued, outcome }
  }

  test("name is 'ec2'", () => {
    expect(createEc2Backend({ spawn: makeMockSpawn(() => ok()).spawn }).name).toBe("ec2")
  })

  test("full provisioning sequence: SG → run-instances → wait → grade(ssh) → terminate", async () => {
    const { issued } = await setup()
    const awsVerbs = issued
      .filter((i) => i.cmd === "aws")
      .map((i) => i.args.find((a) => !a.startsWith("-")) ?? i.args[1])
    // create-security-group (since describe returned None)
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("create-security-group"))).toBe(
      true,
    )
    expect(
      issued.some((i) => i.cmd === "aws" && i.args.includes("authorize-security-group-ingress")),
    ).toBe(true)
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("run-instances"))).toBe(true)
    expect(
      issued.some(
        (i) => i.cmd === "aws" && i.args.includes("wait") && i.args.includes("instance-running"),
      ),
    ).toBe(true)
    // grading delegated to ssh against ubuntu@1.2.3.4
    expect(issued.some((i) => i.cmd === "ssh" && i.args.includes("ubuntu@1.2.3.4"))).toBe(true)
    // terminate at the end
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("terminate-instances"))).toBe(true)
    expect(awsVerbs.length).toBeGreaterThan(0)
  })

  test("authorize-ingress restricts :22 to the current public IP /32", async () => {
    const { issued } = await setup()
    const auth = issued.find(
      (i) => i.cmd === "aws" && i.args.includes("authorize-security-group-ingress"),
    )
    expect(auth?.args).toContain("203.0.113.7/32")
    expect(auth?.args).toContain("22")
  })

  // Self-audit R2: a REAL authorize failure (wrong VPC / perms) used to be
  // swallowed as if it were a tolerable duplicate-rule error → the box launched
  // into an SG with no :22 and the ONLY symptom was a misleading 5-min
  // ready-poll timeout. Fail fast on the expensive path instead.
  test("authorize-ingress REAL failure fails fast (not a misleading poll-timeout)", async () => {
    const { spawn } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      if (cmd === "aws" && args.includes("authorize-security-group-ingress"))
        return { code: 255, stdout: "", stderr: "An error occurred (UnauthorizedOperation)" }
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {}, maxPolls: 2 })
    await expect(
      backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }),
    ).rejects.toThrow(/authoriz|ingress/i)
  })

  test("authorize-ingress DUPLICATE error is tolerated (rule already present)", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      if (cmd === "aws" && args.includes("authorize-security-group-ingress"))
        return { code: 255, stdout: "", stderr: "InvalidPermission.Duplicate: rule already exists" }
      if (ssmAmiLookup(cmd, args)) return ok(`${ssmAmi}\n`)
      if (cmd === "aws" && args.includes("run-instances")) return ok("i-1")
      if (cmd === "aws" && args.includes("describe-instances")) return ok("1.2.3.4")
      return ok()
    })
    const backend = createEc2Backend({
      spawn,
      sleep: async () => {},
      maxPolls: 1,
      pollIntervalMs: 1,
    })
    await backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }).catch(() => undefined)
    // TEETH: authorize did NOT throw ⇒ provisioning proceeded to run-instances.
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("run-instances"))).toBe(true)
  })

  test("non-IP curl output (proxy/error page) fails fast with a clear public-IP message", async () => {
    const { spawn } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("<html>502 Bad Gateway</html>") // not an IP
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {} })
    await expect(
      backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }),
    ).rejects.toThrow(/public IP/i)
  })

  test("falls back to next instance type on InsufficientInstanceCapacity (no AZ pin)", async () => {
    const launched: string[] = []
    const { spawn } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      if (ssmAmiLookup(cmd, args)) return ok(`${ssmAmi}\n`)
      if (cmd === "aws" && args.includes("run-instances")) {
        const it = args[args.indexOf("--instance-type") + 1] ?? ""
        launched.push(it)
        if (it === "c7i.4xlarge")
          return { code: 254, stdout: "", stderr: "InsufficientInstanceCapacity" }
        return ok("i-fallback")
      }
      if (cmd === "aws" && args.includes("describe-instances")) return ok("1.2.3.4")
      // waitForSsh probes `ssh … echo READY` and gates on /READY/ in stdout (the
      // committed ssh-ready + cloud-init poll); the old mock only handled a
      // `test -f` probe ⇒ empty stdout ⇒ 90 retries ⇒ throw. Match the real probe.
      if (cmd === "ssh" && args.some((a) => a.includes("echo READY") || a.includes("test -f")))
        return ok("READY")
      return ok()
    })
    await createEc2Backend({ spawn, sleep: async () => {} })
      .grade("/tmp/p.jsonl", { datasetPath: "/tmp/d.jsonl", runId: "r" })
      .catch(() => undefined)
    expect(launched[0]).toBe("c7i.4xlarge") // requested type (the cost-down default) tried first
    expect(launched.length).toBeGreaterThan(1) // fell back after capacity error
    // default launch must NOT pin a subnet/AZ (capacity resilience)
    // (verified separately below)
  })

  test("does NOT pin --subnet-id by default (AZ flexibility)", async () => {
    const { issued } = await setup()
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    expect(run?.args.includes("--subnet-id")).toBe(false)
  })

  // ── red-on-injection teeth: cost/security flags MUST be present ───────────

  test("run-instances uses SPOT market by default (drop this → on-demand cost regression)", async () => {
    const { issued } = await setup()
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    expect(run?.args).toContain("--instance-market-options")
    expect(run?.args.some((a) => a.includes('"MarketType":"spot"'))).toBe(true)
  })

  test("onDemand:true drops the spot market option (capacity-crunch escape hatch)", async () => {
    const { issued } = await setup({ onDemand: true })
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    // No market option ⇒ AWS default = on-demand = no reclaim. Spot reclaimed
    // grade boxes in 4–17 min during the ap-northeast-2 capacity crunch.
    expect(run?.args).not.toContain("--instance-market-options")
    expect(run?.args.some((a) => a.includes("MarketType"))).toBe(false)
    // ...rest of the hardening unchanged.
    expect(run?.args.some((a) => a.includes("HttpTokens=required"))).toBe(true)
  })

  test("run-instances enforces IMDSv2 HttpTokens=required (drop this → metadata-credential theft)", async () => {
    const { issued } = await setup()
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    expect(run?.args.some((a) => a.includes("HttpTokens=required"))).toBe(true)
    expect(run?.args.some((a) => a.includes("HttpPutResponseHopLimit=1"))).toBe(true)
  })

  test("user-data carries the self-terminate TTL backstop (drop this → runaway billing)", async () => {
    const { issued } = await setup()
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    const userData = run?.args.find((a) => a.includes("shutdown -h"))
    expect(userData).toBeDefined()
    expect(userData).toContain("shutdown -h +360")
    expect(run?.args).toContain("terminate") // instance-initiated-shutdown-behavior
  })

  // The AMI is no longer a baked id: `9d5369d31` replaced the region-local
  // `ami-04c2cdd2e17b15779` (since deleted by Canonical ⇒ every default launch
  // died at RunInstances) with an `ssm:` reference resolved just before launch.
  // The teeth therefore moved from "argv equals this literal id" to "argv equals
  // whatever the SSM lookup returned" — which pins the WIRE (lookup → --image-id)
  // that a literal could not, and stays red if anyone re-bakes a dead id.
  test("run-instances pins the SSM-resolved AMI + instance type + spot defaults", async () => {
    const { issued } = await setup()
    const runIdx = issued.findIndex((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    const ssmIdx = issued.findIndex((i) => ssmAmiLookup(i.cmd, i.args))
    expect(ssmIdx).toBeGreaterThanOrEqual(0) // the lookup HAPPENED …
    expect(ssmIdx).toBeLessThan(runIdx) // … and BEFORE the launch it feeds
    const ssm = issued[ssmIdx]
    expect(ssm?.args).toContain(
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
    )
    const run = issued[runIdx]
    // --image-id carries EXACTLY the resolved id (not the retired baked one, and
    // not the raw `ssm:` reference).
    expect(run?.args[(run?.args.indexOf("--image-id") ?? -1) + 1]).toBe(ssmAmi)
    expect(run?.args).not.toContain("ami-04c2cdd2e17b15779")
    expect(run?.args.some((a) => a.startsWith("ssm:"))).toBe(false)
    expect(run?.args).toContain("c7i.4xlarge")
    expect(run?.args).toContain("pickinstead_korea.pem")
    expect(run?.args.some((a) => a.includes('"VolumeSize":300'))).toBe(true)
  })

  // Fail-loud teeth for the resolution itself, exercised through the REAL backend
  // (not the isolated resolver unit): a lookup that answers something that is not
  // an ami id must abort BEFORE RunInstances, never launch with junk.
  test("a malformed SSM answer refuses the launch (no RunInstances with junk)", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      if (ssmAmiLookup(cmd, args)) return ok("not-an-ami\n")
      if (cmd === "aws" && args.includes("run-instances")) return ok("i-should-not-launch")
      return ok()
    })
    await expect(
      createEc2Backend({ spawn, sleep: async () => {} }).grade("/p.jsonl", {
        datasetPath: "/d.jsonl",
        runId: "r",
      }),
    ).rejects.toThrow(/AMI SSM resolution failed/)
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("run-instances"))).toBe(false)
  })

  test("keep:true skips terminate", async () => {
    const { issued } = await setup({ keep: true })
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("terminate-instances"))).toBe(
      false,
    )
  })

  test("grading result is the parsed report from the delegated ssh run", async () => {
    const { outcome } = await setup()
    expect(outcome.resolved).toEqual(["repo__a-1", "repo__b-2"])
    expect(outcome.errored).toEqual(["repo__d-4"])
  })

  test("re-uses an existing SG instead of creating (idempotent)", async () => {
    const outDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ec2-sg-"),
    )
    const reportPath = require("node:path").join(outDir, "quanta.r.json")
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-existing")
      if (ssmAmiLookup(cmd, args)) return ok(`${ssmAmi}\n`)
      if (cmd === "aws" && args.includes("run-instances")) return ok("i-1")
      if (cmd === "aws" && args.includes("describe-instances")) return ok("1.1.1.1")
      if (cmd === "ssh" && args.some((a) => a.includes("echo READY") || a.includes("test -f")))
        return ok("READY")
      if (cmd === "scp" && args.some((a) => a === reportPath)) {
        require("node:fs").writeFileSync(reportPath, JSON.stringify(SAMPLE_REPORT))
        return ok()
      }
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {} })
    await backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r", outDir })
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("create-security-group"))).toBe(
      false,
    )
    const run = issued.find((i) => i.cmd === "aws" && i.args.includes("run-instances"))
    expect(run?.args).toContain("sg-existing")
  })

  test("terminates the box even when grading throws (no leaked billable instance)", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("sg-1")
      if (ssmAmiLookup(cmd, args)) return ok(`${ssmAmi}\n`)
      if (cmd === "aws" && args.includes("run-instances")) return ok("i-leak")
      if (cmd === "aws" && args.includes("describe-instances")) return ok("1.1.1.1")
      // report never appears → ssh backend throws
      if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("WAIT")
      return ok()
    })
    const backend = createEc2Backend({
      spawn,
      sleep: async () => {},
      maxPolls: 2,
      pollIntervalMs: 1,
    })
    await expect(
      backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }),
    ).rejects.toThrow()
    expect(
      issued.some(
        (i) =>
          i.cmd === "aws" && i.args.includes("terminate-instances") && i.args.includes("i-leak"),
      ),
    ).toBe(true)
  })
})
