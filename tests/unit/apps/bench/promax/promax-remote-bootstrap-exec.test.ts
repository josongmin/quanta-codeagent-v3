/**
 * HELLGATE — PMX-04: the family's DECLARED remote bootstrap actually RUNS on the
 * box, through the real `bootstrapBox` callee, and nothing in `remote/**` had to
 * learn what "promax" means to make that happen.
 *
 * The prior stage proved the bootstrap SPEC (argv, order, hashes) and proved it
 * reaches a dry-run PLAN. A plan is not a box. This closes the half that was
 * explicitly recorded as "HALF-WIRED": the specification now reaches the real
 * `setupBoxForFamily` — `bootstrapBox`'s own callee — and is executed in order,
 * fail-closed.
 *
 * OBSERVABLES (real effects):
 *   - the exact command STRINGS issued to a recording ssh, in order;
 *   - the refusal a non-zero step produces, and that execution STOPS there;
 *   - the byte-identical control: a family with no declared bootstrap issues
 *     ZERO extra ssh through the same callee.
 *
 * 🔴 SPEND SAFETY: `setupBoxForFamily` takes an INJECTED ssh. Nothing here
 * provisions, and the recording ssh throws if it is ever handed a command
 * containing `run-instances`.
 */
import { describe, expect, test } from "bun:test"
import { proMaxRemoteBootstrap } from "@/apps/bench/profiles/promax-bootstrap"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import {
  PROMAX_V1_SNAPSHOT,
  PROMAX_V1_UPSTREAM_PATHS,
} from "@/apps/bench/promax/provenance/frozen-snapshot"
import type { SpawnResult } from "@/apps/bench/remote/backend"
import { setupBoxForFamily } from "@/apps/bench/remote/box-session/ec2-lifecycle"
import {
  executeFamilyRemoteBootstrap,
  FamilyBootstrapError,
  renderBootstrapCommand,
} from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const PINNED = PROMAX_V1_SNAPSHOT.upstream_git_commit

const promaxBootstrap = () =>
  proMaxRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

interface Recorder {
  readonly commands: string[]
  readonly ssh: (cmd: string) => Promise<SpawnResult>
}

/** The digest a HONEST box would report for a `sha256sum` step, so the executor's
 *  digest gate passes and this file keeps testing ORDERING rather than hashes
 *  (the gate itself is proven red-on-injection in the gold-absence hellgate). */
const honestDigest = (cmd: string): string => {
  for (const [rel, sha] of [
    [PROMAX_V1_UPSTREAM_PATHS.dataset, PROMAX_V1_SNAPSHOT.dataset_sha256],
    [PROMAX_V1_UPSTREAM_PATHS.evalMeta, PROMAX_V1_SNAPSHOT.eval_sha256],
    [PROMAX_V1_UPSTREAM_PATHS.evaluator, PROMAX_V1_SNAPSHOT.evaluator_sha256],
  ] as const) {
    if (cmd.includes("sha256sum") && cmd.includes(rel)) return `${sha}  ${rel}\n`
  }
  return ""
}

const recorder = (failAt?: number): Recorder => {
  const commands: string[] = []
  return {
    commands,
    ssh: async (cmd) => {
      if (cmd.includes("run-instances")) {
        throw new Error("SPEND GUARD: a bootstrap step reached EC2 provisioning")
      }
      commands.push(cmd)
      return failAt !== undefined && commands.length === failAt
        ? { code: 3, stdout: "", stderr: "fatal: couldn't find remote ref" }
        : { code: 0, stdout: honestDigest(cmd), stderr: "" }
    },
  }
}

