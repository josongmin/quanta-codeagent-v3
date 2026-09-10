/**
 * GOAL-03 E2E — coordinator mapping against real temp git workspaces. A
 * recording runner makes exit/non-zero/timeout mapping deterministic; one real
 * mutating command remains as the command + digest stale-source canary. Also
 * covers non-git evidence and reconcile invalidation after source drift.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveCheckRunner,
  STRICT_VERIFIER_EXECUTION_POSTURE,
} from "@/objective"

const git = (cwd: string, ...args: string[]): void => {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`)
}

const bunExit = (code: number): string[] => ["bun", "-e", `process.exit(${code})`]

const build = (
  cwd: string,
  checks: readonly { text: string; argv: readonly string[]; timeoutMs?: number }[],
  runner: ObjectiveCheckRunner = createObjectiveCheckRunner(),
) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create("t", {
    goal: "ship",
    criteria: checks.map((c) => ({
      text: c.text,
      check: {
        kind: "command",
        argv: [...c.argv],
        timeoutMs: c.timeoutMs ?? 20_000,
        successExitCodes: [0],
      },
    })),
  })
  const caps = createObjectiveCapabilities(authority)
  const coordinator = createObjectiveVerificationCoordinator({
    read: caps.read,
    verifier: caps.verifier,
    runner,
    evidence: createWorkspaceEvidence(),
    workspaceCwd: cwd,
  })
  return { authority, coordinator }
}

/** Coordinator mapping tests do not need another OS process: runArgv already
 * owns real exit/non-zero/timeout coverage. This runner records the exact
 * command contract while returning the requested deterministic posture. */
const recordingRunner = (
  outcomes: readonly { exitCode: number | null; timedOut?: boolean }[],
): ObjectiveCheckRunner & { readonly argv: string[][] } => {
  const pending = [...outcomes]
  const argv: string[][] = []
  return {
    argv,
    async run(input) {
      argv.push([...input.argv])
      const next = pending.shift()
      if (next === undefined) throw new Error("recording objective runner exhausted")
      return {
        exitCode: next.exitCode,
        timedOut: next.timedOut ?? false,
        stdoutDigest: "0".repeat(64),
        stdoutBytes: 0,
        stderrDigest: "0".repeat(64),
        stderrBytes: 0,
        durationMs: 0,
        executionPosture: STRICT_VERIFIER_EXECUTION_POSTURE,
      }
    },
  }
}

describe("GOAL-03 E2E — coordinator mapping + real mutation canary", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obj-verify-e2e-"))
    git(dir, "init", "-q")
    writeFileSync(join(dir, "src.txt"), "v1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("exit 0 completes; exit 1 and a timeout stay active", async () => {
    const okRunner = recordingRunner([{ exitCode: 0 }])
    const ok = build(dir, [{ text: "passes", argv: bunExit(0) }], okRunner)
    expect((await ok.coordinator.verify("t")).kind).toBe("verified")
    expect(ok.authority.get("t")?.status).toBe("completed")
    expect(okRunner.argv).toEqual([bunExit(0)])

    const badRunner = recordingRunner([{ exitCode: 1 }])
    const bad = build(dir, [{ text: "fails", argv: bunExit(1) }], badRunner)
    const badOut = await bad.coordinator.verify("t")
    expect(badOut.kind).toBe("verified")
    if (badOut.kind === "verified") expect(badOut.failed).toBe(1)
    expect(bad.authority.get("t")?.status).toBe("active")

    const slowArgv = ["bun", "-e", "setTimeout(()=>{}, 60000)"]
    const slowRunner = recordingRunner([{ exitCode: null, timedOut: true }])
    const slow = build(dir, [{ text: "hangs", argv: slowArgv, timeoutMs: 300 }], slowRunner)
    const slowOut = await slow.coordinator.verify("t")
    expect(slowOut.kind).toBe("verified")
    expect(slow.authority.get("t")?.status).toBe("active")
    expect(slow.authority.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(slowRunner.argv).toEqual([slowArgv])
  })

  test("a check that modifies the source tree yields stale-source and ZERO receipts", async () => {
    const mutating = build(dir, [
      {
        text: "mutates",
        argv: [
          "bun",
          "-e",
          `const fs=require("fs"); fs.writeFileSync("src.txt", "tampered\\n"); if(fs.readFileSync("src.txt","utf8")!=="tampered\\n") process.exit(91)`,
        ],
      },
    ])
    const out = await mutating.coordinator.verify("t")
    expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("tampered\n")
    expect(out.kind).toBe("stale-source")
    expect(mutating.authority.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(mutating.authority.get("t")?.status).toBe("active")
  })

  test("source drift after a completion is caught by reconcile (completed -> active)", async () => {
    const runner = recordingRunner([{ exitCode: 0 }, { exitCode: 0 }])
    const { authority, coordinator } = build(dir, [{ text: "passes", argv: bunExit(0) }], runner)
    expect((await coordinator.verify("t")).kind).toBe("verified")
    expect(authority.get("t")?.status).toBe("completed")
    expect(runner.argv).toEqual([bunExit(0)])
    expect((await coordinator.reconcile("t")).kind).toBe("fresh")
    writeFileSync(join(dir, "src.txt"), "v2\n")
    const out = await coordinator.reconcile("t")
    expect(out.kind).toBe("invalidated")
    expect(authority.get("t")?.status).toBe("active")
    // Re-verifying against the new tree completes again with a NEW digest.
    expect((await coordinator.verify("t")).kind).toBe("verified")
    expect(authority.get("t")?.status).toBe("completed")
    expect(runner.argv).toEqual([bunExit(0), bunExit(0)])
  })

  test("a non-git workspace verifies under bounds", async () => {
    const plain = mkdtempSync(join(tmpdir(), "obj-verify-plain-"))
    try {
      writeFileSync(join(plain, "x.txt"), "x")
      const runner = recordingRunner([{ exitCode: 0 }])
      const { authority, coordinator } = build(
        plain,
        [{ text: "passes", argv: bunExit(0) }],
        runner,
      )
      expect((await coordinator.verify("t")).kind).toBe("verified")
      expect(authority.get("t")?.status).toBe("completed")
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
