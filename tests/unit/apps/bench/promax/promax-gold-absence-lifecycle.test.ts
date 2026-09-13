/**
 * HELLGATE — the answer key's LIFECYCLE on a box: it is removed when grading
 * ends, its absence is PROVEN before the next agent phase, the previous chunk's
 * gold-bearing dataset is scrubbed, and a family that refuses a lane refuses it
 * before the box has been touched.
 *
 * The sibling file `promax-gold-absence-agent-phase.test.ts` proves a claim about
 * ONE phase of ONE chunk. That claim was true and still insufficient, because
 * absence was never ESTABLISHED — only declared:
 *
 *   A-A  the grader phase created `/opt/quanta/promax/upstream` and NOTHING
 *        removed it, so a second chunk's AGENT phase ran on a box that still
 *        held the gold and test patches;
 *   A-B  the per-chunk scrub cleared preds/report/run.log/… but NOT
 *        `paths.dataset` — and a ProMax dataset row carries `patch` and
 *        `test_patch` beside its public fields, so the previous chunk's corpus
 *        WAS answer-key bytes sitting at a fixed path;
 *   A-C  on the FRESH-PROVISION path the family admission gate ran at the END of
 *        `bootstrapBox` — after mkdir, a full `src/` rsync, an scp and a `bun
 *        install` — so the refusal fired against an already-mutated box.
 *
 * The acceptance bar is a RECORDED COMMAND SEQUENCE against a SIMULATED BOX
 * FILESYSTEM across TWO CONSECUTIVE CHUNKS — one arriving through the
 * fresh-provision bootstrap, one through warm reuse — because a plan can declare
 * anything and only the box's state settles whether the key is there.
 *
 * 🔴 SPEND SAFETY. Every path here takes an INJECTED spawn that never executes
 * anything, and it THROWS on `run-instances` / `docker pull` / `--upload`, so a
 * regression that reached provisioning fails this test instead of billing.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DATASET_FAMILIES, type DatasetFamily } from "@/apps/bench/dataset-family-token"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { PROMAX_ONBOX_CHECKOUT_ROOT } from "@/apps/bench/profiles/promax-bootstrap"
import {
  DATASET_FAMILY_PROFILES,
  registerDatasetFamilyProfile,
  resolveDatasetFamilyProfile,
} from "@/apps/bench/profiles/registry"
import type { FamilyBootstrapCommand, FamilyRemoteBootstrap } from "@/apps/bench/profiles/types"
import { PROMAX_V1_SNAPSHOT, PROMAX_V1_UPSTREAM_PATHS } from "@/apps/bench/promax/provenance"
import type { SpawnFn, SpawnResult } from "@/apps/bench/remote/backend"
import {
  type BoxSession,
  type GradeChunkParams,
  gradeChunkOnBox,
  scrubChunkArtifacts,
} from "@/apps/bench/remote/box-session"
import {
  buildChunkScrubCommand,
  CHUNK_PATH_SCRUB_POLICY,
} from "@/apps/bench/remote/box-session/chunk-scrub"
import { attachBox } from "@/apps/bench/remote/box-session/ec2-lifecycle"
import {
  executeFamilyRemoteBootstrap,
  FamilyBootstrapError,
} from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { assertFamilyAdmitsBox } from "@/apps/bench/remote/box-session/family-box-setup"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import { __resetRuntimeConfig } from "@/shared"

/**
 * Paths these cases hand to production code. They were real `/tmp` literals —
 * `instances.jsonl` is genuinely READ (an isolated TMPDIR run logs
 * `corpus-read: /tmp/instances.jsonl: ENOENT`), so the suite reached outside
 * its own sandbox for a file an operator might have had.
 */
const SANDBOX = mkdtempSync(join(tmpdir(), "pmx-lifecycle-sandbox-"))

const TEMPS: string[] = [SANDBOX]
afterAll(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true })
})

const GOLD_ROOT = PROMAX_ONBOX_CHECKOUT_ROOT

/**
 * The absence probe, matched by WHAT IT ASSERTS rather than by its exact argv.
 * It was `'test' '!' '-e' '<root>'` until a symlink was shown to defeat it —
 * `rm -rf` unlinks a link and leaves the target tree whole — so it now also
 * refuses `-L`. An exact-string match here reds on that security fix instead of
 * on a regression, which is the coupling this suite keeps paying for.
 */
const isAbsenceProbe = (c: string): boolean =>
  c.includes("'test'") && c.includes("'-e'") && c.includes(`'${GOLD_ROOT}'`)

const promaxBootstrap = (): FamilyRemoteBootstrap => {
  const spec = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  if (spec === undefined) throw new Error("promax must declare a remote bootstrap")
  return spec
}

// ---------------------------------------------------------------------------
// A SIMULATED BOX FILESYSTEM
//
// The point of the whole packet is that absence is a property of the BOX, not of
// the plan, so the two-chunk proof cannot be a string match: it has to observe
// state that one chunk writes and the next chunk reads. This interpreter is
// deliberately tiny and only understands the verbs the real plan issues.
// ---------------------------------------------------------------------------

