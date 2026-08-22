/**
 * Bugbash jun-20 — box-session group (#23 / #24 / #26).
 *
 * Teeth for three audited findings in src/apps/bench/remote/box-session.ts:
 *   #23 runId / artifactSuffix flows UNQUOTED into remote ssh box paths with no
 *       boundary sanitization → assert a shell-metachar suffix is REJECTED at the
 *       gradeChunkOnBox boundary BEFORE any remote command runs (defense-in-depth).
 *   #24 stripToAccessToken whitelist must keep the non-secret fields the box
 *       loader actually needs (access_token / account_id / expires_at) and NEVER
 *       ship the long-lived refresh_token / id_token.
 *   #26 the pure remote-verdict parsing concern is now an exported, directly-
 *       tested seam (parseVerdicts / verdictCount / emptyVerdicts).
 *
 * Every assertion fails if its fix is reverted (red-on-injection).
 */
import { describe, expect, test } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import {
  assertSafeArtifactSuffix,
  type BoxSession,
  emptyVerdicts,
  type GradeChunkParams,
  gradeChunkOnBox,
  parseVerdicts,
  stripToAccessToken,
  verdictCount,
} from "../../src/apps/bench/remote/box-session"

const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

/** A fake box session that RECORDS every ssh command + every raw spawn argv, so a
 *  test can prove whether a remote command was ever issued (the #23 boundary). */
const makeRecordingSession = (): {
  session: BoxSession
  sshCommands: string[]
  spawnArgs: string[][]
} => {
  const sshCommands: string[] = []
  const spawnArgs: string[][] = []
  const spawn: SpawnFn = (_cmd, args) => {
    spawnArgs.push([...args])
    return Promise.resolve(ok())
  }
  const session: BoxSession = {
    iid: "i-deadbeef",
    ip: "203.0.113.10",
    host: "ubuntu@203.0.113.10",
    keyPath: "/tmp/key.pem",
    region: "ap-northeast-2",
    spawn,
    log: () => {},
    ssh: (remoteCmd) => {
      sshCommands.push(remoteCmd)
      return Promise.resolve(ok())
    },
    aws: () => Promise.resolve(ok()),
    terminate: async () => {},
  }
  return { session, sshCommands, spawnArgs }
}

const baseParams = (artifactSuffix: string): GradeChunkParams => ({
  datasetPath: "/tmp/instances.jsonl",
  authJson: JSON.stringify({ access_token: "A", expires_at: "2099-01-01T00:00:00Z" }),
  preset: "agentless-v1",
  model: "gpt-5.4",
  concurrency: 1,
  artifactSuffix,
  recordTrajectory: false,
  forwardedBenchEnv: "",
  // aug-22 HIGH-1: the chunk's TYPED family (was derived from the launching
  // process's ambient env inside buildBenchCommand).
  datasetFamily: "verified",
})

const RUN_EXIT_OK = ok("0\n==XQ-RUN-EXIT-XQ==\n")

