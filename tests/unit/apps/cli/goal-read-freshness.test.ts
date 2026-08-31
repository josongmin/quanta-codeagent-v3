import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGoalCommand } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl } from "@/apps/cli/slash/objective"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveCheckRunner,
  STRICT_VERIFIER_EXECUTION_POSTURE,
} from "@/objective"

const THREAD = "cli-fresh-read"

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

const runner: ObjectiveCheckRunner = {
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

describe("R2 — CLI /goal show reconciles before rendering", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-goal-fresh-"))
    git(dir, "init", "-q")
    writeFileSync(join(dir, "source.txt"), "v1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("an out-of-band edit removes checked completion and rearms wake once", async () => {
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
      runner,
      evidence: createWorkspaceEvidence(),
      workspaceCwd: dir,
    })
    expect((await verifier.verify(THREAD)).kind).toBe("verified")
    writeFileSync(join(dir, "source.txt"), "v2\n")
    let wakeEdges = 0
    const control = buildGoalControl(
      authority,
      THREAD,
      () => {
        wakeEdges += 1
      },
      verifier,
    )
    const output: string[] = []

    const exit = await runGoalCommand(["show"], {
      objectiveEditor: control,
      out: (text) => output.push(text),
      err: (text) => output.push(text),
      cwd: dir,
    } as SlashContext)

    expect(exit).toBe(0)
    expect(output.join("")).toContain("freshness: invalidated")
    expect(output.join("")).not.toContain("status: completed")
    expect(output.join("")).toContain("source: unverified")
    expect(authority.get(THREAD)?.successCriteria[0]?.met).toBe(false)
    expect(wakeEdges).toBe(1)
  })
})