/** 🔴 Nothing here may ever provision, pull or upload. A fake spawn cannot spend
 *  by itself, but a regression that reached a real verb must FAIL the test
 *  rather than be quietly absorbed by a stub that answers everything with 0. */
const assertNoSpend = (rendered: string): void => {
  for (const forbidden of ["run-instances", "docker pull", "--upload"]) {
    if (rendered.includes(forbidden)) {
      throw new Error(`SPEND GUARD: a bootstrap step reached "${forbidden}"`)
    }
  }
}

/** Strip the transport's single-quoting back to the argv the family declared. */
const unquote = (rendered: string): string[] =>
  (rendered.match(/'[^']*'|\S+/g) ?? []).map((token) =>
    token.startsWith("'") && token.endsWith("'") ? token.slice(1, -1) : token,
  )

class FakeBox {
  readonly entries = new Set<string>()
  /** Every remote command this box was asked to run, in order. */
  readonly commands: string[] = []
  /** Make `rm -rf` fail, to simulate a teardown that did not take. */
  breakRemoval = false

  exists(path: string): boolean {
    for (const entry of this.entries) {
      if (entry === path || entry.startsWith(`${path}/`)) return true
    }
    return false
  }

  /**
   * The `test !` family, in the order the shell script relies on.
   *
   * Split out of `run` verbatim (complexity 22 → under the ceiling); the ORDER is
   * load-bearing and the comments below say why, so the three branches move
   * together rather than being interleaved with the filesystem verbs. Returns
   * `null` when the command is not a `test !`, so `run`'s fall-through is
   * unchanged.
   */
  private runTestNot(verb: string, argv: readonly string[]): SpawnResult | null {
    if (verb !== "test !") return null
    // `test ! -d P -o -r P` — "if it exists it must be READABLE". This box has
    // no permission model, so every path it knows is readable: exit 0. Matched
    // BEFORE the absence gate, because a bare `verb === "test !"` read it as an
    // absence check on the CAMPAIGN root and refused every bootstrap.
    if (argv.includes("-o") && (argv.includes("-x") || argv.includes("-r"))) return ok()
    // `test ! -L X` — "X is not a symlink". This box has no symlinks, so it is
    // always true. Falling through to the absence branch below read it as
    // "X does not exist" and refused every bootstrap on the campaign root.
    if (argv[2] === "-L") return ok()
    // `test ! -e X [-a ! -L X]` — exit 1 when X EXISTS. This is the whole
    // absence gate; the `-L` half refuses a symlink standing in for the tree,
    // which this box models as ordinary existence.
    return { code: this.exists(argv[3] ?? "") ? 1 : 0, stdout: "", stderr: "" }
  }

  run(rendered: string): SpawnResult {
    assertNoSpend(rendered)
    this.commands.push(rendered)
    const argv = unquote(rendered)
    const verb = argv.slice(0, 2).join(" ")
    const testNot = this.runTestNot(verb, argv)
    if (testNot !== null) return testNot
    if (verb === "mkdir -p") return this.mkdir(argv[2] ?? "")
    // `mkdir <x>` WITHOUT `-p` — the atomic create. It fails when the path is
    // already occupied, which is what makes it a refusal rather than a probe.
    if (argv[0] === "mkdir") {
      const target = argv[1] ?? ""
      return this.exists(target)
        ? { code: 1, stdout: "", stderr: `mkdir: cannot create directory '${target}': File exists` }
        : this.mkdir(target)
    }
    if (verb === "rm -rf") return this.rm(argv[2] ?? "")
    // `git init -q <root>` — the moment the gold-bearing tree appears.
    if (verb === "git init") return this.gitInit(argv[3] ?? "")
    if (argv[0] === "sha256sum") return ok(digestFor(argv[1] ?? ""))
    // `<python> --version` — a real box answers, and the executor REFUSES a box
    // that reports a version below the pinned evaluator's floor (or none at
    // all). This box reports a compliant one; the floor's own refusals are
    // owned by `promax-evaluator-python-floor.test.ts`.
    if (argv[1] === "--version") return ok("Python 3.11.14")
    return ok()
  }

  private mkdir(path: string): SpawnResult {
    this.entries.add(path)
    return ok()
  }

  private rm(target: string): SpawnResult {
    if (this.breakRemoval) return { code: 1, stdout: "", stderr: "rm: Device or resource busy" }
    for (const entry of [...this.entries]) {
      if (entry === target || entry.startsWith(`${target}/`)) this.entries.delete(entry)
    }
    return ok()
  }

  private gitInit(root: string): SpawnResult {
    this.entries.add(root)
    for (const rel of Object.values(PROMAX_V1_UPSTREAM_PATHS)) this.entries.add(`${root}/${rel}`)
    return ok()
  }
}

const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

