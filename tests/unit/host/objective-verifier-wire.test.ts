/**
 * GOAL-03 hellgate — verifier runtime: workspace evidence, coordinator, runner.
 *
 * Git evidence is exercised on a REAL temp repository (content / mode / untracked
 * / symlink changes alter the digest deterministically; caps fail closed). The
 * coordinator is driven with a fake runner so drift, contention, cancellation and
 * runner failure are deterministic; the authority is real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import {
  type CheckRunInput,
  type CheckRunResult,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  isEvidenceFailure,
  type ObjectiveCheckRunner,
  type WorkspaceEvidence,
  type WorkspaceEvidenceFailure,
  type WorkspaceEvidencePort,
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

const digestOf = async (port: WorkspaceEvidencePort, cwd: string): Promise<string> => {
  const e = await port.capture(cwd)
  if (isEvidenceFailure(e)) throw new Error(`evidence failure: ${e.kind} ${e.reason}`)
  return e.sourceDigest
}

describe("GOAL-03 — git workspace evidence", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obj-evidence-"))
    git(dir, "init", "-q")
    writeFileSync(join(dir, "a.txt"), "alpha\n")
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n.cache/\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("deterministic across captures; ignored paths do not participate", async () => {
    const port = createWorkspaceEvidence({ now: () => 1 })
    const first = await digestOf(port, dir)
    expect(first.startsWith("quanta-workspace-manifest-v1:")).toBe(true)
    expect(await digestOf(port, dir)).toBe(first)
    writeFileSync(join(dir, "ignored.txt"), "cache noise")
    mkdirSync(join(dir, ".cache"))
    writeFileSync(join(dir, ".cache", "x.tsbuildinfo"), "{}")
    expect(await digestOf(port, dir)).toBe(first)
  })

  test("content / untracked / mode / symlink / deletion changes alter the digest", async () => {
    const port = createWorkspaceEvidence({ now: () => 1 })
    const base = await digestOf(port, dir)
    writeFileSync(join(dir, "a.txt"), "alpha changed\n")
    const content = await digestOf(port, dir)
    expect(content).not.toBe(base)
    writeFileSync(join(dir, "a.txt"), "alpha\n")
    expect(await digestOf(port, dir)).toBe(base) // restored ⇒ identical
    writeFileSync(join(dir, "untracked.txt"), "new")
    const untracked = await digestOf(port, dir)
    expect(untracked).not.toBe(base)
    rmSync(join(dir, "untracked.txt"))
    chmodSync(join(dir, "a.txt"), 0o755)
    const mode = await digestOf(port, dir)
    expect(mode).not.toBe(base)
    chmodSync(join(dir, "a.txt"), 0o644)
    symlinkSync("a.txt", join(dir, "link"))
    const link = await digestOf(port, dir)
    expect(link).not.toBe(base)
    rmSync(join(dir, "link"))
    rmSync(join(dir, "a.txt"))
    expect(await digestOf(port, dir)).not.toBe(base) // tracked file deleted
  })

  test("the cheap precheck changes when the tree changes and is cheaper than a full capture", async () => {
    const port = createWorkspaceEvidence()
    const p1 = await port.precheck(dir)
    expect(typeof p1).toBe("string")
    writeFileSync(join(dir, "b.txt"), "b")
    const p2 = await port.precheck(dir)
    expect(p2).not.toBe(p1)
    expect(String(p1).startsWith("quanta-workspace-precheck-v1:")).toBe(true)
  })

  test("caps fail closed (cap-exceeded), never a partial digest", async () => {
    writeFileSync(join(dir, "b.txt"), "b")
    const files = createWorkspaceEvidence({ maxFiles: 1 })
    const f = await files.capture(dir)
    expect(isEvidenceFailure(f) && f.kind === "cap-exceeded").toBe(true)
    const bytes = createWorkspaceEvidence({ maxBytes: 3 })
    const b = await bytes.capture(dir)
    expect(isEvidenceFailure(b) && b.kind === "cap-exceeded").toBe(true)
  })

  test("a non-git workspace gets a bounded directory manifest with ignore rules", async () => {
    const plain = mkdtempSync(join(tmpdir(), "obj-plain-"))
    try {
      writeFileSync(join(plain, "x.txt"), "x")
      mkdirSync(join(plain, "node_modules"))
      writeFileSync(join(plain, "node_modules", "dep.js"), "junk")
      const port = createWorkspaceEvidence({ now: () => 1 })
      const d1 = await digestOf(port, plain)
      writeFileSync(join(plain, "node_modules", "dep.js"), "changed junk")
      expect(await digestOf(port, plain)).toBe(d1) // ignored segment
      writeFileSync(join(plain, "x.txt"), "y")
      expect(await digestOf(port, plain)).not.toBe(d1)
      const capped = createWorkspaceEvidence({ maxFiles: 0 })
      const c = await capped.capture(plain)
      expect(isEvidenceFailure(c) && c.kind === "cap-exceeded").toBe(true)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator (fake runner + fake evidence + real authority)
// ─────────────────────────────────────────────────────────────────────────────

const fakeEvidence = (state: {
  digest: string
  fail?: WorkspaceEvidenceFailure
}): WorkspaceEvidencePort => ({
  precheck: async () => (state.fail ? state.fail : `pre:${state.digest}`),
  capture: async (): Promise<WorkspaceEvidence | WorkspaceEvidenceFailure> =>
    state.fail
      ? state.fail
      : {
          sourceDigest: state.digest,
          precheck: `pre:${state.digest}`,
          capturedAt: 1,
          fileCount: 1,
        },
})

const fakeRunner = (
  onRun: (input: CheckRunInput) => Partial<CheckRunResult> | Promise<Partial<CheckRunResult>>,
): ObjectiveCheckRunner & { calls: CheckRunInput[] } => {
  const calls: CheckRunInput[] = []
  return {
    calls,
    async run(input) {
      calls.push(input)
      const over = await onRun(input)
      return {
        exitCode: 0,
        timedOut: false,
        stdoutDigest: "sha256:o",
        stdoutBytes: 0,
        stderrDigest: "sha256:e",
        stderrBytes: 0,
        durationMs: 1,
        ...over,
      }
    },
  }
}

const setupCoordinator = (
  runner: ObjectiveCheckRunner,
  evidence: WorkspaceEvidencePort,
  checks: readonly { text: string; argv: string[]; ok?: number[] }[] = [
    { text: "unit", argv: ["u"] },
  ],
) => {
  const authority = createObjectiveAuthority({ now: () => 5 })
  authority.create("t", {
    goal: "g",
    criteria: checks.map((c) => ({
      text: c.text,
      check: { kind: "command", argv: c.argv, timeoutMs: 1_000, successExitCodes: c.ok ?? [0] },
    })),
  })
  const caps = createObjectiveCapabilities(authority)
  const coordinator = createObjectiveVerificationCoordinator({
    read: caps.read,
    verifier: caps.verifier,
    runner,
    evidence,
    workspaceCwd: "/work",
    now: () => 10,
  })
  return { authority, caps, coordinator }
}

describe("GOAL-03 — verification coordinator", () => {
  test("a passing run completes the checked criterion with the stable digest; a failing run leaves it unmet", async () => {
    const state = { digest: "D1" }
    const runner = fakeRunner((input) => ({ exitCode: input.argv[0] === "fail" ? 1 : 0 }))
    const { authority, coordinator } = setupCoordinator(runner, fakeEvidence(state), [
      { text: "ok", argv: ["ok"] },
      { text: "bad", argv: ["fail"] },
    ])
    const out = await coordinator.verify("t")
    expect(out.kind).toBe("verified")
    if (out.kind === "verified") expect([out.passed, out.failed]).toEqual([1, 1])
    const crit = authority.get("t")?.successCriteria ?? []
    expect(crit[0]?.met).toBe(true)
    expect(crit[0]?.completion?.source === "verifier" && crit[0].completion.sourceDigest).toBe("D1")
    expect(crit[1]?.met).toBe(false)
    expect(runner.calls.map((c) => c.cwd)).toEqual(["/work", "/work"]) // session cwd, never check input
    expect(runner.calls[0]?.argv).toEqual(["ok"])
  })

  test("source drift during the run ⇒ stale-source, ZERO receipts, prior receipts invalidated", async () => {
    const state = { digest: "D1" }
    const runner = fakeRunner(() => {
      state.digest = "D2" // the check (or anyone) mutated the tree while running
      return { exitCode: 0 }
    })
    const { authority, caps, coordinator } = setupCoordinator(runner, fakeEvidence(state))
    // Pre-existing receipt from an earlier verification at D1.
    const c = authority.get("t")?.successCriteria[0]
    caps.verifier.commit("t", {
      kind: "applyVerificationBatch",
      batch: {
        objectiveId: authority.get("t")?.objectiveId ?? "",
        expectedRevision: authority.readDomain("t").revision,
        sourceDigest: "D1",
        verifiedAt: 1,
        results: [
          {
            criterionId: c?.id ?? "",
            checkId: c?.kind === "checked" ? c.check.id : "",
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdoutDigest: "x",
            stderrDigest: "y",
          },
        ],
      },
    })
    expect(authority.get("t")?.successCriteria[0]?.met).toBe(true)
    const out = await coordinator.verify("t")
    expect(out.kind).toBe("stale-source")
    expect(authority.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(authority.get("t")?.status).toBe("active")
  })

  test("runner failure ⇒ runner-unavailable with zero receipts; evidence failure ⇒ typed outcome", async () => {
    const throwing = fakeRunner(() => {
      throw new Error("sandbox-exec missing")
    })
    const a = setupCoordinator(throwing, fakeEvidence({ digest: "D" }))
    const out = await a.coordinator.verify("t")
    expect(out.kind).toBe("runner-unavailable")
    expect(a.authority.get("t")?.successCriteria[0]?.met).toBe(false)
    const b = setupCoordinator(
      fakeRunner(() => ({})),
      fakeEvidence({ digest: "D", fail: { kind: "cap-exceeded", reason: "too many" } }),
    )
    expect((await b.coordinator.verify("t")).kind).toBe("cap-exceeded")
    const cc = setupCoordinator(
      fakeRunner(() => ({})),
      fakeEvidence({ digest: "D", fail: { kind: "source-unavailable", reason: "no tree" } }),
    )
    expect((await cc.coordinator.verify("t")).kind).toBe("source-unavailable")
  })

  test("cancellation stops before the next check and leaves zero receipts", async () => {
    const controller = new AbortController()
    const runner = fakeRunner(() => {
      controller.abort()
      return { exitCode: 0 }
    })
    const { authority, coordinator } = setupCoordinator(runner, fakeEvidence({ digest: "D" }), [
      { text: "a", argv: ["a"] },
      { text: "b", argv: ["b"] },
    ])
    const out = await coordinator.verify("t", undefined, controller.signal)
    expect(out.kind).toBe("cancelled")
    expect(runner.calls.length).toBe(1)
    expect(authority.get("t")?.successCriteria.every((c) => !c.met)).toBe(true)
  })

  test("a concurrent NON-generation mutation during the run is absorbed by the bounded CAS retry; a replace is rejected", async () => {
    const state = { digest: "D" }
    const stableSetup = setupCoordinator(
      fakeRunner(() => {
        stableSetup.caps.user.commit("t", { kind: "setNextActions", actions: ["moved"] })
        return { exitCode: 0 }
      }),
      fakeEvidence(state),
    )
    const out = await stableSetup.coordinator.verify("t")
    expect(out.kind).toBe("verified")
    expect(stableSetup.authority.get("t")?.successCriteria[0]?.met).toBe(true)

    const replaced = setupCoordinator(
      fakeRunner(() => {
        replaced.caps.user.commit("t", { kind: "replace", definition: { goal: "new" } })
        return { exitCode: 0 }
      }),
      fakeEvidence(state),
    )
    const out2 = await replaced.coordinator.verify("t")
    expect(out2.kind).toBe("rejected")
    expect(replaced.authority.get("t")?.successCriteria).toEqual([])
  })

  test("reconcile invalidates receipts whose digest no longer matches; unchanged precheck skips the rehash", async () => {
    const state = { digest: "D1" }
    let captures = 0
    const evidence: WorkspaceEvidencePort = {
      precheck: async () => `pre:${state.digest}`,
      capture: async () => {
        captures += 1
        return {
          sourceDigest: state.digest,
          precheck: `pre:${state.digest}`,
          capturedAt: 1,
          fileCount: 1,
        }
      },
    }
    const { authority, coordinator } = setupCoordinator(
      fakeRunner(() => ({})),
      evidence,
    )
    expect((await coordinator.verify("t")).kind).toBe("verified")
    const afterVerify = captures
    expect((await coordinator.reconcile("t")).kind).toBe("fresh")
    const afterFresh = captures
    expect((await coordinator.reconcile("t")).kind).toBe("fresh")
    expect(captures).toBe(afterFresh) // precheck unchanged ⇒ no second full manifest
    expect(afterFresh).toBeGreaterThan(afterVerify - 1)
    state.digest = "D2"
    const out = await coordinator.reconcile("t")
    expect(out.kind).toBe("invalidated")
    expect(authority.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(authority.get("t")?.status).toBe("active")
    expect((await coordinator.reconcile("t")).kind).toBe("fresh") // nothing verified any more
  })

  test("no checked criteria ⇒ no-checks (nothing runs); a HITL-weaker run cannot mint a receipt (runner is the only path)", async () => {
    const authority = createObjectiveAuthority({ now: () => 5 })
    authority.create("t", { goal: "g", successCriteria: ["manual only"] })
    const caps = createObjectiveCapabilities(authority)
    const runner = fakeRunner(() => ({}))
    const coordinator = createObjectiveVerificationCoordinator({
      read: caps.read,
      verifier: caps.verifier,
      runner,
      evidence: fakeEvidence({ digest: "D" }),
      workspaceCwd: "/work",
    })
    expect((await coordinator.verify("t")).kind).toBe("no-checks")
    expect(runner.calls.length).toBe(0)
  })
})

describe("GOAL-03 — production check runner", () => {
  test("digests output (never raw), reports exit code, honours the timeout ceiling", async () => {
    const runner = createObjectiveCheckRunner()
    const ok = await runner.run({
      argv: ["bun", "-e", "console.log('secret output'); process.exit(4)"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
    })
    expect(ok.exitCode).toBe(4)
    expect(ok.stdoutDigest.startsWith("sha256:")).toBe(true)
    expect(JSON.stringify(ok)).not.toContain("secret output")
    expect(ok.stdoutBytes).toBeGreaterThan(0)
    const slow = await runner.run({
      argv: ["bun", "-e", "setTimeout(()=>{}, 60000)"],
      cwd: process.cwd(),
      timeoutMs: 200,
    })
    expect(slow.timedOut).toBe(true)
  })
})
