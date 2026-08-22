/**
 * SG `:22` ingress posture.
 *
 * HISTORY: jun-22 bugbash (BUG 2) scoped `:22` to the operator `<myIp>/32` from
 * the box-session path. jun-25 (USER DIRECTIVE, see
 * `box-session/ec2-lifecycle.ts`) reverted the box-session path to `0.0.0.0/0`:
 * the public-IP lookup is a network-dependent curl that, on a locally-degraded
 * network (corp proxy / endpoint-security resetting egress), returned a
 * STALE/WRONG IP — so `:22` was authorized for an address that wasn't ours and
 * every ssh/scp/rsync timed out AFTER a healthy box launch. Boxes are ephemeral,
 * key-ONLY (no password), IMDSv2, short-TTL, so world-open `:22` is safe — only
 * the private-key holder can connect — and removing the lookup drops a
 * blocked-network failure point entirely.
 *
 * TEETH:
 *  - the full-remote box-session authorize call carries the deliberate
 *    `0.0.0.0/0` (per the directive), so the box never strands ssh on a
 *    misdetected IP;
 *  - the IPv4 lookup helper (lookupCurrentPublicIpv4) — still used by the ec2.ts
 *    grade path — is exercised directly + fail-closed on a non-IPv4
 *    (proxied/HTML) response rather than emitting a bad `/32`.
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
  expires_at: "2099-01-01T00:00:00Z",
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

describe("SG :22 ingress — box-session world-opens per jun-25 directive; lookup helper fails closed", () => {
  test("full-remote provisionBox authorizes :22 with the deliberate 0.0.0.0/0 (jun-25 directive)", async () => {
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
    // TEETH: the box-session path deliberately world-opens :22 (jun-25 directive
    // — key-only ephemeral boxes; avoids a misdetected-IP ssh stall). Asserting
    // the exact value is red-on-injection: silently swapping the cidr flips this.
    expect(cidr).toBe("0.0.0.0/0")
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