/** The frozen digest the box reports for a pinned upstream file. */
const digestFor = (absolutePath: string): string => {
  const table: ReadonlyArray<readonly [string, string]> = [
    [PROMAX_V1_UPSTREAM_PATHS.dataset, PROMAX_V1_SNAPSHOT.dataset_sha256],
    [PROMAX_V1_UPSTREAM_PATHS.evalMeta, PROMAX_V1_SNAPSHOT.eval_sha256],
    [PROMAX_V1_UPSTREAM_PATHS.evaluator, PROMAX_V1_SNAPSHOT.evaluator_sha256],
  ]
  for (const [rel, sha] of table) {
    if (absolutePath.endsWith(`/${rel}`)) return `${sha}  ${absolutePath}\n`
  }
  return ""
}

// ---------------------------------------------------------------------------
// A synthetic ADMITTED family that carries the REAL ProMax plan.
//
// ProMax's own lane is refused at admission (PMX-04 is not wired), which is why
// the executor's lifecycle behaviour cannot be observed end-to-end through
// `promax` itself. This family differs from ProMax in exactly one respect — it
// admits — and its bootstrap COMMANDS are the production ProMax plan, unmodified.
// ---------------------------------------------------------------------------

const LIFECYCLE_FAMILY = "pmx-lifecycle-probe" as DatasetFamily

const lifecycleBootstrap = (
  mutate: (commands: readonly FamilyBootstrapCommand[]) => readonly FamilyBootstrapCommand[] = (
    c,
  ) => c,
): FamilyRemoteBootstrap => {
  const real = promaxBootstrap()
  return { ...real, family: LIFECYCLE_FAMILY, commands: mutate(real.commands) }
}

const dropLifecycleFamily = registerDatasetFamilyProfile({
  ...DATASET_FAMILY_PROFILES.verified,
  family: LIFECYCLE_FAMILY,
  reportPartitionKey: LIFECYCLE_FAMILY,
  admitBox: () => {},
  setupBox: async () => {},
  remoteBootstrap: () => lifecycleBootstrap(),
})

/** A family that REFUSES, to drive the admission-ordering claim generically —
 *  the ordering is a property of the gate, not of the word "promax". */
const REFUSING_FAMILY = "pmx-refusing-probe" as DatasetFamily
const REFUSAL = "this lane is refused by its own family"

const dropRefusingFamily = registerDatasetFamilyProfile({
  ...DATASET_FAMILY_PROFILES.verified,
  family: REFUSING_FAMILY,
  reportPartitionKey: REFUSING_FAMILY,
  admitBox: () => {
    throw new Error(REFUSAL)
  },
  setupBox: async () => {
    throw new Error(REFUSAL)
  },
})

afterAll(() => {
  dropLifecycleFamily()
  dropRefusingFamily()
})

// ---------------------------------------------------------------------------
// A-A — teardown + absence probe, across TWO CONSECUTIVE CHUNKS on ONE box
// ---------------------------------------------------------------------------

/** One chunk's AGENT-phase bootstrap, through the REAL executor. */
const runAgentPhase = (box: FakeBox, bootstrap: FamilyRemoteBootstrap): Promise<number> =>
  executeFamilyRemoteBootstrap({
    bootstrap,
    phase: "agent",
    ssh: async (cmd) => box.run(cmd),
    log: () => {},
  })

/** One chunk's GRADER phase (which carries its own teardown). */
const runGraderPhase = (box: FakeBox, bootstrap: FamilyRemoteBootstrap): Promise<number> =>
  executeFamilyRemoteBootstrap({
    bootstrap,
    phase: "grader",
    ssh: async (cmd) => box.run(cmd),
    log: () => {},
  })

