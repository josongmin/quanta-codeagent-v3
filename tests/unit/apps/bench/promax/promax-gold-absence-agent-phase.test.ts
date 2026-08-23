/**
 * HELLGATE — the ANSWER KEY is ABSENT from the box during the AGENT phase.
 *
 * ProMax's upstream repository carries `patch` and `test_patch` in the SAME rows
 * as the public fields (`data/swe-bench-promax.json`), and `data/eval.json` +
 * `src/evaluation/test_run.py` are the eval metadata and the evaluator. So the
 * pinned upstream CHECKOUT *is* the answer key: materializing it on the box the
 * agent runs on violates invariant 3 ("gold patch, test patch, eval script,
 * golden output and derived image receipts never enter the agent workspace,
 * prompt, repo map, or index root") in substance, whatever path it lands at —
 * the bench agent's `bash` tool is UNSANDBOXED on that box, so a quanta-owned
 * root outside `$HOME` is not a boundary, it is a filename.
 *
 * The defence is therefore ABSENCE, not path-hiding, and this file pins it as
 * four separable claims:
 *
 *   L1  every gold-bearing bootstrap command is GRADER-phase, and executing the
 *       real executor in the AGENT phase issues no command that so much as
 *       NAMES a gold-bearing path;
 *   L2  on a ProMax lane the family's own admission REFUSAL fires BEFORE any
 *       bootstrap command is issued — asserted on the recorded command SEQUENCE,
 *       not on the final error;
 *   L3  the typed digest expectation survives the profile boundary and the
 *       comparison actually RUNS — a wrong observed digest fails the bootstrap;
 *   L4  a REUSED warm box does not silently skip the family bootstrap.
 *
 * 🔴 SPEND SAFETY. Every executor here takes an INJECTED ssh/spawn. The fakes
 * THROW on `run-instances` / `docker pull` / `--upload`, so a regression that
 * reached provisioning fails this test instead of billing.
 */
import { describe, expect, test } from "bun:test"
import { DATASET_FAMILIES, type DatasetFamily } from "@/apps/bench/dataset-family-token"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { PROMAX_ONBOX_CHECKOUT_ROOT } from "@/apps/bench/profiles/promax-bootstrap"
import {
  FAMILY_BOOTSTRAP_PHASES,
  type FamilyBootstrapCommand,
  type FamilyBootstrapPhase,
  type FamilyRemoteBootstrap,
} from "@/apps/bench/profiles/types"
import { PROMAX_V1_SNAPSHOT, PROMAX_V1_UPSTREAM_PATHS } from "@/apps/bench/promax/provenance"
import type { SpawnResult } from "@/apps/bench/remote/backend"
import { attachBox } from "@/apps/bench/remote/box-session/ec2-lifecycle"
import {
  executeFamilyRemoteBootstrap,
  FamilyBootstrapError,
  renderBootstrapCommand,
} from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { setupBoxForFamily } from "@/apps/bench/remote/box-session/family-box-setup"
import { withResolvedFamilyBootstrap } from "@/apps/bench/remote/full"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import { createSpawnRecorder, ok, whenArgsInclude, whenCmd } from "../../../bench-spawn-testkit"

const PINNED = PROMAX_V1_SNAPSHOT.upstream_git_commit

/** Every on-box string whose presence during the AGENT phase would mean the
 *  answer key is reachable. The checkout ROOT is included because the gold files
 *  live inside it, so naming the root at agent time is already the leak. */
const GOLD_BEARING_NEEDLES: readonly string[] = [
  PROMAX_ONBOX_CHECKOUT_ROOT,
  PROMAX_V1_UPSTREAM_PATHS.dataset,
  PROMAX_V1_UPSTREAM_PATHS.evalMeta,
  PROMAX_V1_UPSTREAM_PATHS.evaluator,
  PROMAX_V1_SNAPSHOT.upstream_repo_url,
]

const promaxBootstrap = (): FamilyRemoteBootstrap => {
  const spec = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  if (spec === undefined) throw new Error("promax must declare a remote bootstrap")
  return spec
}

interface Recorder {
  readonly commands: string[]
  readonly ssh: (cmd: string) => Promise<SpawnResult>
}

