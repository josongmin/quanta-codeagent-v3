/**
 * BUG 2 (jun-22 bench-remote bugbash) — the SG `:22` ingress MUST be scoped to
 * the current public IPv4 `/32` from BOTH SG-authorizing sites, NOT `0.0.0.0/0`
 * from one of them.
 *
 * box-session.ts (full-remote / pool path) and ec2.ts (ssh/ec2 grade path) share
 * the SAME named SG `quanta-bench-sg`. ec2.ts already restricted `:22` to
 * `<myIp>/32` via a `curl -4` lookup; box-session.ts world-opened the SAME SG
 * with `0.0.0.0/0`, leaving a PERMANENT world-open rule on it. A world-open
 * ingress on a box that holds a (short-lived) LLM credential is exactly the
 * exposure the ec2 path was hardened against.
 *
 * TEETH:
 *  - the full-remote box-session authorize call must carry `<ip>/32`, never
 *    `0.0.0.0/0` (red-on-injection: reverting the cidr flips both asserts);
 *  - the IPv4 lookup is a SINGLE SHARED helper (lookupCurrentPublicIpv4) so the
 *    two sites can't drift — exercised directly + fail-closed on a non-IPv4
 *    (proxied/HTML) response rather than world-opening.
 */
import { describe, expect, test } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { lookupCurrentPublicIpv4 } from "../../src/apps/bench/remote/ec2"
import {
  createSpawnRecorder,
  ok,
  whenArgsInclude,
  whenCmd,
  whenSshRemoteIncludes,
} from "./bench-spawn-testkit"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS",
  refresh_token: "REFRESH",
  id_token: "IDTOK",
  account_id: "acct",
  expires_at: "2026-06-24T00:00:00Z",
})

const MY_IP = "203.0.113.42"

// Drive provisionBox far enough to issue the SG-authorize call, then make the
// next stage (bun-ready probe) fail FAST so we don't run the whole bootstrap.
const mockSpawnForProvision = (): ReturnType<typeof createSpawnRecorder> =>
  createSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenArgsInclude("run-instances", ok("i-box0")),
    whenArgsInclude("wait", ok("")),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
    whenArgsInclude("terminate-instances", ok("")),
    whenCmd("curl", ok(`${MY_IP}\n`)),
    // Box never becomes bun-ready ⇒ provisionBox throws after the SG step. The SG
    // authorize call (the unit under test) has already been recorded by then.
    whenSshRemoteIncludes("cloud-init", ok("")),
  )

describe("BUG 2 — SG :22 ingress is /32 from the SSOT helper, never 0.0.0.0/0", () => {
  test("full-remote provisionBox authorizes :22 with <ip>/32 (NOT 0.0.0.0/0)", async () => {
    const { provisionBox } = await import("../../src/apps/bench/remote/box-session")
    const { fn, calls } = mockSpawnForProvision()
    await provisionBox({
      repoDir: "/tmp/repo",
      authJson: FULL_AUTH,
      datasetPath: "/tmp/unused.jsonl",
      spawn: fn,
      sleep: async () => {},
      maxReadyPolls: 1,
    }).catch(() => undefined)

    const authCall = calls.find(
      (c) => c.cmd === "aws" && c.args.includes("authorize-security-group-ingress"),
    )
    expect(authCall).toBeDefined()
    const cidrIdx = (authCall?.args ?? []).indexOf("--cidr")
    const cidr = cidrIdx >= 0 ? authCall?.args[cidrIdx + 1] : undefined
    // TEETH: must be the looked-up /32, and must NEVER be world-open.
    expect(cidr).toBe(`${MY_IP}/32`)
    expect(cidr).not.toBe("0.0.0.0/0")
  })

  test("lookupCurrentPublicIpv4 returns the curl -4 IPv4 (shared SSOT helper)", async () => {
    let curlArgs: readonly string[] = []
    const spawn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
      if (cmd === "curl") curlArgs = args
      return ok(`${MY_IP}\n`)
    }
    const ip = await lookupCurrentPublicIpv4(spawn, "test")
    expect(ip).toBe(MY_IP)
    // forces IPv4 — an IPv6 address would fail the /32 cidr validation.
    expect(curlArgs).toContain("-4")
  })

  test("lookupCurrentPublicIpv4 FAILS CLOSED on a non-IPv4 (proxied/HTML) response", async () => {
    const spawn: SpawnFn = async () => ok("<html>error</html>")
    await expect(lookupCurrentPublicIpv4(spawn, "test")).rejects.toThrow(/valid public IP/i)
  })
})