describe("A-A — the answer key does not survive a chunk boundary", () => {
  test("KNOWN-ITEM FLOOR — the plan declares a teardown AND an absence probe, and they are real", () => {
    const commands = promaxBootstrap().commands
    // Without this floor every claim below could pass on a plan that declares
    // neither (nothing to remove, nothing to probe, nothing to fail).
    const teardown = commands.filter((c) => c.phase === "teardown")
    expect(teardown.length).toBeGreaterThanOrEqual(1)
    // The teardown must actually remove the GOLD-BEARING root — not some
    // adjacent path that would leave the checkout in place.
    expect(teardown.map((c) => c.argv.join(" "))).toContain(`rm -rf ${GOLD_ROOT}`)
    const probes = commands.filter((c) => c.absenceProbe !== undefined)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.phase).toBe("agent")
    expect(probes[0]?.absenceProbe?.absolutePath).toBe(GOLD_ROOT)
    // …and the phase that MATERIALIZES gold is still non-empty, so the teardown
    // has something to undo.
    expect(commands.filter((c) => c.phase === "grader" && c.goldBearing).length).toBeGreaterThan(0)
  })

  test("ACCEPTANCE — chunk 1 grades, chunk 2's agent phase starts on a box with NO answer key", async () => {
    const box = new FakeBox()
    const bootstrap = lifecycleBootstrap()

    // ---- CHUNK 1 ----------------------------------------------------------
    await runAgentPhase(box, bootstrap)
    expect(box.exists(GOLD_ROOT)).toBe(false)
    await runGraderPhase(box, bootstrap)
    // NON-VACUOUS: the grader phase really did materialize the answer key on
    // this box (otherwise "it is gone afterwards" proves nothing).
    const created = box.commands.findIndex((c) => c.includes("'git' 'init'"))
    expect(created).toBeGreaterThanOrEqual(0)
    // …and the teardown really removed it.
    expect(box.exists(GOLD_ROOT)).toBe(false)
    expect(box.exists(`${GOLD_ROOT}/${PROMAX_V1_UPSTREAM_PATHS.dataset}`)).toBe(false)
    const removed = box.commands.indexOf(`'rm' '-rf' '${GOLD_ROOT}'`)
    expect(removed).toBeGreaterThan(created)

    // ---- CHUNK 2, same box ------------------------------------------------
    const before = box.commands.length
    const ran = await runAgentPhase(box, bootstrap)
    expect(ran).toBeGreaterThan(0)
    // The probe ran, and it PASSED because the tree is gone.
    // The probe is no longer the FIRST agent command — a readability check runs
    // ahead of it, because `test ! -e` answers CLEAN on EACCES. What matters is
    // that the re-probe happened in this phase at all.
    expect(
      box.commands.slice(before).some(isAbsenceProbe),
      "the agent phase did not re-probe",
    ).toBe(true)
    expect(box.exists(GOLD_ROOT)).toBe(false)
  })

  test("RED-ON-INJECTION — a teardown that FAILED is caught by chunk 2's probe, fail-closed", async () => {
    // The realistic regression is not "somebody deleted the teardown" — the
    // executor refuses that outright (below). It is a teardown that RAN and did
    // not take: a busy mount, a killed ssh, a box reused from a campaign that
    // died mid-grade. That is exactly why teardown and probe are TWO gates.
    const box = new FakeBox()
    const bootstrap = lifecycleBootstrap()
    await runAgentPhase(box, bootstrap)
    box.breakRemoval = true
    await expect(runGraderPhase(box, bootstrap)).rejects.toBeInstanceOf(FamilyBootstrapError)
    // The answer key is STILL THERE — the state the old code shipped silently.
    expect(box.exists(GOLD_ROOT)).toBe(true)

    box.breakRemoval = false
    const before = box.commands.length
    await expect(runAgentPhase(box, bootstrap)).rejects.toThrow(/ANSWER KEY PRESENT/)
    // It refused ON THE PROBE, and issued NOTHING afterwards: the agent phase
    // stops at the first command, it does not "probe and carry on".
    expect(box.commands.slice(before).filter(isAbsenceProbe)).toHaveLength(1)
    expect(box.commands.slice(before).some((c) => c.includes("'git'"))).toBe(false)
    // PAIRED CONTROL — remove the tree and the very same call succeeds, so the
    // refusal tracks the BOX's state and not some sticky flag.
    box.run(`'rm' '-rf' '${GOLD_ROOT}'`)
    await expect(runAgentPhase(box, bootstrap)).resolves.toBeGreaterThan(0)
  })

  test("the teardown runs even when the GRADER phase dies half-way", async () => {
    // A grader phase that failed is precisely when gold is left behind, so a
    // failure must be a reason to tear down, not a reason to skip it.
    const box = new FakeBox()
    const bootstrap = lifecycleBootstrap()
    let calls = 0
    await expect(
      executeFamilyRemoteBootstrap({
        bootstrap,
        phase: "grader",
        ssh: async (cmd) => {
          calls += 1
          // die AFTER `git init` has put the tree on the box
          return calls === 4 ? { code: 9, stdout: "", stderr: "boom" } : box.run(cmd)
        },
        log: () => {},
      }),
    ).rejects.toThrow(/boom|FAILED/)
    expect(box.exists(GOLD_ROOT)).toBe(false)
    expect(box.commands.at(-1)).toBe(`'rm' '-rf' '${GOLD_ROOT}'`)
  })

  test("RED-ON-INJECTION — a plan that materializes gold with NO teardown is refused before any ssh", async () => {
    // The literal pre-fix plan: a grader phase that creates the checkout and
    // declares nothing that removes it.
    const bootstrap = lifecycleBootstrap((commands) =>
      commands.filter((c) => c.phase !== "teardown"),
    )
    const box = new FakeBox()
    await expect(runGraderPhase(box, bootstrap)).rejects.toThrow(/NO phase="teardown"/)
    expect(box.commands).toEqual([])
    expect(box.exists(GOLD_ROOT)).toBe(false)
  })

  test("RED-ON-INJECTION — a plan that materializes gold with NO absence probe is refused before any ssh", async () => {
    const bootstrap = lifecycleBootstrap((commands) =>
      commands.filter((c) => c.absenceProbe === undefined),
    )
    const box = new FakeBox()
    await expect(runAgentPhase(box, bootstrap)).rejects.toThrow(/NO agent-phase absence probe/)
    expect(box.commands).toEqual([])
  })

  test("BYTE-IDENTICAL CONTROL — a family that never materializes gold gains neither clause", async () => {
    // The two lifecycle refusals must not tax families with nothing to hide.
    const plain: FamilyRemoteBootstrap = {
      family: "verified",
      graderWorkers: 1,
      planNotes: [],
      commands: [
        { step: "probe", phase: "agent", goldBearing: false, argv: ["true"], purpose: "control" },
        { step: "build", phase: "grader", goldBearing: false, argv: ["true"], purpose: "control" },
      ],
    }
    const box = new FakeBox()
    expect(await runAgentPhase(box, plain)).toBe(1)
    expect(await runGraderPhase(box, plain)).toBe(1)
    expect(box.commands).toEqual(["'true'", "'true'"])
  })
})