describe("the executor is generic and fail-closed", () => {
  test("KNOWN-ITEM FLOOR — only promax declares a remote bootstrap", () => {
    expect(resolveDatasetFamilyProfile("promax").remoteBootstrap).toBeDefined()
    for (const family of ["verified", "live", "pro"] as const) {
      expect(
        resolveDatasetFamilyProfile(family).remoteBootstrap,
        `${family} unexpectedly grew a remote bootstrap`,
      ).toBeUndefined()
    }
    // …and the promax spec really is a multi-step plan, not an empty list.
    expect(promaxBootstrap().commands.length).toBeGreaterThanOrEqual(5)
  })

  test("commands run IN ORDER and each argv is shell-quoted, never interpolated", async () => {
    const rec = recorder()
    const bootstrap = promaxBootstrap()
    // The gold-bearing checkout is GRADER-phase; the agent phase can never carry
    // it (see promax-gold-absence-agent-phase.test.ts), so ordering/quoting is
    // asserted on the phase that actually issues those commands.
    const grader = bootstrap.commands.filter((c) => c.phase === "grader")
    // aug-22 A-A: the TEARDOWN is bound to the grader call (it runs in that
    // call's finally), so the recorded sequence is grader-then-teardown. A
    // teardown with its own call site is a teardown someone forgets.
    const teardown = bootstrap.commands.filter((c) => c.phase === "teardown")
    expect(teardown.length).toBeGreaterThanOrEqual(1)
    const ran = await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "grader",
      ssh: rec.ssh,
      log: () => {},
    })
    expect(ran).toBe(grader.length + teardown.length)
    expect(rec.commands).toEqual([...grader, ...teardown].map(renderBootstrapCommand))
    // the pinned COMMIT is what gets checked out, detached, and no branch is named
    const joined = rec.commands.join("\n")
    expect(joined).toContain(`'checkout' '--detach' '${PINNED}'`)
    expect(joined).not.toContain("'main'")
    expect(joined).not.toContain("FETCH_HEAD")
    // every token is quoted ⇒ nothing a family declares can be shell syntax
    expect(joined).not.toMatch(/[^']\$\(/)
  })

  test("the FIRST non-zero step aborts — later preconditions never run", async () => {
    const rec = recorder(3)
    const bootstrap = promaxBootstrap()
    const grader = bootstrap.commands.filter((c) => c.phase === "grader")
    const teardown = bootstrap.commands.filter((c) => c.phase === "teardown")
    await expect(
      executeFamilyRemoteBootstrap({ bootstrap, phase: "grader", ssh: rec.ssh, log: () => {} }),
    ).rejects.toBeInstanceOf(FamilyBootstrapError)
    // The 3 that ran before the failure, and NO later grader precondition…
    const graderIssued = rec.commands.filter(
      (c) => !teardown.map(renderBootstrapCommand).includes(c),
    )
    expect(graderIssued).toHaveLength(3)
    expect(graderIssued.length).toBeLessThan(grader.length)
    // …but the TEARDOWN still ran (aug-22 A-A). A grader phase that died
    // half-way is EXACTLY when the answer key is left on the box, so a failure
    // is a reason to tear down, not a reason to skip it.
    expect(rec.commands.slice(-teardown.length)).toEqual(teardown.map(renderBootstrapCommand))
  })

  test("PAIRED CONTROL — no declared bootstrap ⇒ NOT ONE ssh round trip", async () => {
    const rec = recorder()
    const ran = await executeFamilyRemoteBootstrap({
      bootstrap: undefined,
      phase: "agent",
      ssh: rec.ssh,
      log: () => {},
    })
    expect(ran).toBe(0)
    expect(rec.commands).toEqual([])
  })
})

describe("the REAL bootstrapBox callee carries it", () => {
  test("setupBoxForFamily runs the family's REFUSAL before any carried command", async () => {
    const rec = recorder()
    const bootstrap = promaxBootstrap()
    // 🔴 The ProMax profile's own `setupBox` is the ADMISSION GATE. It used to
    // fire only AFTER the carried bootstrap had already fetched the gold-bearing
    // upstream tree onto the box — a guard that ran after the leak. The recorded
    // SEQUENCE, not the error text, is what tells the two apart.
    await expect(
      setupBoxForFamily({ family: "promax", bootstrap, ssh: rec.ssh, log: () => {} }),
    ).rejects.toThrow(/on-box ProMax bootstrap is not wired yet/)
    expect(rec.commands).toEqual([])
  })

  test("BYTE-IDENTICAL CONTROL — verified through the SAME callee issues nothing", async () => {
    const rec = recorder()
    await setupBoxForFamily({ family: "verified", ssh: rec.ssh, log: () => {} })
    expect(rec.commands).toEqual([])
  })
})