const sshResponseForScrubTest = (remoteCmd: string): SpawnResult => {
  if (remoteCmd.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
  if (remoteCmd.includes("rmdir ~/.pool-grade.lock")) return ok("")
  if (remoteCmd.includes("setsid bash -c")) return ok("LAUNCHED")
  if (remoteCmd.includes("run.exit") || remoteCmd.includes("XQ-RUN-EXIT-XQ")) return RUN_EXIT_OK
  if (remoteCmd.includes("cat ~/report.json")) {
    return ok(JSON.stringify({ resolved_ids: ["fixture__clean"] }))
  }
  if (remoteCmd.includes("tail -60 ~/run.log")) return ok("")
  if (remoteCmd.includes("grep -aiE")) return ok("")
  return ok("")
}

describe("#23 runId / artifactSuffix shell-injection boundary", () => {
  test("rejects a suffix carrying a command-substitution metachar", () => {
    expect(() => assertSafeArtifactSuffix("run$(rm -rf ~)id")).toThrow(/unsafe artifact suffix/)
  })

  test("rejects a suffix with a path-separator (would escape the runId dir)", () => {
    expect(() => assertSafeArtifactSuffix("run/../../etc")).toThrow(/unsafe artifact suffix/)
  })

  test("rejects a suffix with a whitespace / semicolon command terminator", () => {
    expect(() => assertSafeArtifactSuffix("run; reboot")).toThrow(/unsafe artifact suffix/)
  })

  test("rejects a dot-only component (`.`/`..`) that escapes the runId dir", () => {
    // `..` matches the char-class SAFE_SUFFIX_RE yet is a path component:
    // `~/runs/../instances.jsonl` escapes. Reverting the dot-only guard makes
    // these pass — a real traversal hole the regex alone does not close.
    expect(() => assertSafeArtifactSuffix("..")).toThrow(/unsafe artifact suffix/)
    expect(() => assertSafeArtifactSuffix(".")).toThrow(/unsafe artifact suffix/)
    expect(() => assertSafeArtifactSuffix("...")).toThrow(/unsafe artifact suffix/)
  })

  test("accepts a normal filesystem-safe runId (incl. a leading-dot name)", () => {
    expect(() => assertSafeArtifactSuffix("pool-2026-06-20.chunk_3")).not.toThrow()
    // a dotfile-style name is still safe (not dot-ONLY)
    expect(() => assertSafeArtifactSuffix(".hidden-run")).not.toThrow()
  })

  test("gradeChunkOnBox throws on an unsafe suffix BEFORE issuing any remote command", async () => {
    const { session, sshCommands, spawnArgs } = makeRecordingSession()
    await expect(gradeChunkOnBox(session, baseParams("evil`whoami`"))).rejects.toThrow(
      /unsafe artifact suffix/,
    )
    // Red-on-injection: without the boundary guard, the suffix would reach the
    // box (the grade lock + scp + bench command all run) — so NO ssh/scp must
    // have been issued once the guard rejects.
    expect(sshCommands).toEqual([])
    expect(spawnArgs).toEqual([])
  })

  test("gradeChunkOnBox scrubs stale fixed-path artifacts BEFORE launching the bench", async () => {
    const sshCommands: string[] = []
    const spawn: SpawnFn = async () => ok()
    const session: BoxSession = {
      iid: "i-clean",
      ip: "203.0.113.11",
      host: "ubuntu@203.0.113.11",
      keyPath: "/tmp/key.pem",
      region: "ap-northeast-2",
      spawn,
      log: () => {},
      ssh: async (remoteCmd) => {
        sshCommands.push(remoteCmd)
        return sshResponseForScrubTest(remoteCmd)
      },
      aws: async () => ok("running"),
      terminate: async () => {},
    }

    const result = await gradeChunkOnBox(session, {
      ...baseParams("clean"),
      preset: "baseline",
      recordTrajectory: true,
    })

    expect(result.resolved).toEqual(["fixture__clean"])
    // The scrub command's exact middle drifts (a `rm -rf <trajDir>;` segment is
    // inserted when recordTrajectory:true), so pin the stable prefix + the
    // `mkdir -p ~/observe` tail rather than the full brittle string. Both fence
    // the scrub-before-launch ordering without re-pinning every drifting token.
    const scrubIndex = sshCommands.findIndex(
      (cmd) => cmd.startsWith("rm -f ~/preds.jsonl") && cmd.includes("mkdir -p ~/observe"),
    )
    const launchIndex = sshCommands.findIndex((cmd) => cmd.includes("setsid bash -c"))
    expect(scrubIndex).toBeGreaterThanOrEqual(0)
    expect(launchIndex).toBeGreaterThan(scrubIndex)
  })

  test("gradeChunkOnBox rejects an expired auth token BEFORE dataset upload or remote launch", async () => {
    const sshCommands: string[] = []
    const spawnArgs: string[][] = []
    const spawn: SpawnFn = async (_cmd, args) => {
      spawnArgs.push([...args])
      return ok()
    }
    const session: BoxSession = {
      iid: "i-expired",
      ip: "203.0.113.12",
      host: "ubuntu@203.0.113.12",
      keyPath: "/tmp/key.pem",
      region: "ap-northeast-2",
      spawn,
      log: () => {},
      ssh: async (remoteCmd) => {
        sshCommands.push(remoteCmd)
        return sshResponseForScrubTest(remoteCmd)
      },
      aws: async () => ok("running"),
      terminate: async () => {},
    }
    await expect(
      gradeChunkOnBox(session, {
        ...baseParams("expired-auth"),
        authJson: JSON.stringify({
          access_token: "ACCESS-expired",
          expires_at: "2020-01-01T00:00:00Z",
        }),
      }),
    ).rejects.toThrow(/expired or too close to expiry/)

    expect(spawnArgs).toEqual([])
    expect(sshCommands.some((cmd) => cmd.includes("chatgpt.json"))).toBe(false)
    expect(sshCommands.some((cmd) => cmd.includes("setsid bash -c"))).toBe(false)
  })
})

describe("#24 stripToAccessToken whitelist keeps needed fields, never secrets", () => {
  const FULL = JSON.stringify({
    access_token: "ACCESS-xyz",
    refresh_token: "REFRESH-super-secret-long-lived",
    id_token: "IDTOK-secret",
    account_id: "acct-123",
    expires_at: "2099-01-01T00:00:00Z",
    plan_type: "pro",
    last_refresh: "2026-06-19T00:00:00Z",
  })

  test("keeps the non-secret fields the box actually needs", () => {
    const shipped = JSON.parse(stripToAccessToken(FULL)) as Record<string, unknown>
    // access_token: the bearer; account_id: chatgpt-account-id header; expires_at:
    // loader-required + drives the pre-refresh skip. All MUST survive.
    expect(shipped.access_token).toBe("ACCESS-xyz")
    expect(shipped.account_id).toBe("acct-123")
    expect(shipped.expires_at).toBe("2099-01-01T00:00:00Z")
  })

  test("NEVER ships the long-lived refresh_token / id_token (only REDACTED)", () => {
    const raw = stripToAccessToken(FULL)
    expect(raw).not.toContain("REFRESH-super-secret-long-lived")
    expect(raw).not.toContain("IDTOK-secret")
    const shipped = JSON.parse(raw) as Record<string, unknown>
    expect(shipped.refresh_token).toBe("REDACTED-not-shipped-to-remote")
    expect(shipped.id_token).toBe("REDACTED-not-shipped-to-remote")
  })

  test("fails fast when expires_at is absent (the box loader hard-requires it)", () => {
    // Red-on-injection: drop the new expires_at guard and this token would ship,
    // then throw "missing/invalid field: expires_at" on the box AFTER a full
    // (expensive) provision cycle instead of locally.
    const noExpiry = JSON.stringify({ access_token: "ACCESS-xyz", account_id: "acct-123" })
    expect(() => stripToAccessToken(noExpiry)).toThrow(/no usable expires_at/)
  })

  test("still fails fast on a missing access_token (existing guard intact)", () => {
    expect(() => stripToAccessToken(JSON.stringify({ expires_at: "x" }))).toThrow(
      /no usable access_token/,
    )
  })
})

describe("#26 remote verdict-parsing seam (pure, exported, directly tested)", () => {
  test("parseVerdicts maps the official swebench harness report shape into id-sets", () => {
    const report = JSON.stringify({
      resolved_ids: ["a", "b"],
      unresolved_ids: ["c"],
      error_ids: ["d"],
      empty_patch_ids: [],
    })
    const v = parseVerdicts(report)
    expect(v.resolved).toEqual(["a", "b"])
    expect(v.unresolved).toEqual(["c"])
    expect(v.errored).toEqual(["d"])
    expect(v.emptyPatch).toEqual([])
    // verdictCount sums every set — the no-verdict / box-loss signal.
    expect(verdictCount(v)).toBe(4)
  })

  test("parseVerdicts is tolerant of an invalid/empty report (yields emptyVerdicts)", () => {
    expect(parseVerdicts("not json {{{")).toEqual(emptyVerdicts())
    expect(verdictCount(parseVerdicts(""))).toBe(0)
  })
})
