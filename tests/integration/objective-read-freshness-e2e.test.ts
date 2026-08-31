import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveReadout } from "@/apps/web-daemon/readout"
import { buildDaemonReadoutSources } from "@/apps/web-daemon/readout-compose"
import {
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveCheckRunner,
  type ObjectiveVerificationPort,
  STRICT_VERIFIER_EXECUTION_POSTURE,
} from "@/objective"
import { makeSnapshotLite } from "../support/session-fixtures"

const THREAD = "fresh-read"
const SNAP = makeSnapshotLite({ sessionId: THREAD, revision: 1, seq: 1 })

const git = (cwd: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const passingRunner: ObjectiveCheckRunner = {
  run: async () => ({
    exitCode: 0,
    timedOut: false,
    stdoutDigest: "sha256:stdout",
    stdoutBytes: 0,
    stderrDigest: "sha256:stderr",
    stderrBytes: 0,
    durationMs: 1,
    executionPosture: STRICT_VERIFIER_EXECUTION_POSTURE,
  }),
}

const setupVerified = async (dir: string) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create(THREAD, {
    goal: "ship current source",
    criteria: [
      {
        text: "tests pass",
        check: {
          kind: "command",
          argv: ["bun", "test"],
          timeoutMs: 1_000,
          successExitCodes: [0],
        },
      },
    ],
  })
  const capabilities = createObjectiveCapabilities(authority)
  const verifier = createObjectiveVerificationCoordinator({
    read: capabilities.read,
    verifier: capabilities.verifier,
    runner: passingRunner,
    evidence: createWorkspaceEvidence(),
    workspaceCwd: dir,
  })
  expect((await verifier.verify(THREAD)).kind).toBe("verified")
  expect(authority.get(THREAD)?.status).toBe("completed")
  return { authority, verifier }
}

describe("R2 — operator reads reconcile current-source completion", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goal-read-fresh-"))
    git(dir, "init", "-q")
    writeFileSync(join(dir, "source.txt"), "v1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("GET /readout/goal invalidates before projection and emits one wake edge", async () => {
    const { authority, verifier } = await setupVerified(dir)
    writeFileSync(join(dir, "source.txt"), "v2\n")
    let wakeEdges = 0
    const sources = buildDaemonReadoutSources({
      objectiveAuthority: authority,
      objectiveVerifier: verifier,
      threadId: THREAD,
      onGoalMutation: () => {
        wakeEdges += 1
      },
    })

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.wired).toBe(true)
    expect(result.data?.freshness).toBe("invalidated")
    expect(result.data?.objective?.status).toBe("active")
    expect(result.data?.objective?.criteria[0]?.met).toBe(false)
    expect(wakeEdges).toBe(1)
  })

  test("unresolved source evidence never projects checked completion as current", async () => {
    const { authority } = await setupVerified(dir)
    const unavailable: ObjectiveVerificationPort = {
      verify: async () => ({ kind: "source-unavailable", reason: "offline" }),
      reconcile: async () => ({ kind: "source-unavailable", reason: "offline" }),
    }
    const sources = buildDaemonReadoutSources({
      objectiveAuthority: authority,
      objectiveVerifier: unavailable,
      threadId: THREAD,
    })

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.data?.freshness).toBe("source-unavailable")
    expect(result.data?.objective?.status).toBe("completion_unconfirmed")
    expect(result.data?.objective?.criteria[0]?.met).toBe(false)
    expect(result.output).not.toContain("status completed")
  })

  test("unchanged precheck reuses the cached digest without another full capture", async () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create(THREAD, {
      goal: "ship",
      criteria: [
        {
          text: "tests",
          check: { kind: "command", argv: ["true"], timeoutMs: 1_000, successExitCodes: [0] },
        },
      ],
    })
    const capabilities = createObjectiveCapabilities(authority)
    const base = createWorkspaceEvidence()
    let captures = 0
    const verifier = createObjectiveVerificationCoordinator({
      read: capabilities.read,
      verifier: capabilities.verifier,
      runner: passingRunner,
      evidence: {
        precheck: async (cwd) => await base.precheck(cwd),
        capture: async (cwd) => {
          captures += 1
          return await base.capture(cwd)
        },
      },
      workspaceCwd: dir,
    })
    expect((await verifier.verify(THREAD)).kind).toBe("verified")
    await verifier.reconcile(THREAD)
    captures = 0

    expect((await verifier.reconcile(THREAD)).kind).toBe("fresh")
    expect(captures).toBe(0)
  })
})