// ---------------------------------------------------------------------------
// A-A / acceptance — the SAME two chunks, driven through the two REAL box paths
// ---------------------------------------------------------------------------

interface BoxWire {
  readonly spawn: SpawnFn
  readonly box: FakeBox
  readonly spawns: Array<{ cmd: string; args: string[] }>
}

/**
 * A spawn that routes every `ssh` remote command into the simulated box and
 * records the raw argv of everything else (rsync / scp / aws). `bootstrapped`
 * decides whether `isBootstrapped`'s probe answers OK, which is what selects the
 * FRESH-PROVISION branch (`bootstrapBox`) or the WARM-REUSE branch.
 */
const boxWire = (box: FakeBox, bootstrapped: boolean): BoxWire => {
  const spawns: Array<{ cmd: string; args: string[] }> = []
  // A FRESH box is not ready when it is first probed; bootstrap then RUNS on it, and the
  // readiness check `29d7e4ff1` added after bootstrap (`assertBoxProfileReady`, "never a
  // false-ready") must see the result. This fake answered that probe from a flag fixed
  // at wire creation, so a freshly bootstrapped box stayed not-ready forever and chunk 1
  // threw `readiness probe failed` — red since that commit, for a fake that did not model
  // the new check, not for anything about gold absence.
  let probedOnce = false
  let ranAfterFirstProbe = false
  const spawn: SpawnFn = async (cmd, args) => {
    spawns.push({ cmd, args: [...args] })
    if (args.includes("run-instances")) {
      throw new Error("SPEND GUARD: a warm/attach path reached RunInstances")
    }
    if (args.includes("describe-instances")) return ok("1.2.3.4")
    if (cmd !== "ssh") return ok("")
    const remote = args[args.length - 1] ?? ""
    if (remote.includes("test -x ~/.bun/bin/bun")) {
      probedOnce = true
      return bootstrapped || ranAfterFirstProbe ? ok("OK\n") : ok("")
    }
    if (probedOnce) ranAfterFirstProbe = true
    return box.run(remote)
  }
  return { spawn, box, spawns }
}

const attachCfg = (over: Record<string, unknown>) => ({
  repoDir: join(SANDBOX, "fake-repo"),
  authJson: "{}",
  datasetPath: join(SANDBOX, "ds.jsonl"),
  // agentless-v1 does not require live LSP grounding ⇒ the clean reuse path.
  preset: "agentless-v1",
  sleep: async () => {},
  onLog: () => {},
  ...over,
})

describe("A-A/A-C acceptance — absence across two chunks, on BOTH box paths", () => {
  test("chunk 1 (FRESH-PROVISION bootstrap) then chunk 2 (WARM REUSE) on the SAME box", async () => {
    const box = new FakeBox()
    const bootstrap = lifecycleBootstrap()

    // ---- CHUNK 1: the stale box takes the FRESH-PROVISION sequence. This is
    //      `bootstrapBox` itself — the same callee `provisionBox` invokes — so
    //      the recorded order is the provisioning order.
    const first = boxWire(box, false)
    await attachBox(
      attachCfg({
        spawn: first.spawn,
        swebenchDatasetFamily: LIFECYCLE_FAMILY,
        remoteBootstrap: bootstrap,
      }),
      "i-chunk1",
    )
    // The absence probe was issued on the PROVISION path…
    expect(box.commands.some(isAbsenceProbe)).toBe(true)
    // …and it came BEFORE the campaign root was created, i.e. before the
    // bootstrap did anything on this family's behalf.
    const probeAt = box.commands.findIndex(isAbsenceProbe)
    // The campaign root is created with `sudo mkdir … && sudo chown …` (a plain
    // mkdir into root-owned /opt was MEASURED to fail on a real box), so the
    // needle is the root path in a creating command, not the old literal argv.
    const mkdirAt = box.commands.findIndex(
      (c) => c.includes("mkdir") && c.includes("/opt/quanta/promax"),
    )
    expect(mkdirAt).toBeGreaterThan(probeAt)
    // NON-VACUOUS: the provision sequence really did run (rsync + install).
    expect(first.spawns.some((s) => s.cmd === "rsync")).toBe(true)

    // ---- grading happens between the chunks, and puts gold on the box.
    await runGraderPhase(box, bootstrap)
    expect(box.exists(GOLD_ROOT)).toBe(false) // teardown took

    // ---- CHUNK 2: the box is now healthy ⇒ the WARM-REUSE gate.
    const before = box.commands.length
    const second = boxWire(box, true)
    await attachBox(
      attachCfg({
        spawn: second.spawn,
        swebenchDatasetFamily: LIFECYCLE_FAMILY,
        remoteBootstrap: bootstrap,
      }),
      "i-chunk2",
    )
    // The warm path re-proved absence too — it did not trust the prior chunk.
    expect(box.commands.slice(before).some(isAbsenceProbe)).toBe(true)
    // PAIRED CONTROL: this is a REUSE, not a re-provision — `bootstrapBox`'s
    // first act (`mkdir -p ~/quanta`) never happened in the second chunk.
    expect(box.commands.slice(before).some((c) => c.includes("mkdir -p ~/quanta"))).toBe(false)
  })

  test("RED-ON-INJECTION — gold left behind by chunk 1 stops chunk 2 on BOTH paths", async () => {
    for (const bootstrapped of [false, true]) {
      const box = new FakeBox()
      // A prior campaign died after `git init` and never tore down.
      box.entries.add(GOLD_ROOT)
      const wire = boxWire(box, bootstrapped)
      await expect(
        attachBox(
          attachCfg({
            spawn: wire.spawn,
            swebenchDatasetFamily: LIFECYCLE_FAMILY,
            remoteBootstrap: lifecycleBootstrap(),
          }),
          "i-dirty",
        ),
        `bootstrapped=${bootstrapped} did not refuse a gold-bearing box`,
      ).rejects.toThrow(/ANSWER KEY PRESENT/)
    }
  })
})