/** A recording ssh. `respond` may return a canned result per command. */
const recorder = (respond?: (cmd: string, n: number) => SpawnResult): Recorder => {
  const commands: string[] = []
  return {
    commands,
    ssh: async (cmd) => {
      for (const forbidden of ["run-instances", "docker pull", "--upload"]) {
        if (cmd.includes(forbidden)) {
          throw new Error(`SPEND GUARD: a bootstrap step reached "${forbidden}"`)
        }
      }
      commands.push(cmd)
      const canned = respond?.(cmd, commands.length)
      if (canned !== undefined) return canned
      // DEFAULT answers must be what a WORKING box says, and a working box
      // reports its interpreter version: the executor refuses a declared
      // interpreter floor that the box answers with silence, so an empty
      // default would make every caller fail the floor instead of exercising
      // what it came to test.
      if (cmd.includes("--version")) return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

// ---------------------------------------------------------------------------
// L1 — the gold-bearing checkout is GRADER-phase, and absent at agent time
// ---------------------------------------------------------------------------

describe("L1 — no gold-bearing path exists on the box during the AGENT phase", () => {
  test("KNOWN-ITEM FLOOR — the plan really does declare gold-bearing commands, all GRADER-phase", () => {
    const commands = promaxBootstrap().commands
    // Without this floor, "no agent-phase command is gold-bearing" would pass on
    // an empty plan.
    expect(commands.length).toBeGreaterThanOrEqual(5)
    const gold = commands.filter((c) => c.goldBearing)
    expect(gold.length).toBeGreaterThanOrEqual(5)
    for (const c of gold) {
      // aug-22 A-A: `teardown` is the second phase allowed to touch the answer
      // key — it is what REMOVES it. The claim that matters is unchanged and is
      // asserted positively below: the AGENT phase carries none of them.
      expect(["grader", "teardown"], `gold-bearing step "${c.step}"`).toContain(c.phase)
    }
    expect(gold.filter((c) => c.phase === "teardown").length).toBeGreaterThanOrEqual(1)
    // …and the agent phase is NOT empty, so the executor is genuinely exercised.
    const agent = commands.filter((c) => c.phase === "agent")
    expect(agent.length).toBeGreaterThanOrEqual(2)
    expect(agent.every((c) => !c.goldBearing)).toBe(true)
    // drift guard: every declared phase is a member of the closed union.
    for (const c of commands) expect(FAMILY_BOOTSTRAP_PHASES).toContain(c.phase)
  })

  test("REACHABILITY — the real executor in the AGENT phase names no gold-bearing path", async () => {
    const rec = recorder()
    const bootstrap = promaxBootstrap()
    const ran = await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "agent",
      ssh: rec.ssh,
      log: () => {},
    })
    expect(ran).toBeGreaterThan(0) // non-vacuous: commands really were issued
    // EXACTLY the declared agent-phase commands, in order — not a subset the
    // executor happened to skip.
    expect(rec.commands).toEqual(
      bootstrap.commands.filter((c) => c.phase === "agent").map(renderBootstrapCommand),
    )
    // aug-22 A-A. The agent phase now also PROVES the checkout is absent, and a
    // probe must name the path it is proving absent. So the claim is CLASSIFIED
    // rather than relaxed: the only agent-phase command permitted to name a
    // gold-bearing path is a DECLARED `absenceProbe`, everything else must be
    // gold-path-free, and there must really be a probe (floor below).
    const agentCommands = bootstrap.commands.filter((c) => c.phase === "agent")
    const probes = agentCommands.filter((c) => c.absenceProbe !== undefined)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.absenceProbe?.absolutePath).toBe(PROMAX_ONBOX_CHECKOUT_ROOT)
    const nonProbe = agentCommands
      .filter((c) => c.absenceProbe === undefined)
      .map(renderBootstrapCommand)
    // non-vacuous: the non-probe commands are most of the phase, not an empty set
    expect(nonProbe.length).toBeGreaterThanOrEqual(2)
    const issued = nonProbe.join("\n")
    for (const needle of GOLD_BEARING_NEEDLES) {
      expect(issued, `agent phase issued a command naming ${needle}`).not.toContain(needle)
    }
    expect(issued).not.toContain(PINNED)
    // The pinned commit and the upstream URL are revealed by NOTHING in the
    // agent phase — not even the probe (it asserts on a directory, no more).
    const everything = rec.commands.join("\n")
    expect(everything).not.toContain(PINNED)
    expect(everything).not.toContain(PROMAX_V1_SNAPSHOT.upstream_repo_url)
    for (const rel of Object.values(PROMAX_V1_UPSTREAM_PATHS)) {
      expect(everything).not.toContain(rel)
    }
    // …and the checkout that materializes the answer key was NOT among them.
    expect(issued).not.toContain("checkout")
    expect(everything).not.toContain("fetch")
  })

  test("PAIRED CONTROL — the GRADER phase does issue exactly those commands", async () => {
    const rec = recorder((cmd) => ({
      code: 0,
      stdout: digestFor(cmd) ?? "",
      stderr: "",
    }))
    const bootstrap = promaxBootstrap()
    await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "grader",
      ssh: rec.ssh,
      log: () => {},
    })
    const issued = rec.commands.join("\n")
    // The same needles the agent phase must never see are exactly what the
    // grader phase is FOR — this is what makes the assertion above meaningful.
    for (const needle of GOLD_BEARING_NEEDLES) expect(issued).toContain(needle)
    expect(issued).toContain(PINNED)
    // the two phases PARTITION the plan (nothing declared is unreachable)
    const agentCount = bootstrap.commands.filter((c) => c.phase === "agent").length
    expect(rec.commands.length + agentCount).toBe(bootstrap.commands.length)
  })

  test("RED-ON-INJECTION — a gold-bearing command mis-declared `agent` is REFUSED before any ssh", async () => {
    const bootstrap = promaxBootstrap()
    const goldCommand = bootstrap.commands.find((c) => c.goldBearing)
    if (goldCommand === undefined) throw new Error("unreachable — floor asserted above")
    // The realistic regression: a future edit re-labels the checkout as
    // agent-phase (exactly the shape of the defect this stage repairs).
    const mislabelled: FamilyRemoteBootstrap = {
      ...bootstrap,
      commands: bootstrap.commands.map((c) =>
        c === goldCommand ? { ...c, phase: "agent" as FamilyBootstrapPhase } : c,
      ),
    }
    const rec = recorder()
    await expect(
      executeFamilyRemoteBootstrap({
        bootstrap: mislabelled,
        phase: "agent",
        ssh: rec.ssh,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(FamilyBootstrapError)
    // fail-closed BEFORE the box was touched at all
    expect(rec.commands).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// L2 — refusal FIRST, asserted on the command SEQUENCE
// ---------------------------------------------------------------------------

describe("L2 — the family admission refusal fires BEFORE any bootstrap command", () => {
  test("a ProMax lane issues ZERO commands before it is refused", async () => {
    const rec = recorder()
    await expect(
      setupBoxForFamily({
        family: "promax",
        bootstrap: promaxBootstrap(),
        ssh: rec.ssh,
        log: () => {},
      }),
    ).rejects.toThrow(/on-box ProMax bootstrap is not wired yet/)
    // THE claim: the recorded SEQUENCE is empty. A refusal that fires after the
    // fetch is not a guard, and asserting only on the error text cannot tell the
    // two apart.
    expect(rec.commands).toEqual([])
  })

  test("POSITIVE CONTROL — an ADMITTED family does run its agent-phase bootstrap", async () => {
    // Same callee, same ordering; `verified`'s setupBox is a no-op, so the
    // bootstrap leg proves it is live rather than dead code.
    const probe: FamilyRemoteBootstrap = {
      family: "verified",
      graderWorkers: 1,
      planNotes: [],
      commands: [
        {
          step: "probe",
          phase: "agent",
          goldBearing: false,
          argv: ["true"],
          purpose: "positive control",
        },
      ],
    }
    const rec = recorder()
    await setupBoxForFamily({ family: "verified", bootstrap: probe, ssh: rec.ssh, log: () => {} })
    // argv is the contract; the single quotes are the ssh transport's, not the
    // family's — nothing a family declares can reach the box shell as syntax.
    expect(rec.commands).toEqual(["'true'"])
  })

  test("BYTE-IDENTICAL CONTROL — a family with no declared bootstrap issues nothing", async () => {
    const rec = recorder()
    await setupBoxForFamily({ family: "verified", ssh: rec.ssh, log: () => {} })
    expect(rec.commands).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// L3 — the typed digest expectation survives the profile boundary AND bites
// ---------------------------------------------------------------------------

/** `sha256sum <path>` output for a command whose expectation we honour. */
const digestFor = (rendered: string): string | undefined => {
  for (const file of [
    { path: PROMAX_V1_UPSTREAM_PATHS.dataset, sha: PROMAX_V1_SNAPSHOT.dataset_sha256 },
    { path: PROMAX_V1_UPSTREAM_PATHS.evalMeta, sha: PROMAX_V1_SNAPSHOT.eval_sha256 },
    { path: PROMAX_V1_UPSTREAM_PATHS.evaluator, sha: PROMAX_V1_SNAPSHOT.evaluator_sha256 },
  ]) {
    if (rendered.includes("sha256sum") && rendered.includes(file.path)) {
      return `${file.sha}  ${PROMAX_ONBOX_CHECKOUT_ROOT}/${file.path}\n`
    }
  }
  // The interpreter probes carry a declared FLOOR the executor compares, so an
  // honest box answers them too — an empty answer is a refusal, not a no-op.
  if (rendered.includes("--version")) return "Python 3.11.14\n"
  return undefined
}

describe("L3 — the digest gate reaches the executor and can actually fail", () => {
  test("the PROFILE-projected commands still carry the typed expectation", () => {
    // This is the exact drop the audit found: the profile used to map the plan
    // to `{step, argv, purpose}` and lose `verifies` at the boundary.
    const verifying = promaxBootstrap().commands.filter(
      (c: FamilyBootstrapCommand) => c.verifies !== undefined,
    )
    expect(verifying).toHaveLength(3)
    const expected = [
      PROMAX_V1_SNAPSHOT.dataset_sha256,
      PROMAX_V1_SNAPSHOT.eval_sha256,
      PROMAX_V1_SNAPSHOT.evaluator_sha256,
    ]
    expect(verifying.map((c) => c.verifies?.sha256)).toEqual(expected)
    for (const c of verifying) {
      expect(c.verifies?.absolutePath.startsWith(PROMAX_ONBOX_CHECKOUT_ROOT)).toBe(true)
    }
  })

  test("MATCHING digests pass", async () => {
    const rec = recorder((cmd) => ({ code: 0, stdout: digestFor(cmd) ?? "", stderr: "" }))
    const bootstrap = promaxBootstrap()
    const graderCount = bootstrap.commands.filter((c) => c.phase === "grader").length
    // aug-22 A-A: the teardown runs in the SAME call, so it is part of the count.
    const teardownCount = bootstrap.commands.filter((c) => c.phase === "teardown").length
    expect(teardownCount).toBeGreaterThanOrEqual(1)
    const ran = await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "grader",
      ssh: rec.ssh,
      log: () => {},
    })
    expect(ran).toBe(graderCount + teardownCount)
  })

  test("RED-ON-INJECTION — one WRONG observed digest fails the bootstrap and STOPS it", async () => {
    // Realistic spelling: upstream force-pushed / a mirror served different
    // bytes, so `sha256sum` reports a well-formed but different digest.
    const wrong = "b".repeat(64)
    const rec = recorder((cmd) => {
      const good = digestFor(cmd)
      if (good === undefined) return { code: 0, stdout: "", stderr: "" }
      return cmd.includes(PROMAX_V1_UPSTREAM_PATHS.dataset)
        ? { code: 0, stdout: `${wrong}  x\n`, stderr: "" }
        : { code: 0, stdout: good, stderr: "" }
    })
    const bootstrap = promaxBootstrap()
    const graderCount = bootstrap.commands.filter((c) => c.phase === "grader").length
    await expect(
      executeFamilyRemoteBootstrap({ bootstrap, phase: "grader", ssh: rec.ssh, log: () => {} }),
    ).rejects.toThrow(new RegExp(PROMAX_V1_SNAPSHOT.dataset_sha256))
    // execution STOPPED at the mismatch — later preconditions never ran
    expect(rec.commands.length).toBeLessThan(graderCount)
  })

  test("FAIL-CLOSED — a command that reports NO digest is a refusal, not a skip", async () => {
    const rec = recorder(() => ({ code: 0, stdout: "", stderr: "" }))
    await expect(
      executeFamilyRemoteBootstrap({
        bootstrap: promaxBootstrap(),
        phase: "grader",
        ssh: rec.ssh,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(FamilyBootstrapError)
  })
})

// ---------------------------------------------------------------------------
// L4 — a REUSED warm box does not silently skip the family bootstrap
// ---------------------------------------------------------------------------

describe("L4 — warm-box reuse cannot bypass the family bootstrap", () => {
  const warmSpawn = () =>
    createSpawnRecorder(
      whenArgsInclude("run-instances", () => {
        throw new Error("SPEND GUARD: a warm-attach test reached RunInstances")
      }),
      whenArgsInclude("describe-instances", ok("1.2.3.4")),
      whenCmd("rsync", ok("")),
      // isBootstrapped probe ⇒ the box is WARM and healthy (no re-bootstrap).
      whenCmd("ssh", (ctx) =>
        ctx.remote.includes("test -x ~/.bun/bin/bun") ? ok("OK\n") : ok(""),
      ),
    )

  const attachCfg = (over: Record<string, unknown>) => ({
    repoDir: "/tmp/fake-repo",
    authJson: "{}",
    datasetPath: "/tmp/ds.jsonl",
    // agentless-v1 does NOT require live LSP grounding ⇒ the clean-reuse path.
    preset: "agentless-v1",
    sleep: async () => {},
    onLog: () => {},
    ...over,
  })

  test("a warm ProMax box hits the family admission gate on ATTACH", async () => {
    const { fn } = warmSpawn()
    await expect(
      attachBox(
        attachCfg({
          spawn: fn,
          swebenchDatasetFamily: "promax" as DatasetFamily,
          remoteBootstrap: promaxBootstrap(),
        }),
        "i-warm",
      ),
    ).rejects.toThrow(/on-box ProMax bootstrap is not wired yet/)
  })

  test("a warm box whose bootstrap state is UNKNOWN is refused, not reused", async () => {
    // The full-remote root resolves the declared bootstrap AFTER its idle-box
    // early return, so `remoteBootstrap` arrives undefined on the attach path.
    // That must be a refusal — silently reusing skips the pinned checkout and
    // the hash step, which defeats the pin.
    //
    // aug-22 A-C: on a ProMax lane the ADMISSION gate now fires first and refuses
    // the lane outright, which is strictly earlier and stronger — so this case
    // asserts THAT refusal, and the unknown-bootstrap-state clause is covered
    // NON-VACUOUSLY (on a family that admits) in promax-gold-absence-lifecycle.
    const { fn } = warmSpawn()
    await expect(
      attachBox(
        attachCfg({ spawn: fn, swebenchDatasetFamily: "promax" as DatasetFamily }),
        "i-warm",
      ),
    ).rejects.toThrow(/on-box ProMax bootstrap is not wired yet/)
  })

  test("the launch root resolves the bootstrap for the ATTACH branch too", async () => {
    // The defect was positional: the resolution sat AFTER the idle-box early
    // return, so only the PROVISION branch ever saw it. `withResolvedFamilyBootstrap`
    // is the one resolution point both branches now consume.
    const base = { repoDir: "/repo", authJson: "{}", datasetPath: "/ds.jsonl" } as const
    const promaxCfg = withResolvedFamilyBootstrap(
      base,
      resolveBenchRunConfig({ argvFamily: "promax", env: {} }),
    )
    expect(promaxCfg.remoteBootstrap?.family).toBe("promax")
    expect(promaxCfg.remoteBootstrap?.commands.some((c) => c.goldBearing)).toBe(true)
    // PAIRED CONTROL — a family that declares none is returned unchanged.
    for (const family of DATASET_FAMILIES.filter((f) => f !== "promax")) {
      const out = withResolvedFamilyBootstrap(
        base,
        resolveBenchRunConfig({ argvFamily: family, env: {} }),
      )
      expect(out.remoteBootstrap, `${family} grew a bootstrap`).toBeUndefined()
      expect(out).toEqual(base)
    }
  })

  test("BYTE-IDENTICAL CONTROL — families with no declared bootstrap attach unchanged", async () => {
    for (const family of DATASET_FAMILIES.filter((f) => f !== "promax")) {
      const { fn } = warmSpawn()
      const session = await attachBox(
        attachCfg({ spawn: fn, swebenchDatasetFamily: family }),
        "i-warm",
      )
      expect(session.iid).toBe("i-warm")
    }
  })
})
