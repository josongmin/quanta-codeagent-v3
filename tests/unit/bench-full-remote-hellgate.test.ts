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
  test("keeps access_token + account fields, DROPS refresh_token & id_token", () => {
    const out = stripToAccessToken(FULL_AUTH)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.access_token).toBe("ACCESS-xyz")
    expect(parsed.account_id).toBe("acct-123")
    expect(parsed.expires_at).toBe("2026-06-24T00:00:00Z")
    // TEETH: the long-lived secrets are gone from BOTH the keys and the text.
    expect("refresh_token" in parsed).toBe(false)
    expect("id_token" in parsed).toBe(false)
    expect(out).not.toContain("REFRESH-super-secret-long-lived")
    expect(out).not.toContain("IDTOK-secret")
  })
})

/** Mock spawn recording every command + its stdin input. */
const mockSpawn = (): {
  fn: SpawnFn
  calls: Array<{ cmd: string; args: string[]; input?: string }>
} => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  const fn: SpawnFn = async (cmd, args, opts): Promise<SpawnResult> => {
    calls.push({
      cmd,
      args: [...args],
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    })
    // Give run-instances / describe an instance id + ip; report fetch returns a report.
    if (args.includes("describe-security-groups")) return { code: 0, stdout: "sg-abc", stderr: "" }
    if (cmd === "curl") return { code: 0, stdout: "9.9.9.9", stderr: "" }
    if (args.includes("run-instances")) return { code: 0, stdout: "i-deadbeef", stderr: "" }
    if (args.includes("describe-instances")) return { code: 0, stdout: "1.2.3.4", stderr: "" }
    // cloud-init readiness probe
    if (cmd === "ssh" && args.some((a) => a.includes("bun") && a.includes("READY")))
      return { code: 0, stdout: "READY", stderr: "" }
    if (cmd === "ssh" && args.some((a) => a.includes("cat ") || a.includes(".json")))
      return {
        code: 0,
        stdout: JSON.stringify({ resolved_ids: ["psf__requests-5414"] }),
        stderr: "",
      }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { fn, calls }
}

const everyShippedString = (calls: Array<{ args: string[]; input?: string }>): string =>
  calls.map((c) => `${c.args.join(" ")} ${c.input ?? ""}`).join("\n")

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
    expect(a).toContain(".env")
    expect(a).toContain(".quanta")
  })

  test("does NOT pin a subnet/AZ by default (capacity resilience)", async () => {
    const { fn, calls } = mockSpawn()
    await createFullRemoteBackend({ ...baseCfg, spawn: fn })
      .run()
      .catch(() => undefined)
    const launch = calls.find((c) => c.args.includes("run-instances"))
    expect(launch?.args.includes("--subnet-id")).toBe(false)
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
})