// ---------------------------------------------------------------------------
// A-B — the per-chunk scrub is EXHAUSTIVE, and it clears the dataset
// ---------------------------------------------------------------------------

describe("A-B — the warm-box scrub covers every path the chunk writes", () => {
  test("DRIFT GUARD — the policy classifies EXACTLY the ChunkPaths fields, both directions", () => {
    // `Record<keyof ChunkPaths, …>` proves one direction at compile time; this
    // proves the other at runtime, so a policy key for a path that no longer
    // exists cannot masquerade as coverage.
    expect(Object.keys(CHUNK_PATH_SCRUB_POLICY).sort()).toEqual(
      Object.keys(DEFAULT_CHUNK_PATHS).sort(),
    )
    // KNOWN-ITEM FLOOR: the real chunk writes at least these six.
    expect(Object.keys(DEFAULT_CHUNK_PATHS).length).toBeGreaterThanOrEqual(6)
    // The union has NO "leave it" member, so nothing can be classified as exempt.
    expect(new Set(Object.values(CHUNK_PATH_SCRUB_POLICY))).toEqual(
      new Set(["file", "file-when-recording", "dir-recreate"]),
    )
  })

  test("every classified path — the DATASET above all — appears in the emitted command", () => {
    // Unique sentinels, so a path can only be "present" by actually being there.
    const paths = {
      dataset: "~/S-dataset.jsonl",
      preds: "~/S-preds.jsonl",
      report: "~/S-report.json",
      runLog: "~/S-run.log",
      observeDir: "~/S-observe",
      trajectory: "$HOME/S-traj/cassette.jsonl",
      passRate: "~/S-pass-rate.json",
      boxGradePredictions: "~/S-preds.grader.json",
    } as const
    const cmd = buildChunkScrubCommand(paths, true)
    for (const key of Object.keys(CHUNK_PATH_SCRUB_POLICY) as Array<keyof typeof paths>) {
      expect(cmd, `scrub omits ${key}`).toContain(paths[key])
    }
    // A-B's headline: the dataset, whose omission was the leak.
    expect(cmd).toContain("~/S-dataset.jsonl")
    // Derived sidecars too (not ChunkPaths fields, equally stale on reuse).
    expect(cmd).toContain("~/S-run.exit")
    expect(cmd).toContain("~/S-report.closure-diagnostics.json")
    expect(cmd).toContain("$HOME/S-traj/trajectories")
    // …and the observe dir is RECREATED, not merely removed.
    expect(cmd).toContain("mkdir -p ~/S-observe")
    // PAIRED CONTROL — trajectory paths are absent when not recording, and the
    // dataset is scrubbed either way (it is not gated on an opt-in).
    const noRecord = buildChunkScrubCommand(paths, false)
    expect(noRecord).not.toContain("$HOME/S-traj")
    expect(noRecord).toContain("~/S-dataset.jsonl")
  })

  test("the REAL scrub issues that command (not a re-derivation of it)", async () => {
    const issued: string[] = []
    await scrubChunkArtifacts({
      ssh: async (cmd) => {
        issued.push(cmd)
        return ok()
      },
      paths: DEFAULT_CHUNK_PATHS,
      recordTrajectory: false,
    })
    expect(issued).toEqual([buildChunkScrubCommand(DEFAULT_CHUNK_PATHS, false)])
    expect(issued[0]).toContain(DEFAULT_CHUNK_PATHS.dataset)
  })

  test("DEFAULT PATH — gradeChunkOnBox scrubs the dataset and then UPLOADS it (order is load-bearing)", async () => {
    // The reason the omission survived: in the old order (upload, then scrub)
    // adding the dataset to the scrub list would have deleted the corpus the run
    // was about to grade. So the ordering claim IS the fix, and it is asserted
    // on the real production entry point with nothing hand-constructed.
    // ONE monotonic event log for BOTH transports. The scrub is an `ssh` and the
    // upload is an `scp` spawn, so two separate recorders cannot order them
    // against each other — and a rail that compares an ssh index to an ssh index
    // passes whichever way round the two actually run (measured: it did).
    const events: Array<{ kind: "ssh" | "spawn"; cmd: string; args: string[] }> = []
    const spawn: SpawnFn = async (cmd, args) => {
      events.push({ kind: "spawn", cmd, args: [...args] })
      return ok()
    }
    const session: BoxSession = {
      iid: "i-order",
      ip: "203.0.113.9",
      host: "ubuntu@203.0.113.9",
      keyPath: join(SANDBOX, "key.pem"),
      region: "ap-northeast-2",
      spawn,
      log: () => {},
      ssh: async (remote) => {
        events.push({ kind: "ssh", cmd: remote, args: [] })
        if (remote.includes("mkdir ~/.pool-grade.lock")) return ok("LOCKED")
        if (remote.includes("setsid bash -c")) return ok("LAUNCHED")
        if (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ")) {
          return ok("0\n==XQ-RUN-EXIT-XQ==\n")
        }
        if (remote.includes("cat ~/report.json")) return ok(JSON.stringify({ resolved_ids: [] }))
        return ok()
      },
      aws: async () => ok("running"),
      terminate: async () => {},
    }
    const params: GradeChunkParams = {
      datasetPath: join(SANDBOX, "instances.jsonl"),
      authJson: JSON.stringify({ access_token: "A", expires_at: "2099-01-01T00:00:00Z" }),
      preset: "agentless-v1",
      model: "gpt-5.4",
      concurrency: 1,
      artifactSuffix: "order",
      recordTrajectory: false,
      forwardedBenchEnv: "",
      datasetFamily: "verified",
    }
    // REDIRECT the bench home. `gradeChunkOnBox` persists artifacts through
    // `fullRemoteArtifactDir()`, so without this the test wrote
    // `report-order.json` into the OPERATOR's live bench home — proven by mtime.
    // `tests/setup.ts` fences `QUANTA_BENCH_RESULTS_DIR`; `QUANTA_BENCH_HOME`
    // has no such fence, and on macOS the home is under `~/Library/…`, not
    // `~/.quanta`, so checking only the latter misses it.
    // A FIXED name, not `mkdtempSync`. The SSOT mirror encodes the full source
    // path in its filename, so a randomized home turned "one temp dir per run"
    // into "one JSON per run in the shared results dir", which nothing removes.
    // A stable path overwrites in place.
    const benchHome = join(tmpdir(), "pmx-lifecycle-home")
    mkdirSync(benchHome, { recursive: true })
    TEMPS.push(benchHome)
    const priorHome = process.env.QUANTA_BENCH_HOME
    process.env.QUANTA_BENCH_HOME = benchHome
    __resetRuntimeConfig()
    try {
      await gradeChunkOnBox(session, params)
    } finally {
      // RESTORE, not delete: deleting clobbers a value the operator exported.
      if (priorHome === undefined) delete process.env.QUANTA_BENCH_HOME
      else process.env.QUANTA_BENCH_HOME = priorHome
      __resetRuntimeConfig()
    }

    const scrubAt = events.findIndex(
      (e) => e.kind === "ssh" && e.cmd.startsWith("rm -f ") && e.cmd.includes("mkdir -p ~/observe"),
    )
    expect(scrubAt).toBeGreaterThanOrEqual(0)
    // The scrub really does clear the dataset on the default path…
    expect(events[scrubAt]?.cmd).toContain(DEFAULT_CHUNK_PATHS.dataset)
    // …and THIS chunk's dataset is uploaded strictly AFTER it, so the corpus the
    // run grades is the one just placed, never one the scrub ate. Compared on the
    // SHARED event log, which is the only thing that can order an scp against an
    // ssh.
    const uploadAt = events.findIndex(
      (e) =>
        e.kind === "spawn" &&
        e.cmd === "scp" &&
        e.args.some((a) => a.endsWith(DEFAULT_CHUNK_PATHS.dataset)),
    )
    expect(uploadAt).toBeGreaterThanOrEqual(0)
    expect(uploadAt).toBeGreaterThan(scrubAt)
    // …and the bench launched after both.
    const launchAt = events.findIndex((e) => e.kind === "ssh" && e.cmd.includes("setsid bash -c"))
    expect(launchAt).toBeGreaterThan(uploadAt)
  })
})

