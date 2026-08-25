/**
 * GOAL-03 E2E — the verifier runtime against a REAL temp git workspace with REAL
 * commands (no LLM): exit 0 completes, exit 1 stays active, a timeout stays
 * active, a check that mutates the source tree yields stale-source and ZERO
 * receipts, a non-git workspace verifies under bounds, and source drift after a
 * completion is caught by reconcile.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import { createObjectiveAuthority, createObjectiveCapabilities } from "@/objective"

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
    runner: createObjectiveCheckRunner(),
    evidence: createWorkspaceEvidence(),
    workspaceCwd: cwd,
  })
  return { authority, coordinator }
}

describe("GOAL-03 E2E — real commands in a real git workspace", () => {
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
    const ok = build(dir, [{ text: "passes", argv: bunExit(0) }])
    expect((await ok.coordinator.verify("t")).kind).toBe("verified")
    expect(ok.authority.get("t")?.status).toBe("completed")

    const bad = build(dir, [{ text: "fails", argv: bunExit(1) }])
    const badOut = await bad.coordinator.verify("t")
    expect(badOut.kind).toBe("verified")
    if (badOut.kind === "verified") expect(badOut.failed).toBe(1)
    expect(bad.authority.get("t")?.status).toBe("active")

    const slow = build(dir, [
      { text: "hangs", argv: ["bun", "-e", "setTimeout(()=>{}, 60000)"], timeoutMs: 300 },
    ])
    const slowOut = await slow.coordinator.verify("t")
    expect(slowOut.kind).toBe("verified")
    expect(slow.authority.get("t")?.status).toBe("active")
    expect(slow.authority.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("a check that modifies the source tree yields stale-source and ZERO receipts", async () => {
    const mutating = build(dir, [
      {
        text: "mutates",
        argv: ["bun", "-e", `require("fs").writeFileSync("src.txt", "tampered\\n")`],
      },
    ])
    const out = await mutating.coordinator.verify("t")
    expect(out.kind).toBe("stale-source")
    expect(mutating.authority.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(mutating.authority.get("t")?.status).toBe("active")
  })

  test("source drift after a completion is caught by reconcile (completed -> active)", async () => {
    const { authority, coordinator } = build(dir, [{ text: "passes", argv: bunExit(0) }])
    expect((await coordinator.verify("t")).kind).toBe("verified")
    expect(authority.get("t")?.status).toBe("completed")
    expect((await coordinator.reconcile("t")).kind).toBe("fresh")
    writeFileSync(join(dir, "src.txt"), "v2\n")
    const out = await coordinator.reconcile("t")
    expect(out.kind).toBe("invalidated")
    expect(authority.get("t")?.status).toBe("active")
    // Re-verifying against the new tree completes again with a NEW digest.
    expect((await coordinator.verify("t")).kind).toBe("verified")
    expect(authority.get("t")?.status).toBe("completed")
  })

  test("a non-git workspace verifies under bounds", async () => {
    const plain = mkdtempSync(join(tmpdir(), "obj-verify-plain-"))
    try {
      writeFileSync(join(plain, "x.txt"), "x")
      const { authority, coordinator } = build(plain, [{ text: "passes", argv: bunExit(0) }])
      expect((await coordinator.verify("t")).kind).toBe("verified")
      expect(authority.get("t")?.status).toBe("completed")
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