// ---------------------------------------------------------------------------
// A-C — admission runs BEFORE any box mutation, on the fresh-provision path
// ---------------------------------------------------------------------------

/** Commands / spawns that MUTATE the box, as opposed to reading it. */
const MUTATIONS = ["mkdir", "bun install", "bun add", "cat > ", "chmod"] as const

describe("A-C — a refusing family refuses before the box is touched", () => {
  test("FRESH-PROVISION — bootstrapBox refuses before mkdir, rsync, scp and bun install", async () => {
    const box = new FakeBox()
    // bootstrapped=false ⇒ the stale-box branch takes `bootstrapBox`, the very
    // function `provisionBox` runs (its only bootstrap step is one call to it).
    const wire = boxWire(box, false)
    await expect(
      attachBox(
        attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: REFUSING_FAMILY }),
        "i-refused",
      ),
    ).rejects.toThrow(REFUSAL)
    // THE claim, on the recorded SEQUENCE: not one mutation was issued.
    for (const mutation of MUTATIONS) {
      expect(
        box.commands.filter((c) => c.includes(mutation)),
        `refused lane still issued "${mutation}"`,
      ).toEqual([])
    }
    expect(wire.spawns.filter((s) => s.cmd === "rsync")).toEqual([])
    expect(wire.spawns.filter((s) => s.cmd === "scp")).toEqual([])
  })

  test("PAIRED CONTROL — an ADMITTED family on the same path DOES reach all of them", async () => {
    // Without this, "no mutations" would also pass on a path that never runs.
    const box = new FakeBox()
    const wire = boxWire(box, false)
    await attachBox(
      attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: "verified" as DatasetFamily }),
      "i-admitted",
    )
    expect(box.commands.some((c) => c.includes("mkdir -p ~/quanta"))).toBe(true)
    expect(box.commands.some((c) => c.includes("bun install"))).toBe(true)
    expect(wire.spawns.some((s) => s.cmd === "rsync")).toBe(true)
    expect(wire.spawns.some((s) => s.cmd === "scp")).toBe(true)
  })

  test("WARM REUSE — the same refusal fires there too, with no mutation", async () => {
    const box = new FakeBox()
    const wire = boxWire(box, true)
    await expect(
      attachBox(
        attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: REFUSING_FAMILY }),
        "i-refused-warm",
      ),
    ).rejects.toThrow(REFUSAL)
    for (const mutation of MUTATIONS) {
      expect(box.commands.filter((c) => c.includes(mutation))).toEqual([])
    }
  })

  test("an ADMITTED family whose warm-box bootstrap state is UNKNOWN is still refused", async () => {
    // The unknown-state clause used to be covered only through ProMax, whose
    // ADMISSION now refuses first — which would have left the clause passing on
    // the wrong refusal. Drive it on a family that ADMITS and declares a
    // bootstrap, so the only thing that can refuse here is the clause itself.
    const box = new FakeBox()
    const wire = boxWire(box, true)
    await expect(
      attachBox(
        // remoteBootstrap deliberately ABSENT: the attach path carried none.
        attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: LIFECYCLE_FAMILY }),
        "i-unknown",
      ),
    ).rejects.toThrow(/bootstrap state is unknown/i)
    // PAIRED CONTROL — carry the bootstrap and the very same attach succeeds.
    const okBox = new FakeBox()
    const okWire = boxWire(okBox, true)
    await attachBox(
      attachCfg({
        spawn: okWire.spawn,
        swebenchDatasetFamily: LIFECYCLE_FAMILY,
        remoteBootstrap: lifecycleBootstrap(),
      }),
      "i-known",
    )
    expect(okBox.commands.some(isAbsenceProbe)).toBe(true)
  })

  test("ADMISSION CANNOT MUTATE — the gate refuses having issued nothing at all", () => {
    // `assertFamilyAdmitsBox` takes no ssh, so this is structural rather than
    // observational — but drive it anyway, since a port that is never called is
    // the failure mode this whole round exists to kill.
    //
    // The subject is the SYNTHETIC refuser, not ProMax: PMX-04 wired ProMax's
    // grader phase and its teardown, so ProMax now admits. A clause about how a
    // REFUSAL behaves has to be driven by something that actually refuses, or it
    // silently becomes a test of nothing.
    expect(() => assertFamilyAdmitsBox({ family: REFUSING_FAMILY, log: () => {} })).toThrow(
      new RegExp(REFUSAL),
    )
    // PAIRED CONTROL: an admitting family passes the same gate.
    expect(() => assertFamilyAdmitsBox({ family: "promax", log: () => {} })).not.toThrow()
  })

  test("DRIFT GUARD — admission and setupBox agree for EVERY registered family", async () => {
    // The two gates answer the same question at different times. A family that
    // refuses in one and admits in the other would reintroduce the defect: the
    // late gate would fire against an already-mutated box.
    let refusers = 0
    for (const family of [...DATASET_FAMILIES, LIFECYCLE_FAMILY, REFUSING_FAMILY]) {
      const profile = resolveDatasetFamilyProfile(family)
      let admitRefused = false
      try {
        profile.admitBox({ log: () => {} })
      } catch {
        admitRefused = true
      }
      let setupRefused = false
      try {
        await profile.setupBox({ ssh: async () => ok(), log: () => {} })
      } catch {
        setupRefused = true
      }
      expect(admitRefused, `${family}: admitBox and setupBox disagree`).toBe(setupRefused)
      if (admitRefused) refusers += 1
    }
    // KNOWN-ITEM FLOOR — the synthetic refuser really refuses, so the agreement
    // above is not agreement between a set of no-ops. It used to be ProMax AND
    // the synthetic; ProMax now admits (PMX-04 wired its grader phase and the
    // teardown bound to it), so the floor is one.
    expect(refusers).toBeGreaterThanOrEqual(1)
  })
})
